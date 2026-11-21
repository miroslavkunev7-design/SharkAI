import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { currencyMinorDigits } from '../wallet-investments-contract';
import { readWiseAvailableBalance, wiseMtlsTransport, wiseNumericId, type WiseTransport } from './wise-wallet.server';

type WalletEmptyStatus = 'provider_unconfigured' | 'provider_unlinked' | 'unavailable' | 'stale';
export type WalletProviderStatus =
  | {
      status: WalletEmptyStatus;
      provider: 'wise' | null;
      balance_minor: null;
      currency: null;
      observed_at: null;
      source: null;
    }
  | {
      status: 'verified';
      provider: 'wise';
      balance_minor: string;
      currency: string;
      observed_at: string;
      source: 'wise_balance_api';
    };

const ownerBinding = z.object({
  owner_id: z.string().min(1).max(128),
  provider_user_id: wiseNumericId,
  profile_id: wiseNumericId,
  balance_id: wiseNumericId.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  provider_read_approval_ref: z.string().trim().min(1).max(200),
  statement_approval_ref: z.string().trim().min(1).max(200).optional(),
  hosted_review: z.object({ id: z.string().uuid(), approval_ref: z.string().trim().min(1).max(200) }).strict().optional(),
  token_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  token_expires_at: z.string().datetime(),
}).strict();

function empty(status: WalletEmptyStatus): WalletProviderStatus {
  return {
    status,
    provider: status === 'provider_unconfigured' ? null : 'wise',
    balance_minor: null,
    currency: null,
    observed_at: null,
    source: null,
  };
}

function bindingFromConfig(raw: string | undefined) {
  if (!raw || raw.length > 4_096) return null;
  try {
    const result = ownerBinding.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export type WalletOwnerRequest = { userId: string; currency: string | null };

const approvedEnrollments=z.array(z.object({
  binding:ownerBinding, token_secret_name:z.string().regex(/^WISE_WALLET_USER_TOKEN_[A-Z0-9_]{1,60}$/),
}).strict()).max(256);

function ownerEnrollments(userId:string, env:NodeJS.ProcessEnv) {
  if (env.WALLET_PROVIDER !== 'wise') return null;
  const raw=env.WISE_WALLET_ENROLLMENTS;
  if (!raw) {
    if (!env.WISE_WALLET_OWNER_BINDING) return [];
    const binding=bindingFromConfig(env.WISE_WALLET_OWNER_BINDING);
    if (!binding) return null;
    return binding.owner_id===userId ? [{binding,token:env.WISE_WALLET_OAUTH_ACCESS_TOKEN}] : [];
  }
  if (raw.length>256*1024 || env.WISE_WALLET_OWNER_BINDING) return null;
  try {
    const rows=approvedEnrollments.parse(JSON.parse(raw));
    const ownersByProvider=new Map<string,string>();
    const ownerCurrencies=new Set<string>();
    for (const {binding} of rows) {
      const pair=JSON.stringify([binding.owner_id,binding.currency]);
      if (ownerCurrencies.has(pair)) return null;
      ownerCurrencies.add(pair);
      for (const id of ['user:'+binding.provider_user_id,'profile:'+binding.profile_id,...(binding.balance_id?['balance:'+binding.balance_id]:[])]) {
        if (ownersByProvider.has(id) && ownersByProvider.get(id)!==binding.owner_id) return null;
        ownersByProvider.set(id,binding.owner_id);
      }
    }
    return rows.filter(({binding})=>binding.owner_id===userId)
      .map(({binding,token_secret_name})=>({binding,token:env[token_secret_name]}));
  } catch { return null; }
}

export function enrolledWalletCurrencies(userId:string, env:NodeJS.ProcessEnv=process.env) {
  return (ownerEnrollments(userId,env)??[]).map(({binding})=>binding.currency).sort();
}

export function wiseWalletConnection(
  { userId, currency }: WalletOwnerRequest,
  now?: Date,
  env: NodeJS.ProcessEnv = process.env,
  transport?: WiseTransport,
) {
  // OpenPayd requires a separately approved end-user account and credential model.
  if (env.WALLET_PROVIDER !== 'wise') return empty('provider_unconfigured');
  const rows = ownerEnrollments(userId,env);
  if (!rows) return empty('provider_unconfigured');
  const enrollment = currency===null && rows.length===1 ? rows[0] : rows.find(({binding})=>binding.currency===currency);
  if (!enrollment) return empty('provider_unlinked');
  const { binding,token } = enrollment;
  const ca = env.WISE_WALLET_SERVER_CA_PEM;
  const cert = env.WISE_WALLET_CLIENT_CERT_PEM;
  const key = env.WISE_WALLET_CLIENT_KEY_PEM;
  if (!token || !/^[A-Za-z0-9._~+/\-]+=*$/.test(token) || token.length > 4_096 || !ca || !cert || !key) {
    return empty('provider_unconfigured');
  }
  const digest = createHash('sha256').update(token).digest();
  if (!timingSafeEqual(digest, Buffer.from(binding.token_sha256, 'hex'))) return empty('provider_unconfigured');
  const started = now ?? new Date();
  const expiresAt = Date.parse(binding.token_expires_at);
  const remaining = expiresAt - started.valueOf();
  // Wise user access tokens last 12 hours. Approval applies to this issued token only.
  if (!Number.isFinite(remaining) || remaining <= 0) return empty('stale');
  if (remaining > 12 * 60 * 60 * 1_000) return empty('provider_unconfigured');

  const decimals = currencyMinorDigits(binding.currency);
  if (decimals === null) return empty('provider_unconfigured');
  return { status: 'connected' as const, binding, decimals, expiresAt, token, transport: transport ?? wiseMtlsTransport({ ca, cert, key }) };
}

export async function resolveWalletStatus(
  owner: WalletOwnerRequest, now?: Date, env: NodeJS.ProcessEnv = process.env, transport?: WiseTransport,
): Promise<WalletProviderStatus> {
  const conn = wiseWalletConnection(owner, now, env, transport);
  if (conn.status !== 'connected') return conn;
  const { binding, decimals, expiresAt, token } = conn;
  if (!binding.balance_id) return empty('provider_unlinked');
  const balance = await readWiseAvailableBalance({...binding,balance_id:binding.balance_id}, decimals, token, conn.transport);
  if (balance === null) return empty('unavailable');
  const observed = now ?? new Date();
  if (observed.valueOf() >= expiresAt) return empty('stale');
  return {
    status: 'verified',
    provider: 'wise',
    balance_minor: balance,
    currency: binding.currency,
    observed_at: observed.toISOString(),
    source: 'wise_balance_api',
  };
}

export function walletOwnerCapabilities(owner: WalletOwnerRequest, now?:Date, env:NodeJS.ProcessEnv=process.env) {
  const c = wiseWalletConnection(owner,now,env);
  const currencies=enrolledWalletCurrencies(owner.userId,env);
  const selected=owner.currency===null && currencies.length===1 ? currencies[0] :
    currencies.find(code=>code===owner.currency)??null;
  return {
    currencies, selected_currency:selected,
    deposit_statements:c.status==='connected' && Boolean(c.binding.balance_id && c.binding.statement_approval_ref),
    hosted_kyc:c.status==='connected' && Boolean(c.binding.hosted_review),
  };
}
