import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db';

const units = z.string().regex(/^(0|[1-9]\d{0,18})$/);
const instrument = z.string().min(1).max(128).refine(value => !/\p{Cc}/u.test(value));
const instant = z.string().datetime();
const activity = z.object({
  status: z.enum(['provider_unconfigured', 'provider_unlinked', 'available', 'unavailable']),
  accounts: z.array(z.object({
    provider: z.enum(['ibkr', 'saxo']),
    currency: z.string().regex(/^[A-Z]{3}$/),
    halted_at: instant.nullable(),
    reconciliation: z.enum(['verified', 'pending', 'stale', 'unavailable']),
    snapshot_at: instant.nullable(),
    positions: z.array(z.object({ instrument, units }).strict()).max(20).nullable(),
    recent_orders: z.array(z.object({
      instrument,
      side: z.enum(['BUY', 'SELL']),
      status: z.enum([
        'RESERVED', 'SUBMITTING', 'ACKNOWLEDGED', 'PENDING', 'WORKING', 'PARTIALLY_FILLED',
        'CANCEL_PENDING', 'REVIEW_REQUIRED', 'FILLED', 'CANCELED', 'REJECTED', 'UNKNOWN', 'VOIDED',
      ]),
      units,
      filled_units: units,
      recorded_at: instant,
      provider_observed_at: instant.nullable(),
      reconciliation_required: z.boolean(),
    }).strict()).max(10),
  }).strict()).max(5),
}).strict().refine(({ status, accounts }) => (status === 'available') === (accounts.length > 0));

export type BrokerOwnerActivity = z.infer<typeof activity>;
type BrokerQuery = Pick<Prisma.TransactionClient, '$queryRaw'>;

async function hasBrokerLedger(db: BrokerQuery) {
  const rows = await db.$queryRaw<Array<{ installed: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname='sharkai_broker') AS installed
  `;
  if (rows.length !== 1 || typeof rows[0].installed !== 'boolean') throw new Error('BROKER_STATE_UNAVAILABLE');
  return rows[0].installed;
}

/** Call on the same transaction before revoking app access; a failed broker revoke rolls back both. */
export async function revokeBrokerOwnerTrading(tx: BrokerQuery, userId: string) {
  if (!await hasBrokerLedger(tx)) return;
  const rows = await tx.$queryRaw<Array<{ result: unknown }>>`
    SELECT sharkai_broker.revoke_owner_trading(
      ${userId}, pg_catalog.to_regclass('"WalletInvestmentSettings"')
    ) AS result
  `;
  if (rows.length !== 1 || rows[0].result !== true) throw new Error('BROKER_REVOCATION_UNAVAILABLE');
}

/** userId comes from the owner session. This reads local verified ledger evidence and does not poll the broker. */
export async function readBrokerOwnerState(userId: string, db: BrokerQuery = prisma): Promise<BrokerOwnerActivity> {
  try {
    if (!await hasBrokerLedger(db)) return { status: 'provider_unconfigured', accounts: [] };
    const rows = await db.$queryRaw<Array<{ result: unknown }>>`
      SELECT sharkai_broker.read_owner_state(
        ${userId}, pg_catalog.to_regclass('"WalletInvestmentSettings"')
      ) AS result
    `;
    const parsed = activity.safeParse(rows.length === 1 ? rows[0].result : null);
    if (parsed.success) return parsed.data;
  } catch {
    return { status: 'unavailable', accounts: [] };
  }
  return { status: 'unavailable', accounts: [] };
}
