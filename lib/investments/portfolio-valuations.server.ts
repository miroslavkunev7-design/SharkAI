import { prisma } from '../db';

type Valuation = { observed_at: string; equity_minor: string };
type Selection = { currency: string | null; instrument_code: string | null; strategy_label: string | null };

/** Absolute broker equity from approved funding observations. Unitized strategy NAV is a different series. */
export async function readPortfolioValuations(userId: string, selection: Selection, provider: 'ibkr' | 'saxo'): Promise<Valuation[]> {
  if (!selection.currency) return [];
  try {
    return await prisma.$transaction(async db => {
      await db.$executeRaw`SET LOCAL statement_timeout = '2s'`;
      return db.$queryRaw<Valuation[]>`
        WITH candidates AS (
          SELECT id, provider, greatest(ownership_verified_at, provider_read_approved_at, strategy_isolation_verified_at) AS approved_from
          FROM sharkai_forecast.binding
          WHERE user_id = ${userId} AND currency = ${selection.currency}
            AND (${selection.instrument_code}::text IS NULL OR instrument_code = ${selection.instrument_code})
            AND (${selection.strategy_label}::text IS NULL OR strategy_label = ${selection.strategy_label})
            AND revoked_at IS NULL AND expires_at > statement_timestamp()
            AND ownership_verified_at <= statement_timestamp() AND strategy_isolation_verified_at <= statement_timestamp()
            AND provider_read_approved_at <= statement_timestamp()
          LIMIT 2
        ), hourly AS (
          SELECT DISTINCT ON (date_trunc('hour', s.provider_observed_at AT TIME ZONE 'UTC'))
            s.provider_observed_at, s.payload->>'equity_minor' AS equity_minor
          FROM candidates b JOIN sharkai_forecast.snapshot s ON s.binding_id = b.id
          WHERE (SELECT count(*) FROM candidates) = 1 AND b.provider = ${provider}
            AND s.provider_observed_at >= b.approved_from
            AND s.kind = 'funding' AND s.payload->>'source' = b.provider || '_broker_settled_cash'
            AND s.payload->>'cash_basis' = 'settled_cash_no_margin'
            AND (s.payload->>'equity_minor') ~ '^(0|[1-9][0-9]{0,24})$'
            AND s.provider_observed_at BETWEEN statement_timestamp() - interval '30 days' AND statement_timestamp()
          ORDER BY date_trunc('hour', s.provider_observed_at AT TIME ZONE 'UTC'), s.provider_observed_at DESC
        )
        SELECT to_char(provider_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at,
          equity_minor FROM hourly ORDER BY provider_observed_at
      `;
    }, { maxWait: 1_000, timeout: 3_000 });
  } catch {
    // An unconfigured source or unavailable historical read must leave current account data usable.
    return [];
  }
}
