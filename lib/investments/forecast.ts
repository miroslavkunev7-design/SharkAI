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

type HistorySelection=Pick<ForecastInput,'ownerId'|'currency'|'instrumentCode'|'strategyLabel'|'horizonDays'|'history'>;

function calendarBoundary(closeTime:number,anchor:number){
  // A period starts immediately after the prior day's final UTC valuation.
  const opening=new Date(closeTime+dayMs);
  const lastDay=new Date(Date.UTC(opening.getUTCFullYear(),opening.getUTCMonth()+1,0)).getUTCDate();
  return opening.getUTCDate()===Math.min(anchor,lastDay);
}

/** Independently recorded daily strategy NAV. No deposit, market quote or cash balance is converted into NAV evidence here. */
export function verifiedHistoricalReturns(input:HistorySelection,now:Date,calendarMonth=false) {
  const {history,ownerId,currency,instrumentCode,strategyLabel,horizonDays}=input;
  if(!history||!evidenceLabel(ownerId)||!evidenceLabel(history.accountRef)||history.ownerId!==ownerId||
    !currency||!/^[A-Z]{3}$/.test(currency)||history.currency!==currency||!evidenceLabel(instrumentCode)||!evidenceLabel(strategyLabel)||
    history.instrumentCode!==instrumentCode||history.strategyLabel!==strategyLabel||!evidenceLabel(history.source)||
    history.basis!=='cash_flow_adjusted_after_fees'||history.valuationBasis!=='unitized_strategy_nav'||
    !horizonDays||!Number.isInteger(horizonDays)||horizonDays<1||horizonDays>366)return null;
  const feeCoverage=verifiedFeeCoverage(history.feeCoverage);
  const minCapital=unsignedInteger(history.applicableCapitalMinor?.min),maxCapital=unsignedInteger(history.applicableCapitalMinor?.max);
  if(!feeCoverage||minCapital===null||maxCapital===null||maxCapital<minCapital)return null;
  const closes=history.closes,time=now.valueOf(),today=Math.floor(time/dayMs)*dayMs;
  const observed=instant(history.observedAt),last=Array.isArray(closes)?closes.length-1:-1;
  if(!Number.isFinite(time)||!Number.isFinite(observed)||observed<today||observed>time||last<1||last>=maxDailyCloses)return null;
  const firstFixed=last%horizonDays;
  const monthAnchor=now.getUTCDate();
  const boundaries:{units:bigint;date:string}[]=[];
  let previous:bigint|null=null,valuedCloses=0;
  for(let i=0;i<=last;i++){
    const close=closes[i],date=today-(last-i+1)*dayMs;
    if(!close||utcDay(close.date)!==date)return null;
    const units=unsignedInteger(close.units);
    if(units===null||(units===zero&&i!==last))return null;
    if(close.kind==='valued')valuedCloses++;
    else if(close.kind!=='confirmed_market_closed'||units!==previous)return null;
    previous=units;
    if(calendarMonth?calendarBoundary(date,monthAnchor):i>=firstFixed&&(i-firstFixed)%horizonDays===0){
      boundaries.push({units,date:close.date});
    }
  }
  if(valuedCloses<2||boundaries.length<=minWindows)return null;
  const outcomes=boundaries.slice(1).map((end,i)=>({change:end.units-boundaries[i].units,initial:boundaries[i].units}));
  outcomes.sort((a,b)=>{
    const comparison=a.change*b.initial-b.change*a.initial;
    return comparison<zero?-1:comparison>zero?1:0;
  });
  return {outcomes,minCapital,maxCapital,feeCoverage,windowStart:boundaries[0].date,windowEnd:boundaries[boundaries.length-1].date,
    source:history.source,asOf:history.observedAt};
}
type Evidence=NonNullable<ReturnType<typeof verifiedHistoricalReturns>>;
function capitalInRange(capital:bigint,evidence:Evidence){
  return capital>zero&&capital>=evidence.minCapital&&capital<=evidence.maxCapital;
}
function moneyAt(capital:bigint,{change,initial}:HistoricalReturn){
  return floorRatio(capital*change,initial).toString();
}
function percentage({change,initial}:HistoricalReturn,upper=false){
  const numerator=change*BigInt(100000000);
  const scaled=upper?-floorRatio(-numerator,initial):floorRatio(numerator,initial);
  const digits=(scaled<zero?-scaled:scaled).toString().padStart(7,'0');
  return (scaled<zero?'-':'')+digits.slice(0,-6)+'.'+digits.slice(-6);
}
export function observedRange(capital:bigint,evidence:Evidence|null){
  if(!evidence||!capitalInRange(capital,evidence))return null;
  const low=evidence.outcomes[0],high=evidence.outcomes[evidence.outcomes.length-1];
  return {lower_minor:moneyAt(capital,low),upper_minor:(-floorRatio(-capital*high.change,high.initial)).toString(),
    lower_pct:percentage(low),upper_pct:percentage(high,true)};
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
  if(!history||history.accountRef!==funding.accountRef)return funded;
  const evidence=verifiedHistoricalReturns(input,now);
  if(!evidence||!capitalInRange(capital,evidence))return funded;
  const {outcomes,feeCoverage}=evidence,windows=outcomes.length;
  const amount=(value:HistoricalReturn)=>moneyAt(capital,value);
  const percentile = (percent: number) => outcomes[Math.ceil(windows * percent / 100) - 1];
  return {
    ...funded, status: 'available', reason: null, lower_minor: amount(percentile(5)), median_minor: amount(medianReturn(outcomes)),
    upper_minor: amount(percentile(95)), worst_observed_minor: amount(outcomes[0]),
    best_observed_minor: amount(outcomes[windows - 1]), as_of: history.observedAt, window_start: evidence.windowStart,
    window_end: evidence.windowEnd, sample_count: windows, source: history.source, fee_coverage: feeCoverage,
  };
}
