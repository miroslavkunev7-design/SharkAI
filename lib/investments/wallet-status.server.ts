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

function selectWalletEnrollment(userId:string, currency:string|null, env:NodeJS.ProcessEnv) {
  const raw=env.WISE_WALLET_ENROLLMENTS;
  if (!raw) {
    if (!env.WISE_WALLET_OWNER_BINDING) return empty('provider_unlinked');
    const binding=bindingFromConfig(env.WISE_WALLET_OWNER_BINDING);
    return binding ? { status:'enrolled' as const,binding,token:env.WISE_WALLET_OAUTH_ACCESS_TOKEN } : empty('provider_unconfigured');
  }
  if (raw.length>256*1024 || env.WISE_WALLET_OWNER_BINDING) return empty('provider_unconfigured');
  try {
    const rows=approvedEnrollments.parse(JSON.parse(raw));
    const ownersByProvider=new Map<string,string>();
    const ownerCurrencies=new Set<string>();
    for (const {binding} of rows) {
      const pair=JSON.stringify([binding.owner_id,binding.currency]);
      if (ownerCurrencies.has(pair)) return empty('provider_unconfigured');
      ownerCurrencies.add(pair);
      for (const id of ['user:'+binding.provider_user_id,'profile:'+binding.profile_id,...(binding.balance_id?['balance:'+binding.balance_id]:[])]) {
        if (ownersByProvider.has(id) && ownersByProvider.get(id)!==binding.owner_id) return empty('provider_unconfigured');
        ownersByProvider.set(id,binding.owner_id);
      }
    }
    const match=rows.find(({binding})=>binding.owner_id===userId && binding.currency===currency);
    return match ? {status:'enrolled' as const,binding:match.binding,token:env[match.token_secret_name]} : empty('provider_unlinked');
  } catch { return empty('provider_unconfigured'); }
}

export function wiseWalletConnection(
  { userId, currency }: WalletOwnerRequest,
  now?: Date,
  env: NodeJS.ProcessEnv = process.env,
  transport?: WiseTransport,
) {
  // OpenPayd requires a separately approved end-user account and credential model.
  if (env.WALLET_PROVIDER !== 'wise') return empty('provider_unconfigured');
  const enrollment = selectWalletEnrollment(userId,currency,env);
  if (enrollment.status!=='enrolled') return enrollment;
  const { binding,token } = enrollment;
  if (binding.owner_id !== userId || binding.currency !== currency) return empty('provider_unlinked');
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

export function walletOwnerCapabilities(owner: WalletOwnerRequest) {
  const c = wiseWalletConnection(owner);
  return c.status === 'connected'
    ? { deposit_statements:Boolean(c.binding.balance_id && c.binding.statement_approval_ref), hosted_kyc:Boolean(c.binding.hosted_review) }
    : { deposit_statements:false, hosted_kyc:false };
}
