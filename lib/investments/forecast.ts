/** Server-side inputs from an account-owner-checked connector, never from a chat message. */
export type ForecastFunding = {
  ownerId: string;
  accountRef: string;
  basis: 'segregated_settled_realized_net_profit';
  currency: string;
  availableMinor: string;
  source: string;
  observedAt: string;
};

type FeeTreatment = 'included' | 'not_applicable';

type FeeCoverage = {
  execution: FeeTreatment;
  ongoing: FeeTreatment;
  financing: FeeTreatment;
  currencyConversion: FeeTreatment;
};

export type ForecastHistory = {
  ownerId: string;
  accountRef: string;
  currency: string;
  instrumentCode: string;
  strategyLabel: string;
  source: string;
  observedAt: string;
  basis: 'cash_flow_adjusted_after_fees';
  valuationBasis: 'unitized_strategy_nav';
  feeCoverage: FeeCoverage;
  /** Current funded amounts to which the connector verified this historical fee treatment applies. */
  applicableCapitalMinor: { min: string; max: string };
  /** Final UTC daily marks, or verified unchanged carry on a market closure. */
  closes: ReadonlyArray<{ date: string; units: string; kind: 'valued' | 'confirmed_market_closed' }>;
};

export type ForecastInput = {
  ownerId: string;
  currency: string | null;
  authorizedAmountMinor: string | null;
  instrumentCode: string | null;
  strategyLabel: string | null;
  horizonDays: number | null;
  funding: ForecastFunding | null;
  history: ForecastHistory | null;
};

type ForecastResult = {
  status: 'available' | 'unavailable';
  reason: 'insufficient_verified_data' | 'unverified_profit_capital' | 'no_authorized_capital' | null;
  currency: string | null;
  instrument_code: string | null;
  strategy_label: string | null;
  authorized_funded_minor: string;
  lower_minor: string | null;
  median_minor: string | null;
  upper_minor: string | null;
  worst_observed_minor: string | null;
  best_observed_minor: string | null;
  as_of: string | null;
  window_start: string | null;
  window_end: string | null;
  sample_count: number | null;
  source: string | null;
  funding_source: string | null;
  fee_coverage: FeeCoverage | null;
  horizon_days: number | null;
  method: 'historical_nonoverlapping_after_fees';
  performance_fee_basis: 'before_platform_performance_fee';
  platform_performance_fee_bps: 1000;
  percentiles: readonly [5, 50, 95];
};

const dayMs = 86_400_000;
const minWindows = 60;
const maxDailyCloses = 36_600;
const zero = BigInt(0);

function unsignedInteger(value: unknown) {
  return typeof value === 'string' && /^(0|[1-9]\d{0,24})$/.test(value) ? BigInt(value) : null;
}

function utcDay(date: unknown) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const time = Date.parse(date + 'T00:00:00.000Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date ? time : NaN;
}

function instant(value: unknown) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.test(value) ||
      !Number.isFinite(utcDay(value.slice(0, 10)))) return NaN;
  return Date.parse(value);
}

function evidenceLabel(value: unknown) {
  return typeof value === 'string' && value.length <= 200 && value.trim().length > 0 && !/\p{Cc}/u.test(value);
}

function verifiedFeeCoverage(fees: FeeCoverage): FeeCoverage | null {
  if (!fees) return null;
  const { execution, ongoing, financing, currencyConversion } = fees;
  if (![execution, ongoing, financing, currencyConversion]
    .every((treatment) => treatment === 'included' || treatment === 'not_applicable')) return null;
  return { execution, ongoing, financing, currencyConversion };
}

function floorRatio(numerator: bigint, denominator: bigint) {
  const quotient = numerator / denominator;
  return numerator < zero && numerator % denominator !== zero ? quotient - BigInt(1) : quotient;
}

type HistoricalReturn = { change: bigint; initial: bigint };

function medianReturn(sorted: HistoricalReturn[]) {
  const middle = Math.floor(sorted.length / 2);
  const right = sorted[middle];
  if (sorted.length % 2) return right;
  const left = sorted[middle - 1];
  return {
    change: left.change * right.initial + right.change * left.initial,
    initial: BigInt(2) * left.initial * right.initial,
  };
}

/** Historical scenarios use contiguous, non-overlapping periods without assuming independent returns. */
export function estimateInvestmentForecast(input: ForecastInput, now = new Date()): ForecastResult {
  const { ownerId, currency, instrumentCode, strategyLabel, horizonDays, funding, history } = input;
  const empty: ForecastResult = {
    status: 'unavailable', reason: 'unverified_profit_capital', currency, instrument_code: instrumentCode,
    strategy_label: strategyLabel, authorized_funded_minor: '0', lower_minor: null, median_minor: null,
    upper_minor: null, worst_observed_minor: null, best_observed_minor: null,
    as_of: null, window_start: null, window_end: null, sample_count: null,
    source: null, funding_source: null, fee_coverage: null, horizon_days: horizonDays,
    method: 'historical_nonoverlapping_after_fees', percentiles: [5, 50, 95],
    performance_fee_basis:'before_platform_performance_fee',platform_performance_fee_bps:1000,
  };
  if (!evidenceLabel(ownerId) || !currency || !/^[A-Z]{3}$/.test(currency)) return empty;

  const cap = unsignedInteger(input.authorizedAmountMinor);
  if (cap === null || cap === zero) return { ...empty, reason: 'no_authorized_capital' };
  const time = now.getTime();
  if (!Number.isFinite(time) || !funding || funding.ownerId !== ownerId ||
      !evidenceLabel(funding.accountRef) || funding.basis !== 'segregated_settled_realized_net_profit' ||
      funding.currency !== currency || !evidenceLabel(funding.source)) return empty;
  const fundingObserved = instant(funding.observedAt);
  if (!Number.isFinite(fundingObserved) || fundingObserved > time || time - fundingObserved > 5 * 60_000) return empty;
  const available = unsignedInteger(funding.availableMinor);
  if (available === null) return empty;
  if (available === zero) return { ...empty, reason: 'no_authorized_capital' };
  const capital = available < cap ? available : cap;
  const funded = { ...empty, reason:'insufficient_verified_data' as const, authorized_funded_minor: capital.toString(), funding_source: funding.source };
  if (!evidenceLabel(instrumentCode) || !evidenceLabel(strategyLabel) ||
      !horizonDays || !Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 366) return funded;
  if (!history || history.ownerId !== ownerId || history.accountRef !== funding.accountRef ||
      !evidenceLabel(history.source) || history.currency !== currency ||
      history.instrumentCode !== instrumentCode || history.strategyLabel !== strategyLabel ||
      history.basis !== 'cash_flow_adjusted_after_fees' || history.valuationBasis !== 'unitized_strategy_nav') return funded;
  const feeCoverage = verifiedFeeCoverage(history.feeCoverage);
  const minCapital = unsignedInteger(history.applicableCapitalMinor?.min);
  const maxCapital = unsignedInteger(history.applicableCapitalMinor?.max);
  if (!feeCoverage || minCapital === null || maxCapital === null || capital < minCapital || capital > maxCapital) return funded;

  const closes = history.closes;
  if (!Array.isArray(closes) || closes.length > maxDailyCloses) return funded;
  const last = closes.length - 1;
  const windows = Math.floor(last / horizonDays);
  if (windows < minWindows) return funded;
  const today = Math.floor(time / dayMs) * dayMs;
  const end = today - dayMs;
  const observedAt = instant(history.observedAt);
  if (!Number.isFinite(observedAt) || observedAt < today || observedAt > time) return funded;
  const start = last - windows * horizonDays;
  const values: bigint[] = [];
  let previous: bigint | null = null;
  let valuedCloses = 0;
  for (let i = 0; i <= last; i++) {
    const close = closes[i];
    if (!close || utcDay(close.date) !== end - (last - i) * dayMs) return funded;
    const units = unsignedInteger(close.units);
    if (units === null || (units === zero && i !== last)) return funded;
    if (close.kind === 'valued') valuedCloses++;
    else if (close.kind !== 'confirmed_market_closed' || units !== previous) return funded;
    previous = units;
    if (i >= start && (i - start) % horizonDays === 0) values.push(units);
  }
  if (valuedCloses < 2) return funded;
  const outcomes = values.slice(1).map((close, i) => ({ change: close - values[i], initial: values[i] }));
  outcomes.sort((a, b) => {
    const comparison = a.change * b.initial - b.change * a.initial;
    return comparison < zero ? -1 : comparison > zero ? 1 : 0;
  });
  const amount = ({ change, initial }: HistoricalReturn) => floorRatio(capital * change, initial).toString();
  const percentile = (percent: number) => outcomes[Math.ceil(windows * percent / 100) - 1];
  return {
    ...funded, status: 'available', reason: null, lower_minor: amount(percentile(5)), median_minor: amount(medianReturn(outcomes)),
    upper_minor: amount(percentile(95)), worst_observed_minor: amount(outcomes[0]),
    best_observed_minor: amount(outcomes[windows - 1]), as_of: history.observedAt, window_start: closes[start].date,
    window_end: closes[last].date, sample_count: windows, source: history.source, fee_coverage: feeCoverage,
  };
}
