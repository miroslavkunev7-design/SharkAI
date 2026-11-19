import { randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { z } from 'zod';

const WISE_ORIGIN = 'https://api-mtls.transferwise.com';
const VERSION = '/2026Q4';
const MAX_RESPONSE_BYTES = 256 * 1024;
const readBudgetMs = 5_000;
const positiveSafeInteger = z.number().int().positive().safe();

export const wiseNumericId = z.string().regex(/^[1-9][0-9]{0,15}$/)
  .refine((value) => Number.isSafeInteger(Number(value)));

export type WiseWalletBinding = {
  provider_user_id: string;
  profile_id: string;
  balance_id: string;
  currency: string;
};

export type WiseTransport = (
  url: URL,
  options: { headers: Record<string, string>; signal: AbortSignal; method?: 'PATCH'; body?: string },
) => Promise<unknown>;

type TlsCredentials = { ca: string; cert: string; key: string };

export function wiseMtlsTransport(tls: TlsCredentials): WiseTransport {
  return (url, { headers, signal, method, body }) => new Promise((resolve, reject) => {
    if (url.origin !== WISE_ORIGIN || (method && (method !== 'PATCH' ||
        !/^\/2026Q4\/profiles\/[1-9]\d*\/kyc-reviews\/[\da-f-]{36}$/.test(url.pathname)))) {
      reject(new Error('WISE_ORIGIN_MISMATCH'));
      return;
    }
    const outgoing = request(url, {
      ...tls,
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      agent: false,
      method: method ?? 'GET',
      headers,
      signal,
    }, (incoming) => {
      incoming.on('error', reject);
      incoming.on('close', () => {
        if (!incoming.complete) reject(new Error('WISE_RESPONSE_INTERRUPTED'));
      });
      if (incoming.statusCode !== 200 ||
          !/^application\/json(?:;|$)/i.test(incoming.headers['content-type'] ?? '')) {
        incoming.destroy();
        reject(new Error('WISE_READ_UNAVAILABLE'));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      incoming.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          incoming.destroy(new Error('WISE_RESPONSE_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      incoming.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

const identity = z.object({ id: positiveSafeInteger, active: z.literal(true) });
const profile = z.object({ id: positiveSafeInteger, userId: positiveSafeInteger, currentState: z.literal('VISIBLE') });
const balance = z.object({
  id: positiveSafeInteger,
  type: z.literal('STANDARD'),
  investmentState: z.literal('NOT_INVESTED'),
  visible: z.literal(true),
  currency: z.string(),
  amount: z.object({ value: z.number().finite().nonnegative(), currency: z.string() }),
});

export function amountMinor(value: number, decimals: number) {
  // Leave a precision margin before the floating-point spacing reaches a minor unit.
  if (value > Number.MAX_SAFE_INTEGER / 10 ** (decimals + 1)) return null;
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(String(value));
  if (!match || (match[2]?.length ?? 0) > decimals) return null;
  return BigInt(match[1] + (match[2] ?? '').padEnd(decimals, '0')).toString();
}

export async function readWiseAvailableBalance(
  binding: WiseWalletBinding,
  decimals: number,
  token: string,
  transport: WiseTransport,
): Promise<string | null> {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4) return null;
  for (const id of [binding.provider_user_id, binding.profile_id, binding.balance_id]) {
    if (!wiseNumericId.safeParse(id).success) return null;
  }
  const read = wiseReader(token, transport);
  try {
    if (!await verifiedProfile(binding, read)) return null;
    const result = balance.safeParse(await read(`/profiles/${binding.profile_id}/balances/${binding.balance_id}`));
    if (!result.success || String(result.data.id) !== binding.balance_id
        || result.data.currency !== binding.currency || result.data.amount.currency !== binding.currency) return null;
    return amountMinor(result.data.amount.value, decimals);
  } catch {
    return null;
  }
}

export function wiseReader(token: string, transport: WiseTransport) {
  const signal = AbortSignal.timeout(readBudgetMs);
  return (path: string, redirect?: { redirectUrl: string }) => transport(new URL(VERSION + path, WISE_ORIGIN), {
    signal,
    headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/json', 'X-External-Correlation-Id': randomUUID(),
      ...(redirect && { 'Content-Type': 'application/json' }),
    },
    ...(redirect && { method: 'PATCH' as const, body: JSON.stringify(redirect) }),
  });
}

export async function verifiedProfile(binding: Pick<WiseWalletBinding,'provider_user_id'|'profile_id'>, read: ReturnType<typeof wiseReader>) {
  const subject = identity.safeParse(await read('/me'));
  if (!subject.success || String(subject.data.id) !== binding.provider_user_id) return false;
  const result = profile.safeParse(await read(`/profiles/${binding.profile_id}`));
  return result.success && String(result.data.id) === binding.profile_id && String(result.data.userId) === binding.provider_user_id;
}
