import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateInvestmentForecast, type ForecastFunding, type ForecastHistory, type ForecastInput } from '../lib/investments/forecast';

const now = new Date('2026-11-19T14:00:00Z');
const dayMs = 86_400_000;
type DailyClose = ForecastHistory['closes'][number];

function calendar(count: number, end = '2026-11-18'): DailyClose[] {
  const last = Date.parse(end + 'T00:00:00.000Z');
  return Array.from({ length: count }, (_, i) => ({
    date: new Date(last - (count - 1 - i) * dayMs).toISOString().slice(0, 10),
    units: i % 2 === 0 ? '10000' : '11000',
    kind: 'valued',
  }));
}

const closes = calendar(61);
const funding: ForecastFunding = {
  ownerId: 'fixture-owner', accountRef: 'fixture-binding', basis: 'segregated_settled_realized_net_profit',
  currency: 'EUR', availableMinor: '10000', source: 'fixture segregated settled profits',
  observedAt: '2026-11-19T13:59:00Z',
};
const history: ForecastHistory = {
  ownerId: 'fixture-owner', accountRef: 'fixture-binding',
  source: 'fixture verified NAV', currency: 'EUR', instrumentCode: 'SYNTH', strategyLabel: 'fixture-v1',
  basis: 'cash_flow_adjusted_after_fees', valuationBasis: 'unitized_strategy_nav',
  feeCoverage: { execution: 'included', ongoing: 'included', financing: 'not_applicable', currencyConversion: 'not_applicable' },
  applicableCapitalMinor: { min: '1000', max: '15000' },
  observedAt: '2026-11-19T00:05:00Z', closes,
};
const input: ForecastInput = {
  ownerId: 'fixture-owner', currency: 'EUR', authorizedAmountMinor: '25000', horizonDays: 1,
  instrumentCode: 'SYNTH', strategyLabel: 'fixture-v1', funding, history,
};

function withHistory(patch: Partial<ForecastHistory>, options: Partial<ForecastInput> = {}) {
  return estimateInvestmentForecast({ ...input, ...options, history: { ...history, ...patch } }, now);
}

function setClose(records: DailyClose[], index: number, patch: Partial<DailyClose>) {
  return records.map((record, i) => i === index ? { ...record, ...patch } : record);
}

test('reports historical P5, median, P95 and observed extremes on authorized segregated net gains', () => {
  const result = estimateInvestmentForecast(input, now);
  assert.equal(result.status, 'available');
  assert.equal(result.method, 'historical_nonoverlapping_after_fees');
  assert.equal(result.sample_count, 60);
  assert.equal(result.authorized_funded_minor, '10000');
  assert.equal(result.window_start, '2026-09-19');
  assert.equal(result.window_end, '2026-11-18');
  assert.deepEqual([result.lower_minor, result.median_minor, result.upper_minor], ['-910', '45', '1000']);
  assert.deepEqual([result.worst_observed_minor, result.best_observed_minor], ['-910', '1000']);
  assert.deepEqual(result.fee_coverage, history.feeCoverage);
  assert.equal(estimateInvestmentForecast({ ...input, authorizedAmountMinor: '5000' }, now).upper_minor, '500');
});

test('samples consecutive two-day windows without counting overlapping starts or discarding corrupted prefix data', () => {
  const longer = calendar(122);
  const result = withHistory({ closes: longer }, { horizonDays: 2 });
  assert.equal(result.status, 'available');
  assert.equal(result.sample_count, 60);
  assert.equal(result.window_start, longer[1].date);
  assert.deepEqual([result.lower_minor, result.median_minor, result.upper_minor], ['0', '0', '0']);
  assert.equal(withHistory({ closes: setClose(longer, 0, { date: longer[1].date }) }, { horizonDays: 2 }).status, 'unavailable');
});

test('an odd number of windows uses the middle observed return', () => {
  const result = withHistory({ closes: calendar(62) });
  assert.equal(result.status, 'available');
  assert.equal(result.sample_count, 61);
  assert.equal(result.median_minor, '1000');
});

test('missing, differently owned or nonsettled funding yields no numeric forecast', () => {
  const category = 'wallet_balance' as unknown as ForecastFunding['basis'];
  for (const rejected of [
    null,
    { ...funding, ownerId: 'another-owner' },
    { ...funding, accountRef: '' },
    { ...funding, basis: category },
    { ...funding, basis: 'settled_cash_no_margin' as ForecastFunding['basis'] },
    { ...funding, currency: 'USD' },
    { ...funding, source: '\n' },
    { ...funding, observedAt: '2026-11-19T14:00:00.001Z' },
    { ...funding, observedAt: '2026-11-19T13:54:59.999Z' },
  ]) {
    const result = estimateInvestmentForecast({ ...input, funding: rejected }, now);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.authorized_funded_minor, '0');
    assert.equal(result.reason,'unverified_profit_capital');
    assert.equal(result.upper_minor, null);
  }
  assert.equal(estimateInvestmentForecast({ ...input, authorizedAmountMinor: '0' }, now).reason, 'no_authorized_capital');
  assert.equal(estimateInvestmentForecast({ ...input, funding: { ...funding, availableMinor: '0' } }, now).reason, 'no_authorized_capital');
});

test('another owner, broker account, currency, instrument, strategy, raw equity or raw price cannot be used as NAV', () => {
  for (const rejected of [
    { ownerId: 'another-owner' },
    { accountRef: 'another-broker-account' },
    { currency: 'USD' },
    { instrumentCode: 'ANOTHER' },
    { strategyLabel: 'other-version' },
    { valuationBasis: 'nominal_equity' as unknown as ForecastHistory['valuationBasis'] },
    { basis: 'gross_price_returns' as unknown as ForecastHistory['basis'] },
  ]) {
    const result = withHistory(rejected);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.upper_minor, null);
    assert.equal(result.source, null);
  }
});

test('latest complete UTC day and strict retrieval timestamp are both required', () => {
  for (const rejected of [
    { observedAt: '2026-11-20T00:05:00Z' },
    { observedAt: '2026-11-18T23:59:59.999Z' },
    { observedAt: '2026-11-18T24:00:00Z' },
    { observedAt: '2026-11-19T02:05:00+02:00' },
    { closes: calendar(61, '2026-11-17') },
    { closes: calendar(61, '2026-11-19') },
    { closes: setClose(closes, 60, { date: '2026-11-31' }) },
  ]) assert.equal(withHistory(rejected).status, 'unavailable');
});

test('calendar samples must be complete, ordered, distinct and sufficient', () => {
  const swapped = [...closes];
  [swapped[15], swapped[16]] = [swapped[16], swapped[15]];
  for (const badCloses of [
    swapped,
    setClose(closes, 4, { date: closes[3].date }),
    calendar(62).filter((_, i) => i !== 40),
    calendar(60),
    [],
  ]) assert.equal(withHistory({ closes: badCloses }).status, 'unavailable');
  assert.equal(estimateInvestmentForecast({ ...input, horizonDays: 7 }, now).lower_minor, null);
  assert.equal(estimateInvestmentForecast({ ...input, horizonDays: Infinity }, now).status, 'unavailable');
});

test('confirmed market closure is usable only as an unchanged carry of known NAV', () => {
  const valid = setClose(closes, 10, { kind: 'confirmed_market_closed', units: closes[9].units });
  assert.equal(withHistory({ closes: valid }).status, 'available');
  assert.equal(withHistory({ closes: setClose(closes, 10, { kind: 'confirmed_market_closed' }) }).status, 'unavailable');
  assert.equal(withHistory({ closes: setClose(closes, 0, { kind: 'confirmed_market_closed' }) }).status, 'unavailable');
});

test('unknown fee coverage or fees validated for different capital suppress results', () => {
  for (const rejected of [
    { feeCoverage: { ...history.feeCoverage, financing: 'unknown' as unknown as ForecastHistory['feeCoverage']['financing'] } },
    { applicableCapitalMinor: { min: '10001', max: '20000' } },
    { applicableCapitalMinor: { min: '1000', max: '9999' } },
    { applicableCapitalMinor: { min: '20000', max: '1000' } },
  ]) {
    const result = withHistory(rejected);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.fee_coverage, null);
  }
  const extendedCoverage = { ...history.feeCoverage, providerPrivateMetadata: 'secret fixture' };
  assert.deepEqual(withHistory({ feeCoverage: extendedCoverage }).fee_coverage, history.feeCoverage);
});

test('preserves a terminal total loss and rejects a restarted NAV, negative or malformed valuations', () => {
  const result = withHistory({ closes: setClose(closes, 60, { units: '0' }) });
  assert.equal(result.status, 'available');
  assert.equal(result.worst_observed_minor, '-10000');
  for (const badValue of ['0', '-1', '1.2', '00100', '1e4', '3'.repeat(26)]) {
    const rejected = withHistory({ closes: setClose(closes, 5, { units: badValue }) });
    assert.equal(rejected.status, 'unavailable');
    assert.equal(rejected.worst_observed_minor, null);
  }
});
