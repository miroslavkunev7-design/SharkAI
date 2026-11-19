import { createHash, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { getAccountSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getWalletSettings, walletDashboard, walletJson } from '@/lib/wallet-investments-server';
import { readOwnerPerformanceFee } from '@/lib/investments/performance-fee.server';

export const FINANCE_STATUS_SCOPE = 'finance:status:read';
const AUDIENCE = 'sharkai:n8n:wallet-status';
const ISSUER = 'sharkai';
const EXPIRATION_SECONDS = 120;
const validSecret = /^[A-Za-z0-9_-]{32,256}$/;

function grantConfig() {
  const service = process.env.SHARKAI_WALLET_STATUS_SERVICE_SECRET;
  const signing = process.env.SHARKAI_WALLET_STATUS_GRANT_SECRET;
  if (!service || !signing || service === signing || !validSecret.test(service) || !validSecret.test(signing)) return null;
  return { service, signing: new TextEncoder().encode(signing) };
}

function digest(text: string) {
  return createHash('sha256').update(text).digest();
}

export function financeServiceAuthorized(request: Request, secret=process.env.SHARKAI_WALLET_STATUS_SERVICE_SECRET) {
  const authorization=request.headers.get('authorization');
  return !!secret && validSecret.test(secret) && !!authorization && authorization.length<=270
    && timingSafeEqual(digest(authorization),digest('Bearer '+secret));
}

export async function signWalletStatusGrant(userId: string, revision: number, telegramBindingId?: string) {
  const config = grantConfig();
  if (!config) return null;
  return new SignJWT({ scope: FINANCE_STATUS_SCOPE, revision, ...(telegramBindingId && { telegram_binding: telegramBindingId }) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(EXPIRATION_SECONDS + 's')
    .sign(config.signing);
}

export async function issueWalletStatusGrant(userId: string) {
  const profile = await getWalletSettings(userId);
  if (profile?.aiAccess !== 'ANALYSIS_ONLY') return walletJson({ status: 'forbidden' }, 403);
  const grant = await signWalletStatusGrant(userId, profile.accessRevision);
  if (!grant) return walletJson({ status: 'unavailable' }, 503);
  return walletJson({ grant, expires_in: EXPIRATION_SECONDS });
}

export async function readWalletStatusGrant(request: Request) {
  return readAuthorizedFinanceStatus(request, async (profile, account) => {
    const [dashboard,performance_fee]=await Promise.all([walletDashboard(profile,account),readOwnerPerformanceFee(account.id)]);
    return {...dashboard,performance_fee,status:'ok',source:'shark-ai-backend',observed_at:new Date().toISOString()};
  });
}

export async function readAuthorizedFinanceStatus(
  request: Request,
  projection: (
    profile: NonNullable<Awaited<ReturnType<typeof getWalletSettings>>>,
    account: NonNullable<Awaited<ReturnType<typeof getAccountSession>>>,
  ) => Promise<object>,
) {
  const config = grantConfig();
  if (!config) return walletJson({ status: 'unavailable' }, 503);
  if (!financeServiceAuthorized(request,config.service)) {
    return walletJson({ status: 'forbidden' }, 403);
  }

  const grant = request.headers.get('x-shark-finance-grant');
  if (!grant || grant.length > 2048) return walletJson({ status: 'forbidden' }, 403);
  const raw = await readEmptyFinanceRequest(request);
  if (raw === null || !['', '{}'].includes(raw.replace(/\s/g, ''))) {
    return walletJson({ status: 'invalid_request' }, 400);
  }
  const jwt = await jwtVerify(grant, config.signing, {
    algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE,
    requiredClaims: ['exp', 'iat', 'sub'], maxTokenAge: EXPIRATION_SECONDS,
  }).catch(() => null);
  const claim = jwt?.payload;
  if (!claim?.sub || claim.scope !== FINANCE_STATUS_SCOPE || !Number.isSafeInteger(claim.revision)) {
    return walletJson({ status: 'forbidden' }, 403);
  }
  const bindingValid = async () => {
    if (claim.telegram_binding === undefined) return true;
    if (typeof claim.telegram_binding !== 'string' || !claim.telegram_binding || claim.telegram_binding.length > 128) return false;
    return !!await prisma.telegramBinding.findFirst({
      where: {id:claim.telegram_binding,userId:claim.sub,user:{role:'ADMIN'}}, select:{id:true},
    });
  };
  try {
    const [profile, account] = await Promise.all([getWalletSettings(claim.sub), getAccountSession(claim.sub)]);
    if (!account || profile?.aiAccess !== 'ANALYSIS_ONLY' || profile.accessRevision !== claim.revision || !(await bindingValid())) {
      return walletJson({ status: 'forbidden' }, 403);
    }
    const result = await projection(profile, account);
    const current = await getWalletSettings(claim.sub);
    if (current?.aiAccess !== 'ANALYSIS_ONLY' || current.accessRevision !== claim.revision || !(await bindingValid())) {
      return walletJson({ status: 'forbidden' }, 403);
    }
    return walletJson(result);
  } catch {
    return walletJson({ status: 'unavailable' }, 503);
  }
}

async function readEmptyFinanceRequest(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  let expired = false;
  const timeout = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, 1_000);
  let length = 0;
  let raw = '';
  const decoder = new TextDecoder('utf8', { fatal: true });
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) return expired ? null : raw + decoder.decode();
      length += item.value.byteLength;
      if (length > 64) {
        await reader.cancel();
        return null;
      }
      raw += decoder.decode(item.value,{stream:true});
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}
