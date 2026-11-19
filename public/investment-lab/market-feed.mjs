const DAY = 86_400_000;
const MINUTE = 60_000;
const HISTORY_DAYS = 365;
const KRAKEN_PAIRS = { BTC: 'XBTEUR', ETH: 'ETHEUR', SOL: 'SOLEUR' };
const localCache = new Map();

function marketUrl(symbol, source) {
  if (source === 'Kraken') return 'https://api.kraken.com/0/public/OHLC?pair=' + KRAKEN_PAIRS[symbol] + '&interval=1440';
  if (source === 'Coinbase Exchange') return 'https://api.exchange.coinbase.com/products/' + symbol + '-EUR/candles?granularity=86400';
  throw new Error('Непознат източник на пазарни данни.');
}

function asNumber(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return NaN;
  return Number(value);
}

function candle(values) {
  const [time, open, high, low, close, volume] = values.map(asNumber);
  if (!Number.isSafeInteger(time) || time < Date.UTC(2009, 0, 1) || time % DAY !== 0 ||
      ![open, high, low, close, volume].every(Number.isFinite) ||
      low <= 0 || low > Math.min(open, close) || high < Math.max(open, close) || volume < 0) {
    throw new Error('Невалидни дневни пазарни данни.');
  }
  return { time, open, high, low, close, volume };
}

function fromProvider(data, source) {
  if (source === 'Coinbase Exchange' && Array.isArray(data)) {
    return data.map(([seconds, low, high, open, close, volume]) =>
      candle([seconds * 1000, open, high, low, close, volume]));
  }
  if (source === 'Kraken' && data?.error?.length === 0 && data.result) {
    const rows = Object.entries(data.result).find(([key, rows]) => key !== 'last' && Array.isArray(rows))?.[1];
    if (rows) return rows.map(([seconds, open, high, low, close, , volume]) =>
      candle([seconds * 1000, open, high, low, close, volume]));
  }
  throw new Error('Липсват данни от борсата.');
}

function prepare(symbol, source, bars, fetchedAt, providerAsOf) {
  if (!Number.isFinite(fetchedAt) || fetchedAt > Date.now() + MINUTE ||
      !Number.isFinite(providerAsOf) || providerAsOf > fetchedAt + MINUTE) {
    throw new Error('Невалиден час на пазарните данни.');
  }
  const sessionStart = Math.floor(providerAsOf / DAY) * DAY;
  const sorted = bars.sort((a, b) => a.time - b.time);
  if (sorted.some((bar, i) => (i && bar.time === sorted[i - 1].time) || bar.time > sessionStart)) {
    throw new Error('Несъответствие в датите на котировките.');
  }
  const candles = sorted.filter(bar => bar.time < sessionStart).slice(-HISTORY_DAYS);
  if (candles.length < 90) throw new Error('Недостатъчна история на котировките.');
  const session = sorted.at(-1).time === sessionStart ? sorted.at(-1) : undefined;
  return {
    symbol, currency: 'EUR', source, sourceUrl: marketUrl(symbol, source), candles,
    // The close is observed at the end of its UTC trading day.
    observedAt: candles.at(-1).time + DAY, fetchedAt,
    ...(session ? { session, sessionAsOf: providerAsOf } : {}),
  };
}

async function jsonRequest(url, signal) {
  if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 6000);
  try {
    const response = await fetch(url, { credentials: 'omit', signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error('Източникът е временно недостъпен.');
    const data = await response.json();
    const fetchedAt = Date.now();
    const serverTime = Date.parse(response.headers.get('date'));
    const age = Number(response.headers.get('age')) || 0;
    const asOf = Math.min(fetchedAt, Number.isFinite(serverTime) ? serverTime : fetchedAt - Math.max(age, 0) * 1000);
    return { data, fetchedAt, asOf };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function cachedMarket(symbol) {
  if (localCache.has(symbol)) return localCache.get(symbol);
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem('sharkai.market.v1.' + symbol) || 'null');
    if (!saved || saved.symbol !== symbol || saved.currency !== 'EUR' || !Array.isArray(saved.candles)) return;
    const fields = bar => [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume];
    const history = saved.candles.map(bar => candle(fields(bar)));
    if (saved.session) history.push(candle(fields(saved.session)));
    const checked = prepare(symbol, saved.source, history, saved.fetchedAt, saved.sessionAsOf || saved.fetchedAt);
    localCache.set(symbol, checked);
    return checked;
  } catch { /* A missing or unreadable browser cache can be rebuilt from the exchange. */ }
}

function remember(data) {
  localCache.set(data.symbol, data);
  try { globalThis.localStorage?.setItem('sharkai.market.v1.' + data.symbol, JSON.stringify(data)); }
  catch { /* Browsers with storage disabled still have an in-memory cache. */ }
}

function present(data, cached, unavailable = false) {
  const now = Date.now();
  const today = Math.floor(now / DAY) * DAY;
  const { session, sessionAsOf, ...history } = data;
  const stale = unavailable || history.observedAt < today;
  const recentSession = !stale && session?.time === today && now - sessionAsOf <= 5 * MINUTE;
  return { ...history, cached, stale, ...(recentSession ? { session, sessionAsOf } : {}) };
}

let archive;
async function archivedMarket(symbol, signal) {
  if (!archive) archive = (await jsonRequest(new URL('./market-snapshot.json', import.meta.url), signal)).data;
  const record = archive.markets[symbol];
  return prepare(symbol, archive.source, record.candles.map(candle), record.fetchedAt, record.fetchedAt);
}

/** Ascending closed UTC EUR candles; optional session is the current observed, unfinished candle. */
export async function loadMarket(input, { signal, force = false } = {}) {
  const symbol = String(input).trim().toUpperCase().replace(/\/EUR$/, '');
  if (!Object.hasOwn(KRAKEN_PAIRS, symbol)) throw new Error('Неподдържан пазар.');
  if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
  const previous = cachedMarket(symbol);
  const now = Date.now();
  if (!force && previous && now - previous.fetchedAt < MINUTE && now >= previous.fetchedAt && !present(previous, true).stale) {
    return present(previous, true);
  }

  let best = previous;
  for (const source of ['Kraken', 'Coinbase Exchange']) {
    try {
      const { data, fetchedAt, asOf } = await jsonRequest(marketUrl(symbol, source), signal);
      const result = prepare(symbol, source, fromProvider(data, source), fetchedAt, asOf);
      const market = present(result, false);
      if (!market.stale) {
        remember(result);
        return market;
      }
      if (!best || result.observedAt > best.observedAt) best = result;
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
    }
  }
  try {
    const bundled = await archivedMarket(symbol, signal);
    if (!best || bundled.observedAt > best.observedAt) best = bundled;
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
  }
  if (best) return present(best, true, true);
  throw new Error('Борсовата история за ' + symbol + '/EUR в момента е недостъпна.');
}
