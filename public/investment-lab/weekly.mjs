import { DAY, backtest } from './engine.mjs';

const CENT = 0.01;
const WEEK = 7 * DAY;
const MARKET_CALIBRATION = 1000;
const MAX_WINDOWS = 16;
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;

function number(value, label, min = 0, max = 10_000_000) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error('Провери полето „' + label + '“.');
  }
  return value;
}

export function weekInputs(request) {
  const budget = round(number(request.budget, 'Бюджет', CENT));
  const reserve = round(number(request.reserve, 'Резерв', 0, budget));
  const minimum = round(number(request.minimum, 'Праг за целта', CENT));
  const goal = round(number(request.goal, 'Желана сума', minimum));
  return { budget, reserve, minimum, goal, available: round(budget - reserve) };
}

export function weekCash(received, spent) {
  return round(number(received, 'Постъпления') - number(spent, 'Платени разходи'));
}

export function resaleOption(input) {
  if (!input.enabled) return null;
  const purchase = number(input.purchase, 'Покупка', CENT);
  const fees = number(input.fees, 'Общи разходи за препродажба');
  const paid = number(input.paid, 'Постъпление при продажба', CENT);
  const likelihood = number(input.chance, 'Успешна продажба (%)', 0, 100) / 100;
  const commitment = round(purchase + fees);
  return {
    label: 'Препродажба', commitment,
    outcomes: [
      { net: round(paid - commitment), weight: likelihood },
      { net: -commitment, weight: 1 - likelihood },
    ],
  };
}

export function adsOption(input) {
  if (!input.enabled) return null;
  const spend = round(number(input.spend, 'Рекламен разход', CENT));
  const margin = number(input.margin, 'Марж на платена продажба', CENT);
  const sales = number(input.sales, 'Брой платени продажби', 1, 10_000);
  if (!Number.isInteger(sales)) throw new Error('Броят продажби трябва да е цяло число.');
  const likelihood = number(input.chance, 'Успешна кампания (%)', 0, 100) / 100;
  return {
    label: 'Реклама', commitment: spend,
    outcomes: [
      { net: round(margin * sales - spend), weight: likelihood },
      { net: -spend, weight: 1 - likelihood },
    ],
  };
}

function sevenDayWindows(candles, cursor) {
  const windows = [];
  let end = Math.min(cursor, candles.length - 1);
  while (end > 0 && windows.length < MAX_WINDOWS) {
    const lower = candles[end].time - WEEK;
    let start = end - 1;
    while (start >= 0 && candles[start].time > lower) start--;
    if (start < 0) break;
    if (candles[start].time === lower && end - start <= 180) windows.push({ start, end });
    end = start;
  }
  return windows;
}

export function marketOptionsForWeek(dataset, state) {
  const markets = [];
  for (const [symbol, candles] of Object.entries(dataset.series)) {
    const windows = sevenDayWindows(candles, state.cursor);
    if (!windows.length) continue;
    const fees = state.plan.fee / 100;
    const slippage = state.plan.slippage / 100;
    const hold = [];
    const sma = [];
    for (const { start, end } of windows) {
      const entry = candles[start].close * (1 + slippage) * (1 + fees);
      const exit = candles[end].close * (1 - slippage) * (1 - fees);
      hold.push(exit / entry - 1);
      if (start < state.plan.window || end - start < 2) continue;
      const model = {
        ...state, symbol, cursor: end, initial: MARKET_CALIBRATION,
        plan: {
          ...state.plan, capital: MARKET_CALIBRATION, days: 8, target: 100,
          entryMax: MARKET_CALIBRATION, dailyMax: MARKET_CALIBRATION, strategySize: MARKET_CALIBRATION,
        },
      };
      sma.push(backtest(model, dataset, end - start).roi / 100);
    }
    markets.push({ label: 'Задържане · ' + symbol, samples: hold });
    if (sma.length) markets.push({ label: 'SMA ' + state.plan.window + ' · ' + symbol, samples: sma });
  }
  return markets;
}

function combine(a, b) {
  return a.flatMap(left => b.map(right => ({
    net: round(left.net + right.net),
    weight: left.weight * right.weight,
  }))).filter(item => item.weight > 0);
}

function summary(options, plan) {
  const outcomes = options.reduce((acc, option) => combine(acc, option.outcomes), [{ net: 0, weight: 1 }]);
  const sum = outcomes.reduce((n, item) => n + item.weight, 0);
  const chance = threshold => 100 * outcomes.filter(item => item.net >= threshold)
    .reduce((n, item) => n + item.weight, 0) / sum;
  const mean = round(outcomes.reduce((n, item) => n + item.net * item.weight, 0) / sum);
  const gap = round(outcomes.reduce((n, item) => n + Math.max(0, plan.minimum - item.net) * item.weight, 0) / sum);
  const commitment = round(options.reduce((n, item) => n + item.commitment, 0));
  return {
    label: options.length ? options.map(item => item.label).join(' + ') : 'Кеш',
    routes: options.map(item => ({ label: item.label, amount: item.commitment, samples: item.samples ?? null })),
    commitment, cash: round(plan.budget - commitment), mean, gap,
    worst: Math.min(...outcomes.map(item => item.net)),
    best: Math.max(...outcomes.map(item => item.net)),
    thresholdShare: chance(plan.minimum), targetShare: chance(plan.goal),
  };
}

export function compareWeek(request, { markets = [], resale = null, ads = null } = {}) {
  const plan = weekInputs(request);
  const manual = [resale, ads].filter(Boolean);
  const combinations = manual.reduce((sets, item) => [...sets, ...sets.map(set => [...set, item])], [[]]);
  const evaluated = [];
  let overBudget = 0;
  for (const fixed of combinations) {
    const committed = round(fixed.reduce((n, item) => n + item.commitment, 0));
    const remaining = round(plan.available - committed);
    if (remaining < 0) {
      overBudget++;
      continue;
    }
    evaluated.push(summary(fixed, plan));
    const allocations = [...new Set([0.25, 0.5, 0.75, 1].map(part => round(remaining * part)))].filter(amount => amount >= 5);
    for (const market of markets) {
      if (!market.samples.length) continue;
      for (const amount of allocations) {
        evaluated.push(summary([...fixed, {
          label: market.label, commitment: amount, samples: market.samples.length,
          outcomes: market.samples.map(net => ({ net: round(net * amount), weight: 1 / market.samples.length })),
        }], plan));
      }
    }
  }
  const sorted = evaluated.sort((a, b) => (
    Number(b.mean >= 0) - Number(a.mean >= 0)
      || b.thresholdShare - a.thresholdShare
      || a.gap - b.gap
      || b.mean - a.mean
      || b.worst - a.worst
      || a.commitment - b.commitment
  ));
  return { plan, selected: sorted[0], ranked: sorted, overBudget };
}
