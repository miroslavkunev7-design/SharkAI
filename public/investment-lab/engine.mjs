export const DAY = 86_400_000;
export const ASSETS = [
  { symbol: 'BTC/EUR', code: 'BTC', name: 'Bitcoin', color: '#f6ad5a', start: 58_780 },
  { symbol: 'ETH/EUR', code: 'ETH', name: 'Ethereum', color: '#a096ff', start: 2_488 },
  { symbol: 'SOL/EUR', code: 'SOL', name: 'Solana', color: '#56dcbf', start: 142.60 },
];

export const DEFAULT_PLAN = {
  capital: 10_000, target: 2, drawdown: 3, days: 30,
  entryMax: 1_000, dailyMax: 2_500, fee: 0.8, slippage: 0.08,
  strategy: 'manual', window: 20, strategySize: 750, strategySymbol: 'BTC/EUR',
};

const MIN_ORDER = 5;
const PRECISION = 100_000_000;
const EPSILON = 0.000001;
const SCENARIO_START = 81;
const clone = value => structuredClone(value);
const floorUnits = value => Math.floor((value + 1e-12) * PRECISION) / PRECISION;
const percent = value => value / 100;
const validNumber = value => typeof value === 'number' && Number.isFinite(value);
const validPrice = value => validNumber(value) && value > 0;
const dayKey = time => Math.floor(time / DAY);

export function assetFor(symbol) {
  return ASSETS.find(asset => asset.symbol === symbol);
}

function randomGenerator(seed) {
  let number = seed >>> 0;
  return () => {
    number = (Math.imul(number, 1_664_525) + 1_013_904_223) >>> 0;
    return number / 4_294_967_296;
  };
}

export function scenarioData(kind = 'base') {
  const series = {};
  for (const [assetIndex, asset] of ASSETS.entries()) {
    const random = randomGenerator(741077 + (assetIndex * 229));
    let previous = asset.start;
    series[asset.symbol] = Array.from({ length: 205 }, (_, index) => {
      const time = Date.UTC(2026, 10, 17) + (index - SCENARIO_START) * DAY;
      const open = previous * (1 + (random() - 0.5) * 0.003);
      const shock = (random() - 0.5) * (kind === 'volatile' ? 0.049 : 0.021);
      const trend = kind === 'down' ? -0.0038 : 0.0017;
      const cycle = 0.0062 * Math.sin(index / 4.1) + 0.0049 * Math.cos(index / 7.5);
      const close = open * (1 + trend + cycle + shock);
      const high = Math.max(open, close) * (1 + random() * 0.0055);
      const low = Math.min(open, close) * (1 - random() * 0.0055);
      const volume = Math.round(20 + random() * 80 + Math.abs(close / open - 1) * 1_500);
      previous = close;
      return { time, open, high, low, close, volume };
    });
  }
  return { kind: 'scenario', scenario: kind, series, start: SCENARIO_START };
}

export function validatePlan(overrides, dataset) {
  const plan = { ...DEFAULT_PLAN, ...overrides };
  const limits = {
    capital: [50, 10_000_000], target: [0.01, 100], drawdown: [0.01, 100],
    days: [1, 365], entryMax: [MIN_ORDER, 10_000_000], dailyMax: [MIN_ORDER, 10_000_000],
    fee: [0, 5], slippage: [0, 5], window: [3, 80], strategySize: [MIN_ORDER, 10_000_000],
  };
  for (const [field, [min, max]] of Object.entries(limits)) {
    if (!validNumber(plan[field]) || plan[field] < min || plan[field] > max) {
      throw Error('Провери стойностите. Въведи валидни числа в посочените диапазони.');
    }
  }
  if (!Number.isInteger(plan.days) || !Number.isInteger(plan.window)) {
    throw Error('Дните и периодът на средната трябва да са цели числа.');
  }
  if (!['manual', 'sma'].includes(plan.strategy) || !dataset.series[plan.strategySymbol]) {
    throw Error('Избери налична стратегия и пазар от текущия източник.');
  }
  if (plan.strategy === 'sma' && plan.strategySize > Math.min(plan.entryMax, plan.dailyMax)) {
    throw Error('Размерът на сделката на стратегията надвишава лимита за вход или за ден.');
  }
  return plan;
}

function log(state, type, message, time, orderId = '') {
  state.journal.push({ id: state.nextEvent++, type, message, time, orderId });
}

export function initSession(dataset, overrides = {}, selected, start = dataset.start ?? 0) {
  const market = selected && dataset.series[selected] ? selected : Object.keys(dataset.series)[0];
  const plan = validatePlan({ ...overrides, strategySymbol: dataset.series[overrides.strategySymbol] ? overrides.strategySymbol : market }, dataset);
  const beginning = dataset.series[market][start];
  if (!beginning) throw Error('Началният период е извън заредените котировки.');
  const state = {
    revision: 0, cursor: start, initialCursor: start, symbol: market,
    startedAt: beginning.time, initial: plan.capital, cash: plan.capital, plan,
    positions: {}, orders: [], fills: [], journal: [], equity: [{ time: beginning.time, value: plan.capital }],
    peak: plan.capital, worstDrawdown: 0, realized: 0, fees: 0, halt: null,
    nextOrder: 1, nextEvent: 1,
  };
  log(state, 'system', 'Виртуалната сметка е отворена.', beginning.time);
  return state;
}

export function quote(dataset, state, symbol = state.symbol, at = state.cursor) {
  return dataset.series[symbol]?.[at] ?? null;
}

export function paperTime(dataset, state) {
  return quote(dataset, state).time;
}

export function holdings(state, dataset, mark = 'close') {
  return Object.entries(state.positions).flatMap(([symbol, position]) => {
    if (position.quantity <= 0 || !dataset.series[symbol]) return [];
    const price = quote(dataset, state, symbol)[mark];
    const value = position.quantity * price;
    const exitValue = value * (1 - percent(state.plan.fee)) * (1 - percent(state.plan.slippage));
    return [{ symbol, ...position, price, value, exitValue, pnl: exitValue - position.cost }];
  });
}

function reservedCash(state, excluding = '') {
  return state.orders.reduce((sum, order) => sum + (
    order.status === 'pending' && order.side === 'buy' && order.id !== excluding ? order.reserve : 0
  ), 0);
}

function availableUnits(state, symbol, excluding = '') {
  const reserved = state.orders.reduce((sum, order) => sum + (
    order.status === 'pending' && order.symbol === symbol && order.side === 'sell' && order.id !== excluding
      ? order.quantity : 0
  ), 0);
  return Math.max(0, (state.positions[symbol]?.quantity ?? 0) - reserved);
}

function spentOnEntries(state, time) {
  return state.fills.filter(fill => fill.side === 'buy' && dayKey(fill.time) === dayKey(time))
    .reduce((sum, fill) => sum + fill.gross + fill.fee, 0);
}

export function account(state, dataset, mark = 'close') {
  const positions = holdings(state, dataset, mark);
  const marked = positions.reduce((sum, item) => sum + item.value, 0);
  const liquid = positions.reduce((sum, item) => sum + item.exitValue, 0);
  const equity = state.cash + liquid;
  const drawdown = state.peak > 0 ? Math.max(0, (state.peak - equity) / state.peak * 100) : 0;
  return {
    positions, marked, equity, drawdown, pnl: equity - state.initial,
    roi: (equity / state.initial - 1) * 100, realized: state.realized, fees: state.fees,
    freeCash: Math.max(0, state.cash - reservedCash(state)),
    pending: state.orders.filter(order => order.status === 'pending').length,
    spent: spentOnEntries(state, paperTime(dataset, state)),
    target: state.initial * percent(state.plan.target),
    age: Math.max(0, (paperTime(dataset, state) - state.startedAt) / DAY),
  };
}

export function markState(state, dataset, mark = 'close') {
  const values = account(state, dataset, mark);
  state.peak = Math.max(state.peak, values.equity);
  state.worstDrawdown = Math.max(state.worstDrawdown, values.drawdown);
  if (state.halt) return;
  const triggers = [
    [values.drawdown + EPSILON >= state.plan.drawdown, 'drawdown', 'Достигнат праг за спад. Входовете са спрени.'],
    [state.realized + EPSILON >= values.target, 'target', 'Реализираната цел е достигната. Входовете са спрени.'],
    [values.age >= state.plan.days, 'expiry', 'Периодът е изтекъл. Входовете са спрени.'],
  ];
  const trigger = triggers.find(([active]) => active);
  if (trigger) {
    const [, code, message] = trigger;
    state.halt = { code, message };
    const time = paperTime(dataset, state);
    log(state, 'risk', message, time);
    for (const order of state.orders) {
      if (order.status !== 'pending' || order.side !== 'buy') continue;
      order.status = 'cancelled';
      order.reason = message;
      log(state, 'cancelled', 'Чакащият вход е отменен след спиране на входовете.', time, order.id);
    }
  }
}

export function configure(state, dataset, overrides) {
  const next = clone(state);
  next.plan = validatePlan({ ...state.plan, ...overrides, capital: state.initial }, dataset);
  next.revision++;
  const time = paperTime(dataset, next);
  log(next, 'settings', 'Правилата и лимитите са обновени.', time);
  markState(next, dataset);
  return next;
}

export function selectMarket(state, dataset, symbol) {
  if (!dataset.series[symbol]) throw Error('Този пазар липсва в източника.');
  return { ...state, symbol, revision: state.revision + 1 };
}

export function previewOrder(state, dataset, input, atPrice) {
  const { side, type, symbol = state.symbol, all = false } = input;
  if (!dataset.series[symbol] || !['buy', 'sell'].includes(side) || !['market', 'limit'].includes(type)) {
    throw Error('Избери пазар, посока и тип поръчка.');
  }
  if (side === 'buy' && state.halt) throw Error(state.halt.message);
  const bar = quote(dataset, state, symbol);
  const reference = atPrice ?? bar.close;
  const limit = type === 'limit' ? Number(input.limit) : null;
  if (type === 'limit' && !validPrice(limit)) throw Error('Въведи валидна лимит цена.');
  const impact = percent(state.plan.slippage) * (side === 'buy' ? 1 : -1);
  const price = limit ?? reference * (1 + impact);
  const rate = percent(state.plan.fee);
  const amount = Number(input.amount);
  if (!all && (!validPrice(amount) || amount < MIN_ORDER)) throw Error('Минималният размер на поръчката е 5 €.');

  const unitsFree = availableUnits(state, symbol);
  const quantity = side === 'buy'
    ? floorUnits(amount / (price * (1 + rate)))
    : floorUnits(all ? unitsFree : amount / price);
  if (quantity <= 0) throw Error('Няма свободна позиция за продажба.');
  if (side === 'sell' && quantity > unitsFree + 1e-10) throw Error('Тази продажба надвишава свободната позиция.');
  const gross = quantity * price;
  const fee = gross * rate;
  const reserve = side === 'buy' ? gross + fee : 0;
  if (side === 'buy') {
    if (reserve > state.cash - reservedCash(state) + EPSILON) throw Error('Недостатъчен свободен виртуален баланс.');
    if (reserve > state.plan.entryMax + EPSILON) throw Error('Поръчката надвишава лимита за един вход.');
    if (spentOnEntries(state, bar.time) + reserve > state.plan.dailyMax + EPSILON) throw Error('Поръчката надвишава дневния лимит за покупки.');
  }
  return {
    side, type, symbol, amount: all ? null : amount, all, limit, price, reference,
    quantity, gross, fee, reserve, rate, revision: state.revision, source: input.source || 'Ръчно',
    total: side === 'buy' ? gross + fee : gross - fee,
  };
}

function fill(state, order, price, time) {
  const { symbol, side, quantity } = order;
  const gross = quantity * price;
  const fee = gross * order.rate;
  const prior = state.positions[symbol] ?? { quantity: 0, cost: 0 };
  let net;
  let realized = null;
  if (side === 'buy') {
    net = gross + fee;
    if (state.halt || net > Math.min(state.plan.entryMax, state.cash - reservedCash(state, order.id)) + EPSILON
      || spentOnEntries(state, time) + net > state.plan.dailyMax + EPSILON) return false;
    state.cash = Math.max(0, state.cash - net);
    state.positions[symbol] = { quantity: prior.quantity + quantity, cost: prior.cost + net };
  } else {
    if (quantity > availableUnits(state, symbol, order.id) + 1e-10) return false;
    const allocated = prior.cost * (quantity / prior.quantity);
    net = gross - fee;
    realized = net - allocated;
    state.cash += net;
    state.realized += realized;
    if (prior.quantity - quantity < 1e-8) delete state.positions[symbol];
    else state.positions[symbol] = { quantity: prior.quantity - quantity, cost: prior.cost - allocated };
  }
  state.fees += fee;
  order.status = 'filled';
  order.filledAt = time;
  order.fillPrice = price;
  state.fills.push({ orderId: order.id, symbol, side, quantity, price, gross, fee, net, realized, time, source: order.source });
  log(state, 'fill', (side === 'buy' ? 'Покупка' : 'Продажба') + ' ' + symbol + ' е изпълнена.', time, order.id);
  return true;
}

function addOrder(state, draft, time) {
  const order = {
    ...draft, id: 'SH-' + String(state.nextOrder++).padStart(4, '0'), time, status: 'pending',
  };
  state.orders.push(order);
  log(state, 'order', (draft.type === 'limit' ? 'Лимитирана' : 'Пазарна') + ' поръчка за ' + draft.symbol + ' е записана.', time, order.id);
  if (draft.type === 'market' && !fill(state, order, draft.price, time)) throw Error('Поръчката е блокирана от правилата на сметката.');
  return order;
}

export function submitOrder(state, dataset, draft) {
  if (draft.revision !== state.revision) throw Error('Цената или лимитите са променени. Прегледай поръчката отново.');
  const verified = previewOrder(state, dataset, draft);
  const next = clone(state);
  next.revision++;
  addOrder(next, verified, paperTime(dataset, next));
  markState(next, dataset);
  recordEquity(next, dataset);
  return next;
}

export function cancelOrder(state, dataset, orderId) {
  const next = clone(state);
  const order = next.orders.find(candidate => candidate.id === orderId && candidate.status === 'pending');
  if (!order) throw Error('Поръчката вече е обработена.');
  order.status = 'cancelled';
  order.reason = 'Отменена от потребителя.';
  next.revision++;
  log(next, 'cancelled', order.reason, paperTime(dataset, state), order.id);
  return next;
}

function average(items, index, window) {
  if (index < window - 1) return null;
  let sum = 0;
  for (let n = index - window + 1; n <= index; n++) sum += items[n].close;
  return sum / window;
}

export function analysis(dataset, state, symbol = state.symbol) {
  const items = dataset.series[symbol];
  const index = state.cursor;
  const current = items[index];
  const previous = items[Math.max(0, index - 1)];
  const aWeek = items[Math.max(0, index - 7)];
  const sma = average(items, index, state.plan.window);
  const prior = average(items, index - 1, state.plan.window);
  const signal = sma == null || prior == null ? 'none'
    : previous.close <= prior && current.close > sma ? 'buy'
      : previous.close >= prior && current.close < sma ? 'sell' : 'none';
  return { market: symbol, close: current.close, change: (current.close / previous.close - 1) * 100,
    week: (current.close / aWeek.close - 1) * 100, sma, signal, time: current.time };
}

function recordEquity(state, dataset) {
  const point = { time: paperTime(dataset, state), value: account(state, dataset).equity };
  if (state.equity.at(-1)?.time === point.time) state.equity[state.equity.length - 1] = point;
  else state.equity.push(point);
}

export function hasNext(state, dataset) {
  return state.cursor < dataset.series[state.symbol].length - 1;
}

export function step(state, dataset) {
  if (!hasNext(state, dataset)) return state;
  const next = clone(state);
  const symbol = next.plan.strategySymbol;
  const signal = next.plan.strategy === 'sma' ? analysis(dataset, state, symbol).signal : 'none';
  next.cursor++;
  next.revision++;
  const time = paperTime(dataset, next);
  markState(next, dataset, 'open');
  if (signal !== 'none' && (signal === 'buy' ? !next.positions[symbol] && !next.halt : availableUnits(next, symbol) > 0)) {
    try {
      const draft = previewOrder(next, dataset, {
        side: signal, type: 'market', symbol, amount: next.plan.strategySize,
        all: signal === 'sell', source: 'Стратегия SMA ' + next.plan.window,
      }, quote(dataset, next, symbol).open);
      addOrder(next, draft, time);
    } catch (error) {
      log(next, 'risk', 'Сигналът е пропуснат. ' + error.message, time);
    }
  }
  for (const order of next.orders) {
    if (order.status !== 'pending') continue;
    const bar = quote(dataset, next, order.symbol);
    const touched = order.side === 'buy' ? bar.low <= order.limit : bar.high >= order.limit;
    if (!touched) continue;
    const price = order.side === 'buy' ? Math.min(bar.open, order.limit) : Math.max(bar.open, order.limit);
    if (!fill(next, order, price, time)) {
      order.status = 'rejected';
      order.reason = 'Лимитите или свободната наличност са се променили преди изпълнение.';
      log(next, 'risk', order.reason, time, order.id);
    }
  }
  markState(next, dataset);
  recordEquity(next, dataset);
  return next;
}

export function backtest(state, dataset, count = 60) {
  const end = state.cursor;
  const start = Math.max(0, end - Math.max(2, Math.min(180, Number(count))));
  if (end - start < 2) throw Error('Нужни са поне три котировки преди текущата позиция.');
  const strategySize = Math.min(state.plan.strategySize, state.plan.entryMax, state.plan.dailyMax, state.initial);
  let run = initSession(dataset, {
    ...state.plan, strategySize, strategy: 'sma',
    strategySymbol: state.symbol, capital: state.initial,
  }, state.symbol, start);
  while (run.cursor < end) run = step(run, dataset);
  const initialPrice = quote(dataset, run, run.symbol, start).close;
  const finalPrice = quote(dataset, run).close;
  const fee = percent(run.plan.fee);
  const slip = percent(run.plan.slippage);
  const heldUnits = run.initial / (initialPrice * (1 + slip) * (1 + fee));
  const heldExit = heldUnits * finalPrice * (1 - slip) * (1 - fee);
  const equity = account(run, dataset);
  return {
    symbol: run.symbol, count: end - start + 1, window: run.plan.window,
    first: quote(dataset, run, run.symbol, start).time, last: paperTime(dataset, run),
    roi: equity.roi, pnl: equity.pnl, holdRoi: (heldExit / run.initial - 1) * 100,
    maxDrawdown: run.worstDrawdown, fees: run.fees, trades: run.fills.length, points: run.equity,
    exit: equity.equity, halt: run.halt?.message ?? null,
  };
}

function parsedTime(value) {
  if (/^\d{9,13}$/.test(value)) {
    return value.length <= 10 ? Number(value) * 1000 : Number(value);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = Date.parse(value + 'T00:00:00Z');
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? parsed : NaN;
  }
  return Date.parse(value);
}

function fromRows(rows, symbol, kind, label) {
  if (!assetFor(symbol)) throw Error('Избери поддържан пазар.');
  if (rows.length < 24) throw Error('Нужни са поне 24 валидни свещи.');
  if (rows.length > 5_000) throw Error('Зареди файл с до 5 000 свещи.');
  rows.sort((a, b) => a.time - b.time);
  const used = new Set();
  for (const [index, item] of rows.entries()) {
    const valid = Number.isFinite(item.time) && item.time >= 0
      && [item.open, item.high, item.low, item.close].every(validPrice)
      && item.high >= Math.max(item.open, item.close) && item.low <= Math.min(item.open, item.close)
      && Number.isFinite(item.volume) && item.volume >= 0;
    if (!valid || used.has(item.time)) throw Error('Невалидна или дублирана свещ на ред ' + (index + 2) + '.');
    used.add(item.time);
  }
  const start = Math.min(60, Math.max(20, rows.length - Math.ceil(rows.length / 3)));
  return { kind, label, series: { [symbol]: rows }, start: Math.min(start, rows.length - 2) };
}

// The engine uses one cursor for every position, so align all pairs by UTC day.
export function historicalMarket(feeds) {
  if (!feeds.length) throw Error('Не са налични дневни борсови котировки.');
  const series = {};
  const sources = {};
  const byTime = feeds.map(feed => {
    const pair = feed.symbol + '/EUR';
    if (!assetFor(pair) || feed.currency !== 'EUR') throw Error('Неподдържана пазарна серия.');
    const checked = fromRows([...feed.candles], pair, 'market', feed.source);
    sources[pair] = feed.source + (feed.stale ? ' · архив' : '');
    return new Map(checked.series[pair].map(row => [row.time, row]));
  });
  const dates = [...byTime[0].keys()].filter(time => byTime.every(rows => rows.has(time)));
  if (dates.length < 24) throw Error('Не са налични достатъчно общи пазарни дни.');
  feeds.forEach((feed, index) => {
    series[feed.symbol + '/EUR'] = dates.map(time => byTime[index].get(time));
  });
  // Keep history for backtests and leave up to 30 closed days to replay.
  const start = Math.max(Math.floor(dates.length / 2), dates.length - 31);
  return {
    kind: 'market', label: 'Борсова история · ' + [...new Set(Object.values(sources))].join(', '),
    sources, series, start,
  };
}

export function importCsv(text, symbol) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  const delimiter = lines[0]?.includes(';') ? ';' : ',';
  const fields = line => line.split(delimiter).map(s => s.trim().replace(/^"|"$/g, ''));
  const header = fields(lines[0] ?? '').map(s => s.toLowerCase());
  const timeIndex = header.findIndex(key => ['date', 'time', 'timestamp', 'datetime'].includes(key));
  const indexes = ['open', 'high', 'low', 'close'].map(key => header.indexOf(key));
  if (timeIndex < 0 || indexes.some(n => n < 0)) throw Error('Очакваният заглавен ред е date,open,high,low,close,volume.');
  const volume = header.indexOf('volume');
  const rows = lines.slice(1).map(line => {
    const row = fields(line);
    const number = index => row[index] ? Number(row[index].replace(',', '.')) : NaN;
    const [open, high, low, close] = indexes.map(number);
    return { time: parsedTime(row[timeIndex] || ''), open, high, low, close, volume: volume < 0 ? 0 : number(volume) };
  });
  return fromRows(rows, symbol, 'csv', 'Импорт от CSV');
}

export function importKraken(payload, symbol) {
  const series = Object.entries(payload.result ?? {}).find(([key, value]) => key !== 'last' && Array.isArray(value))?.[1];
  if (payload.error?.length || !series) throw Error('Kraken не върна валидни исторически данни.');
  const rows = series.slice(0, -1).map(row => ({
    time: Number(row[0]) * 1000, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
    close: Number(row[4]), volume: Number(row[6]),
  }));
  return fromRows(rows, symbol, 'kraken', 'История от Kraken');
}

export function exportJournal(state) {
  const fills = new Map(state.fills.map(fill => [fill.orderId, fill]));
  const quoteCsv = value => {
    const text = String(value ?? '');
    return '"' + (typeof value === 'string' && /^[=+\-@]/.test(text) ? "'" + text : text).replace(/"/g, '""') + '"';
  };
  const lines = [['time', 'event', 'order', 'symbol', 'side', 'quantity', 'price_eur', 'fee_eur', 'realized_eur', 'message']];
  for (const event of state.journal) {
    const fill = event.type === 'fill' ? fills.get(event.orderId) : null;
    lines.push([new Date(event.time).toISOString(), event.type, event.orderId, fill?.symbol, fill?.side,
      fill?.quantity, fill?.price, fill?.fee, fill?.realized, event.message]);
  }
  return '\uFEFF' + lines.map(row => row.map(quoteCsv).join(',')).join('\r\n');
}
