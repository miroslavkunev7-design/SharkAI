import { z } from 'zod';
import { resolveWalletStatus, wiseWalletConnection, type WalletOwnerRequest } from './wallet-status.server';
import { amountMinor, verifiedProfile, wiseReader, type WiseTransport } from './wise-wallet.server';

const week = 7 * 86_400_000;
const currency = z.string().regex(/^[A-Z]{3}$/);
const amount = z.object({ value: z.number().finite(), currency });
const timestamp = z.string().datetime({ offset: true });
const providerTime = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z?$/);
const statement = z.object({
  query: z.object({ accountId: z.number().int().positive().safe(), intervalStart: timestamp, intervalEnd: timestamp, currency }),
  endOfStatementBalance: amount,
  transactions: z.array(z.object({
    type: z.enum(['DEBIT', 'CREDIT']), date: timestamp, amount,
    details: z.object({ type: z.string().min(1) }), referenceNumber: z.string().min(1).max(128),
  })).max(5000),
});
const kyc = z.object({
  id: z.string().uuid(),
  status: z.enum(['NEW','PASSED','PASSED_WITH_REQUIREMENTS','WAITING_CUSTOMER_INPUT','PROCESSING','EXPIRED']),
  link: z.object({value: z.string().url().max(4096), expiresAt: providerTime}).nullish(),
});
type Deposit = { amount_minor: string; occurred_at: string };
export type WalletDepositSummary = {
  provider: 'wise'; currency: string; source: 'wise_balance_statement'; from: string; to: string;
  observed_at: string; count: number; latest: Deposit | null;
};

export function projectWiseDeposits(raw: unknown, accountId: string, code: string, decimals: number, from: Date, to: Date): WalletDepositSummary | null {
  const parsed = statement.safeParse(raw);
  if (!parsed.success) return null;
  const {query, transactions, endOfStatementBalance} = parsed.data;
  if (String(query.accountId) !== accountId || query.currency !== code || endOfStatementBalance.currency !== code
      || Date.parse(query.intervalStart) !== from.valueOf() || Date.parse(query.intervalEnd) !== to.valueOf()) return null;
  let latest: Deposit | null = null;
  let count = 0;
  const references = new Set<string>();
  for (const row of transactions) {
    const at = Date.parse(row.date);
    if (at < from.valueOf() || at > to.valueOf() || row.amount.currency !== code || references.has(row.referenceNumber)) return null;
    references.add(row.referenceNumber);
    if (row.type !== 'CREDIT' || !['DEPOSIT','MONEY_ADDED'].includes(row.details.type)) continue;
    const minor = amountMinor(row.amount.value, decimals);
    if (!minor || minor === '0') return null;
    count++;
    if (!latest || at > Date.parse(latest.occurred_at)) latest = { amount_minor: minor, occurred_at: new Date(at).toISOString() };
  }
  return { provider:'wise',currency:code,source:'wise_balance_statement',from:from.toISOString(),to:to.toISOString(),
    observed_at:to.toISOString(),count,latest };
}

export async function readWalletDeposits(owner: WalletOwnerRequest, now?: Date, env = process.env, transport?: WiseTransport) {
  const connection = wiseWalletConnection(owner,now,env,transport);
  if (connection.status !== 'connected' || !connection.binding.statement_approval_ref) return null;
  const { binding } = connection;
  if (!binding.balance_id) return null;
  const read = wiseReader(connection.token,connection.transport);
  try {
    if (!await verifiedProfile(binding,read)) return null;
    const to = new Date((now ?? new Date()).valueOf());
    to.setUTCMilliseconds(0);
    const from = new Date(to.valueOf()-week);
    const query = new URLSearchParams({currency:binding.currency,intervalStart:from.toISOString(),intervalEnd:to.toISOString(),type:'COMPACT',statementLocale:'en'});
    const raw = await read(`/profiles/${binding.profile_id}/balance-statements/${binding.balance_id}/statement.json?${query}`);
    const finished = now ?? new Date();
    const result = projectWiseDeposits(raw,binding.balance_id,binding.currency,connection.decimals,from,to);
    return finished.valueOf()<connection.expiresAt && result ? { ...result, observed_at:finished.toISOString() } : null;
  } catch { return null; }
}

export async function walletKyc(owner: WalletOwnerRequest, start: boolean, now?: Date, env = process.env, transport?: WiseTransport) {
  const connection = wiseWalletConnection(owner,now,env,transport);
  if (connection.status !== 'connected' || !connection.binding.hosted_review) return null;
  const { binding } = connection;
  const reviewId = binding.hosted_review!.id;
  const read = wiseReader(connection.token,connection.transport);
  const path = `/profiles/${binding.profile_id}/kyc-reviews/${reviewId}`;
  try {
    if (!await verifiedProfile(binding,read)) return null;
    const current = kyc.safeParse(await read(path));
    if (!current.success || current.data.id !== reviewId || (now ?? new Date()).valueOf() >= connection.expiresAt) return null;
    if (!start || current.data.status !== 'WAITING_CUSTOMER_INPUT') return { status:current.data.status, url:null };
    const callback = new URL(env.NEXT_PUBLIC_APP_URL ?? '');
    if (callback.protocol !== 'https:' || callback.username || callback.password) return null;
    const result = kyc.safeParse(await read(path,{redirectUrl:callback.origin+'/dashboard?view=investments'}));
    const link = result.success ? result.data.link : null;
    if (!result.success || result.data.id !== reviewId || result.data.status !== 'WAITING_CUSTOMER_INPUT' || !link) return null;
    const url = new URL(link.value);
    const end = Date.parse(link.expiresAt.endsWith('Z') ? link.expiresAt : link.expiresAt+'Z');
    const currentTime = (now ?? new Date()).valueOf();
    if (url.origin !== 'https://wise.com' || url.username || url.password || url.pathname !== '/embedded-flows/verification' ||
        !url.searchParams.get('token') || !Number.isFinite(end) || end<=currentTime || end-currentTime>300_000 ||
        currentTime>=connection.expiresAt) return null;
    return { status:result.data.status, url:url.href };
  } catch { return null; }
}

export const walletReadOperations = ['onboarding','balance','deposit','withdrawal'] as const;
export type WalletReadOperation = typeof walletReadOperations[number];
export function isWalletRead(value: string): value is WalletReadOperation {
  return walletReadOperations.some(operation=>operation===value);
}
export async function readWalletOperation(operation: WalletReadOperation, owner: WalletOwnerRequest) {
  const packet = (status: 'ok'|'unavailable'|'needs_human',code:string,data:object|null) => ({
    operation,status,code,data,source:'shark-ai-wallet',timestamp:new Date().toISOString(),
  });
  if (operation==='deposit') {
    const result = await readWalletDeposits(owner);
    return result ? packet('ok','VERIFIED_POSTED_DEPOSITS',result) : packet('unavailable','VERIFIED_STATEMENT_REQUIRED',null);
  }
  if (operation==='onboarding') {
    const result=await walletKyc(owner,false);
    if (result) return packet('ok','VERIFIED_PROVIDER_REVIEW',{ provider:'wise',review_status:result.status,source:'wise_kyc_review' });
  }
  const wallet=await resolveWalletStatus(owner);
  if (wallet.status!=='verified') return packet('unavailable','VERIFIED_WALLET_REQUIRED',null);
  if (operation==='withdrawal') return packet('needs_human','OWNER_CONFIRMS_AT_WISE',{provider:'wise',provider_home:'https://wise.com/home/'});
  return operation==='onboarding' ? packet('ok','ACCOUNT_LINKED',{provider:'wise',review_status:null,source:wallet.source})
    : packet('ok','VERIFIED_WALLET_BALANCE',wallet);
}
