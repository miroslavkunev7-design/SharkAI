'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Bell, ChartCandlestick, ChartNoAxesCombined, ChevronRight, ExternalLink, RefreshCw, Search, Star, Trash2, X } from 'lucide-react';
import { usePortfolioPreferences, type SymbolCode } from './portfolio-preferences';
import './portfolio-markets.css';

const assets = { BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana' } as const;
type PreferenceState = ReturnType<typeof usePortfolioPreferences>;
const symbols = Object.keys(assets) as SymbolCode[];
type MarketView = 'watchlist' | 'markets';
type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Market = {
  symbol: SymbolCode; currency: 'EUR'; source: string; sourceUrl: string; candles: Candle[];
  observedAt: number; fetchedAt: number; stale: boolean; session?: Candle; sessionAsOf?: number;
};
type Feed = { loadMarket: (symbol: SymbolCode, options: { signal: AbortSignal; force: boolean }) => Promise<Market> };
type Markets = Partial<Record<SymbolCode, Market>>;
const euro = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR' });
const percent = new Intl.NumberFormat('bg-BG', { style: 'percent', signDisplay: 'exceptZero', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat('bg-BG', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const clock = new Intl.DateTimeFormat('bg-BG', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Sofia' });
const dayMs = 86_400_000;

function quote(market: Market) {
  const last = market.candles[market.candles.length - 1];
  const fresh = market.session && !market.stale && market.sessionAsOf
    && Date.now() - market.sessionAsOf <= 300_000 && Date.now() < market.session.time + dayMs;
  const bar = fresh ? market.session! : last;
  const previous = fresh ? bar.open : market.candles[market.candles.length - 2].close;
  return { price: bar.close, change: bar.close / previous - 1, at: fresh ? market.sessionAsOf! : market.observedAt, session: Boolean(fresh) };
}

function useMarketFeed(feedUrl: string) {
  const [markets, setMarkets] = useState<Markets>({});
  const [failures, setFailures] = useState<SymbolCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    async function getQuotes() {
      try {
        const url = new URL(feedUrl, document.baseURI);
        if (url.origin !== window.location.origin) throw Error('Unsupported market source');
        const feed: Feed = await import(/* webpackIgnore: true */ url.href);
        await Promise.all(symbols.map(async symbol => {
          try {
            const fresh = await feed.loadMarket(symbol, { signal: controller.signal, force: refresh > 0 });
            if (controller.signal.aborted) return;
            setMarkets(items => ({ ...items, [symbol]: fresh }));
            setFailures(items => items.filter(item => item !== symbol));
          } catch {
            if (!controller.signal.aborted) setFailures(items => [...new Set([...items, symbol])]);
          }
        }));
      } catch {
        if (!controller.signal.aborted) setFailures([...symbols]);
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void getQuotes();
    return () => controller.abort();
  }, [feedUrl, refresh]);
  useEffect(() => {
    let last = Date.now();
    function poll() {
      if (!document.hidden && Date.now() - last >= 60_000) { last = Date.now(); setRefresh(value => value + 1); }
    }
    const timer = window.setInterval(poll, 60_000);
    document.addEventListener('visibilitychange', poll);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, []);
  return { markets, failures, loading, refresh: () => setRefresh(value => value + 1) };
}

function Coin({ symbol }: { symbol: SymbolCode }) {
  return <span className={'pfm-coin pfm-' + symbol} aria-hidden="true">{symbol === 'BTC' ? '₿' : symbol === 'ETH'
    ? <svg viewBox="0 0 24 24"><path fill="#e2e7ff" d="m12 1 7 11-7 4-7-4Z"/><path fill="#9aacf5" d="m12 1 7 11-7 4Zm-7 13 7 9v-5Z"/><path fill="#d3dcff" d="m19 14-7 9v-5Z"/></svg>
    : <svg viewBox="0 0 24 24" fill="currentColor"><path d="m6 5-4 4h16l4-4Zm-4 6 4 4h16l-4-4Zm4 6-4 4h16l4-4Z"/></svg>}</span>;
}

function seriesPoints(bars: Candle[], width: number, height: number) {
  const prices = bars.map(bar => bar.close);
  const low = Math.min(...prices), span = Math.max(...prices) - low;
  return prices.map((value, i) => [i * width / Math.max(1, prices.length - 1), span === 0 ? height / 2 : (1 - (value - low) / span) * height]);
}
function Sparkline({ market }: { market: Market }) {
  const points = seriesPoints(market.candles.slice(-14), 84, 25);
  const raised = points[points.length - 1][1] <= points[0][1];
  return <svg viewBox="-2 -3 88 31" className={'pfm-spark ' + (raised ? 'pfm-positive' : 'pfm-negative')} aria-hidden="true">
    <polyline points={points.map(p => p.join(',')).join(' ')} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

function History({ market }: { market: Market }) {
  const [period, setPeriod] = useState(30);
  const [kind, setKind] = useState<'line' | 'candles'>('line');
  const [cursor, setCursor] = useState<number | null>(null);
  const fillId = useId();
  const last = market.candles[market.candles.length - 1];
  const bars = market.candles.filter(bar => bar.time >= last.time - (period - 1) * dayMs);
  const first = bars[0];
  const low = Math.min(...bars.map(b => kind === 'line' ? b.close : b.low));
  const high = Math.max(...bars.map(b => kind === 'line' ? b.close : b.high));
  const width = 570, height = 145, inset = 6;
  const x = (i: number) => inset + i * (width - 2 * inset) / Math.max(1, bars.length - 1);
  const y = (n: number) => high === low ? height / 2 : inset + (high - n) * (height - 2 * inset) / (high - low);
  const path = bars.map((b, i) => (i ? 'L' : 'M') + x(i).toFixed(2) + ',' + y(b.close).toFixed(2)).join('');
  const active = cursor == null ? null : bars[Math.min(cursor, bars.length - 1)];
  const changed = last.close / first.open - 1;
  const selectedIndex = cursor == null ? null : Math.min(cursor, bars.length - 1);
  return <div className="pfm-history">
    <div className="pfm-chart-head"><div role="group" aria-label="Период">{[7,30,90].map(value =>
      <button key={value} type="button" aria-pressed={period === value} onClick={() => { setPeriod(value); setCursor(null); }}>{value}д</button>)}</div>
      <div role="group" aria-label="Вид графика"><button type="button" aria-label="Линия" aria-pressed={kind === 'line'} onClick={() => setKind('line')}><ChartNoAxesCombined size={17}/></button>
        <button type="button" aria-label="Свещи" aria-pressed={kind === 'candles'} onClick={() => setKind('candles')}><ChartCandlestick size={17}/></button></div>
    </div>
    <div className="pfm-readout">{active ? date.format(active.time) + ' · ' + euro.format(active.close) : 'Промяна за ' + period + ' дни'} {!active && <b className={changed >= 0 ? 'pfm-positive' : 'pfm-negative'}>{percent.format(changed)}</b>}</div>
    <svg className="pfm-chart" viewBox={'0 0 ' + width + ' ' + height} preserveAspectRatio="none" role="img" aria-label={assets[market.symbol] + ', дневни цени за ' + period + ' дни. Промяна ' + percent.format(changed)}
      onPointerMove={event => {
        const box = event.currentTarget.getBoundingClientRect();
        const fraction = ((event.clientX - box.left) / box.width * width - inset) / (width - 2 * inset);
        setCursor(Math.max(0, Math.min(bars.length - 1, Math.round(fraction * (bars.length - 1)))));
      }} onPointerLeave={() => setCursor(null)}>
      <defs><linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox"><stop stopColor="#69b5ff" stopOpacity=".33"/><stop offset="1" stopColor="#8f7fff" stopOpacity=".012"/></linearGradient></defs>
      {[.2,.5,.8].map(v => <line key={v} x1="0" x2={width} y1={height*v} y2={height*v} stroke="#849abe35" strokeDasharray="3 6"/>)}
      {kind === 'line' ? <>
        <path d={path + 'L' + x(bars.length - 1) + ',' + height + 'L' + inset + ',' + height + 'Z'} fill={'url(#' + fillId + ')'}/>
        <path d={path} stroke="#81b8ff" fill="none" strokeWidth="2.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round"/>
      </> : bars.map((bar, i) => {
        const body = Math.min(14, (width - 2 * inset)/bars.length*.60);
        const color = bar.close >= bar.open ? '#76e0c2' : '#ff9db6';
        return <g key={bar.time} stroke={color} fill={color}><line x1={x(i)} x2={x(i)} y1={y(bar.high)} y2={y(bar.low)}/>
          <rect x={x(i) - body/2} width={body} y={Math.min(y(bar.open),y(bar.close))} height={Math.max(1, Math.abs(y(bar.open)-y(bar.close)))}/></g>;
      })}
      {selectedIndex != null && <line x1={x(selectedIndex)} x2={x(selectedIndex)} y1="0" y2={height} stroke="#f0f3ff" strokeDasharray="3 4"/>}
    </svg>
    <div className="pfm-axis"><span>{date.format(first.time)}</span><span>{date.format(last.time)}</span></div>
    <details className="pfm-data"><summary>Дневни котировки</summary><div tabIndex={0} role="region" aria-label="Таблица с дневните цени в евро">
      <table><thead><tr><th>Дата UTC</th><th>Отваряне</th><th>Максимум</th><th>Минимум</th><th>Затваряне</th></tr></thead>
        <tbody>{bars.slice().reverse().map(b => <tr key={b.time}><th scope="row">{date.format(b.time)}</th>{[b.open,b.high,b.low,b.close].map((v,i) => <td key={i}>{euro.format(v)}</td>)}</tr>)}</tbody></table>
    </div></details>
  </div>;
}

function AssetDetails({ symbol, market, failed, loading, preferences, refresh, close }: {
  symbol: SymbolCode; market?: Market; failed: boolean; loading: boolean; preferences: PreferenceState; refresh: () => void; close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [target, setTarget] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const price = market && quote(market);
  const { prefs, ready, setStar, setAlert } = preferences;
  const rule = prefs.alerts[symbol];
  const star = prefs.stars.includes(symbol);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return <dialog className="pfm-dialog" ref={dialog} aria-labelledby={heading} onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === e.currentTarget) {
    const bounds = e.currentTarget.getBoundingClientRect();
    if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) close();
  } }}>
    <div className="pfm-sheet-head"><div className="pfm-asset-id"><Coin symbol={symbol}/><div><h3 id={heading}>{assets[symbol]}</h3><span>{symbol} / EUR</span></div></div>
      <div className="pfm-tools"><button type="button" aria-label="Обнови котировката" disabled={loading} onClick={refresh}><RefreshCw size={16}/></button><button type="button" aria-label={star ? 'Премахни от наблюдение' : 'Добави за наблюдение'} aria-pressed={star} disabled={!ready} onClick={() => setStar(symbol, !star)}><Star size={19} fill={star ? 'currentColor' : 'none'}/></button>
        <button type="button" aria-label="Затвори детайлите" onClick={close}><X size={20}/></button></div></div>
    {market && price ? <>
      <div className="pfm-price">{euro.format(price.price)}</div>
      <div className="pfm-since"><b className={price.change >= 0 ? 'pfm-positive' : 'pfm-negative'}>{percent.format(price.change)}</b> {price.session ? 'от отварянето в 00:00 UTC' : 'спрямо предходното затваряне'}</div>
      <History market={market}/>
      <div className="pfm-attribution"><a href={market.sourceUrl} target="_blank" rel="noreferrer">{market.source}</a><span>{market.stale || failed ? 'Архивна котировка' : price.session ? 'Котировка' : 'Дневно затваряне'} · {clock.format(price.at)} (София)</span></div>
    </> : <p className="pfm-empty" role="status">{loading ? 'Зареждане на котировката…' : 'Котировката е временно недостъпна.'}</p>}
    {preferences.notice && <p className="pfm-notice" role="status">{preferences.notice}</p>}
    <div className="pfm-trade"><a href={'https://pro.kraken.com/app/trade/' + symbol.toLowerCase() + '-eur'} target="_blank" rel="noopener noreferrer">Купи или продай в Kraken <ExternalLink size={16} aria-hidden="true"/></a>
      <small>Поръчката се потвърждава в твоя Kraken акаунт.</small></div>
    <section className="pfm-alert"><div className="pfm-alert-head"><span><Bell size={17}/> Известие за цена</span>
      {!rule && !editing && <button type="button" disabled={!ready || !price?.session || failed} onClick={() => setEditing(true)}>Добави</button>}</div>
      {rule ? <div className="pfm-rule"><span>При цена {rule.direction === 'above' ? 'над или равна на' : 'под или равна на'} <b>{euro.format(rule.target)}</b><small>{rule.reachedAt ? 'Достигната на ' + clock.format(rule.reachedAt) + ' (София)' : 'Активно, докато тази страница е отворена.'}</small></span>
        <button type="button" aria-label="Изтрий известието" disabled={!ready} onClick={() => setAlert(symbol, null)}><Trash2 size={16}/></button></div>
        : editing ? <form onSubmit={e => {
          e.preventDefault();
          const amount = Number(target.replace(',', '.'));
          if (!ready || !price?.session || failed || !Number.isFinite(amount) || amount <= 0 || amount === price.price) {
            setError('Въведи положителна целева цена, различна от текущата. Нужна е актуална котировка.'); return;
          }
          setAlert(symbol, { target: amount, direction: amount > price.price ? 'above' : 'below', createdAt: Date.now() });
          setTarget(''); setError(''); setEditing(false);
        }}><label>Целева цена в евро<input autoFocus inputMode="decimal" type="number" step="any" min="0.00000001" required value={target} onChange={e => setTarget(e.target.value)}/></label>
          <button type="submit" disabled={!ready}>Запази</button><button type="button" onClick={() => {setEditing(false); setError('');}}>Отказ</button>
          {error && <small role="alert">{error}</small>}</form>
        : <p>{price?.session && !failed ? 'Цената се проверява, докато страницата е отворена.' : 'За създаване е нужна актуална котировка.'}</p>}
    </section>
  </dialog>;
}

export function PortfolioMarkets({ initialView = 'watchlist', feedUrl = '/investment-lab/market-feed.mjs', syncPreferences = false }: { initialView?: MarketView; feedUrl?: string; syncPreferences?: boolean }) {
  const preferences = usePortfolioPreferences(syncPreferences);
  const { prefs, ready, notice, setStar, markReached } = preferences;
  const [tab, setTab] = useState<MarketView | null>(null);
  const view = tab ?? (initialView === 'watchlist' && !prefs.stars.length ? 'markets' : initialView);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SymbolCode | null>(null);
  const { markets, failures, loading, refresh } = useMarketFeed(feedUrl);
  const reported = useRef<Partial<Record<SymbolCode, string>>>({});
  useEffect(() => {
    if (!ready) return;
    for (const symbol of symbols) {
      const market = markets[symbol], rule = prefs.alerts[symbol];
      if (!market || !rule || rule.reachedAt || failures.includes(symbol)) continue;
      const q = quote(market);
      if (!q.session || q.at < rule.createdAt || (rule.direction === 'above' ? q.price < rule.target : q.price > rule.target)) continue;
      const event = [preferences.scope, rule.createdAt, q.at].join('/');
      if (reported.current[symbol] === event) continue;
      reported.current[symbol] = event;
      markReached(symbol, rule.createdAt, q.at);
    }
  }, [markets, failures, prefs, ready, preferences.scope, markReached]);
  const heading = useId();
  const shown = symbols.filter(s => (view === 'markets' || prefs.stars.includes(s)) && (assets[s] + ' ' + s + ' EUR').toLowerCase().includes(query.toLowerCase().trim()));
  const reached = symbols.filter(s => prefs.alerts[s]?.reachedAt);
  return <section className="pfm" aria-labelledby={heading}>
    <div className="pfm-header"><h2 id={heading}>Пазарен обзор</h2><button className="pfm-tool" type="button" aria-label="Обнови котировките" title="Обнови котировките" disabled={loading} onClick={refresh}><RefreshCw size={17} className={loading ? 'pfm-spinning' : ''}/></button></div>
    <div className="pfm-controls"><div className="pfm-tabs" role="group" aria-label="Списък с активи">
      <button type="button" aria-pressed={view === 'markets'} onClick={() => setTab('markets')}>Всички</button>
      <button type="button" aria-pressed={view === 'watchlist'} onClick={() => setTab('watchlist')}><Star size={13}/> Следени{prefs.stars.length > 0 && ' · ' + prefs.stars.length}</button>
    </div><label className="pfm-search"><Search size={15}/><input aria-label="Търсене на актив" placeholder="Търси актив" value={query} type="search" onChange={e => setQuery(e.target.value)}/></label></div>
    <ul className="pfm-list">{shown.map(symbol => {
      const data = markets[symbol], price = data && quote(data), starred = prefs.stars.includes(symbol);
      return <li key={symbol}><button type="button" className="pfm-asset" aria-label={'Детайли за ' + assets[symbol]} onClick={() => setSelected(symbol)}><Coin symbol={symbol}/>
        <span className="pfm-name"><strong>{assets[symbol]}</strong><small>{symbol} / EUR</small></span>{data && <Sparkline market={data}/>}
        <span className="pfm-quote"><strong>{price ? euro.format(price.price) : '—'}</strong>
          {price ? <small className={price.change >= 0 ? 'pfm-positive' : 'pfm-negative'}>{percent.format(price.change)}{(data?.stale || failures.includes(symbol)) && ' · архив'}</small>
            : <small>{failures.includes(symbol) ? 'Недостъпна' : 'Зареждане…'}</small>}</span>
      </button><button type="button" className="pfm-star" aria-pressed={starred} aria-label={(starred ? 'Премахни ' : 'Добави ') + assets[symbol] + (starred ? ' от наблюдение' : ' за наблюдение')} disabled={!ready} onClick={() => { setTab(view); setStar(symbol, !starred); }}><Star size={17} fill={starred ? 'currentColor' : 'none'}/></button></li>;
    })}</ul>
    {!shown.length && <div className="pfm-empty">{query ? 'Няма активи с това име или символ.' : 'Списъкът за наблюдение е празен.'}
      {view === 'watchlist' && <button type="button" onClick={() => { setTab('markets'); setQuery(''); }}>Разгледай активите <ChevronRight size={14}/></button>}</div>}
    {notice && <p className="pfm-notice" role="status">{notice}</p>}
    {!!reached.length && <div className="pfm-reached" role="status">{reached.map(s => <button type="button" key={s} onClick={() => setSelected(s)}><Bell size={14}/>{s} достигна {euro.format(prefs.alerts[s]!.target)}</button>)}</div>}
    {selected && <AssetDetails key={selected} symbol={selected} market={markets[selected]} failed={failures.includes(selected)} loading={loading} preferences={preferences} refresh={refresh} close={() => setSelected(null)}/>}
  </section>;
}
