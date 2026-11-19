import { loadMarket } from './market-feed.mjs';

const assets = {
  BTC: { name: 'Bitcoin', mark: '₿' },
  ETH: { name: 'Ethereum', mark: 'Ξ' },
  SOL: { name: 'Solana', mark: '◎' },
};
const money = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR' });
const axisPrice = new Intl.NumberFormat('bg-BG', { maximumFractionDigits: 1 });
const changeFormat = new Intl.NumberFormat('bg-BG', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' });
const date = new Intl.DateTimeFormat('bg-BG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const axisDate = new Intl.DateTimeFormat('bg-BG', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
const localTime = new Intl.DateTimeFormat('bg-BG', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Sofia' });
const byId = id => document.getElementById(id);
const ns = 'http://www.w3.org/2000/svg';
const day = 86_400_000;

let symbol = 'BTC';
let range = 30;
let market;
let controller;
let bars = [];
let chartGeometry;

function put(id, value) { byId(id).textContent = value; }
function quoteStatus(message, warning = false) {
  put('freshness', message);
  byId('freshness').dataset.tone = warning ? 'warning' : 'normal';
}
function percentAt(id, fraction) {
  const target = byId(id);
  target.textContent = changeFormat.format(fraction);
  target.dataset.sign = fraction > 0 ? 'up' : fraction < 0 ? 'down' : 'flat';
}
function notice(message) {
  byId('plot-notice').hidden = !message;
  byId('plot-notice').querySelector('p').textContent = message || '';
  byId('chart').toggleAttribute('hidden', Boolean(message));
}

function reset() {
  bars = [];
  chartGeometry = null;
  for (const id of ['close-price','stat-high','stat-low','stat-change','source-name','last-bar']) put(id,'—');
  for (const id of ['price-change','stat-change']) delete byId(id).dataset.sign;
  put('price-change','');
  put('price-label','Последна дневна цена на затваряне');
  put('series-span','Дневни свещи · UTC');
  byId('bar-table').replaceChildren();
  byId('chart').replaceChildren();
  byId('hover-card').hidden = true;
}

function svgElement(tag, attributes, label) {
  const element = document.createElementNS(ns,tag);
  for (const [key,value] of Object.entries(attributes)) element.setAttribute(key,String(value));
  if (label !== undefined) element.textContent = label;
  return element;
}

function drawChart() {
  const svg = byId('chart');
  byId('hover-card').hidden = true;
  if (!bars.length || svg.hasAttribute('hidden')) return;
  const {width,height} = byId('plot').getBoundingClientRect();
  if (!width || !height) return;
  const left = 2, top = 10;
  const plotWidth = width - left - (width < 360 ? 49 : 63);
  const plotHeight = height - top - 26;
  const min = Math.min(...bars.map(bar => bar.low));
  const max = Math.max(...bars.map(bar => bar.high));
  const pad = Math.max((max-min)*.09, max*.0005);
  const ceiling = max + pad;
  const floor = Math.max(0,min - pad);
  const y = price => top + (ceiling-price)/(ceiling-floor)*plotHeight;
  const step = plotWidth/bars.length;
  const x = index => left + (index+.5)*step;
  const candleWidth = Math.max(1,Math.min(14,step*.63));
  const group = document.createDocumentFragment();
  for (let row = 0; row <= 4; row++) {
    const price = ceiling - (ceiling-floor)*row/4;
    group.append(svgElement('line',{x1:left,x2:left+plotWidth,y1:y(price),y2:y(price),stroke:'#34465e','stroke-dasharray':'3 5'}));
    group.append(svgElement('text',{x:left+plotWidth+6,y:y(price)+4},axisPrice.format(price)));
  }
  const ticks = width < 440 ? 3 : 5;
  for (let i = 0; i < ticks; i++) {
    const index = Math.round(i*(bars.length-1)/(ticks-1));
    group.append(svgElement('text',{x:i===0?left:i===ticks-1?left+plotWidth:x(index),y:height-2,'text-anchor':i===0?'start':i===ticks-1?'end':'middle'},axisDate.format(bars[index].time)));
  }
  bars.forEach((bar,i) => {
    const color = bar.close >= bar.open ? '#61dfbe' : '#fd96a9';
    group.append(svgElement('line',{x1:x(i),x2:x(i),y1:y(bar.high),y2:y(bar.low),stroke:color,'stroke-width':1.2}));
    group.append(svgElement('rect',{x:x(i)-candleWidth/2,y:Math.min(y(bar.open),y(bar.close)),width:candleWidth,height:Math.max(1.1,Math.abs(y(bar.close)-y(bar.open))),fill:color,rx:Math.min(1,candleWidth*.12)}));
  });
  const cursor = svgElement('line',{x1:0,x2:0,y1:top,y2:plotHeight+top,stroke:'#c2dcfa','stroke-dasharray':'3 3',visibility:'hidden'});
  group.append(cursor);
  svg.setAttribute('viewBox','0 0 '+width+' '+height);
  svg.setAttribute('aria-label',symbol+' / EUR, '+date.format(bars[0].time)+' – '+date.format(bars.at(-1).time)+'. '+bars.length+' приключили дневни свещи. Цените са достъпни и в таблицата.');
  svg.replaceChildren(group);
  chartGeometry = {step,left,plotWidth,cursor,x};
}

function marketTable() {
  const rows = bars.slice().reverse().map(bar => {
    const row = document.createElement('tr');
    for (const text of [date.format(bar.time),...['open','high','low','close'].map(key=>money.format(bar[key]))]) {
      const cell = document.createElement('td');
      cell.textContent = text;
      row.append(cell);
    }
    return row;
  });
  byId('bar-table').replaceChildren(...rows);
}

function renderRange() {
  put('period-caption',range+' дни');
  for (const button of document.querySelectorAll('[data-range]')) button.setAttribute('aria-pressed',String(Number(button.dataset.range)===range));
  if (!market) return;
  const last = market.candles.at(-1);
  bars = market.candles.filter(bar => bar.time >= last.time - (range-1)*day);
  const first = bars[0];
  put('stat-high',money.format(Math.max(...bars.map(bar=>bar.high))));
  put('stat-low',money.format(Math.min(...bars.map(bar=>bar.low))));
  percentAt('stat-change',last.close/first.open-1);
  byId('stat-change').title = 'От първото отваряне до последното затваряне в избрания период.';
  put('series-span',axisDate.format(first.time)+' – '+date.format(last.time)+' · UTC');
  notice('');
  marketTable();
  drawChart();
}

function renderQuote() {
  const last = market.candles.at(-1);
  const previous = market.candles.at(-2);
  const openSession = market.session && !market.stale && Date.now() - market.sessionAsOf <= 300000
    && market.session.time === Math.floor(Date.now()/day)*day;
  if (openSession) {
    put('close-price',money.format(market.session.close));
    percentAt('price-change',market.session.close/market.session.open-1);
    put('price-label','Към '+localTime.format(market.sessionAsOf)+' ч. (София) · промяна от отварянето в 00:00 UTC');
  } else {
    put('close-price',money.format(last.close));
    percentAt('price-change',last.close/previous.close-1);
    put('price-label','Затваряне на '+date.format(last.time)+' · спрямо предходното дневно затваряне');
  }
}

function renderMarket() {
  renderQuote();
  const sourceLink = document.createElement('a');
  sourceLink.href = market.sourceUrl;
  sourceLink.rel = 'noopener noreferrer';
  sourceLink.target = '_blank';
  sourceLink.textContent = market.source;
  sourceLink.setAttribute('aria-label','Отвори данните от '+market.source+' в нов раздел');
  byId('source-name').replaceChildren(sourceLink);
  put('last-bar',date.format(market.candles.at(-1).time));
  const fetched = localTime.format(market.fetchedAt)+' ч. (София)';
  if (market.stale) quoteStatus('Архивни данни. Последно извличане на '+fetched+'.',true);
  else quoteStatus((market.cached ? 'Запазени данни от ' : 'Последно извличане на ') + fetched+'.');
  renderRange();
}

async function refresh(force = false) {
  controller?.abort();
  const request = new AbortController();
  controller = request;
  const requested = symbol;
  const asset = assets[requested];
  put('asset-mark',asset.mark);
  byId('asset-mark').dataset.coin = requested;
  put('instrument-title',asset.name);
  put('instrument-pair',requested+' / EUR');
  for (const button of document.querySelectorAll('[data-symbol]')) button.setAttribute('aria-pressed',String(button.dataset.symbol===requested));
  if (!market) {
    reset();
    notice('Зареждане на котировките…');
  }
  quoteStatus('Свързване с източника…');
  byId('refresh').disabled = true;
  try {
    const result = await loadMarket(requested,{signal:request.signal,force});
    if (request!==controller) return;
    market = result;
    renderMarket();
  } catch {
    if (request!==controller) return;
    if (market) {
      market = {...market,stale:true};
      renderMarket();
    } else {
      reset();
      notice('Котировките са временно недостъпни.');
      quoteStatus('Връзката с източника е прекъсната. Опитай с „Обнови данните“.',true);
    }
  } finally {
    if (request===controller) byId('refresh').disabled = false;
  }
}

for (const button of document.querySelectorAll('[data-symbol]')) button.addEventListener('click',() => {
  if (button.dataset.symbol===symbol) return;
  symbol = button.dataset.symbol;
  market = undefined;
  refresh();
});
for (const button of document.querySelectorAll('[data-range]')) button.addEventListener('click',() => {
  range = Number(button.dataset.range);
  renderRange();
});
byId('refresh').addEventListener('click',()=>refresh(true));
new ResizeObserver(drawChart).observe(byId('plot'));

function clearCursor() {
  byId('hover-card').hidden = true;
  chartGeometry?.cursor.setAttribute('visibility','hidden');
}
byId('chart').addEventListener('pointermove',event => {
  if (!bars.length || !chartGeometry) return;
  const {left,plotWidth,step,cursor,x} = chartGeometry;
  const position = event.clientX - byId('chart').getBoundingClientRect().left - left;
  if (position < 0 || position > plotWidth) return clearCursor();
  const i = Math.min(bars.length-1,Math.floor(position/step));
  const bar = bars[i];
  cursor.setAttribute('x1',x(i));
  cursor.setAttribute('x2',x(i));
  cursor.setAttribute('visibility','visible');
  put('hover-card',date.format(bar.time)+' · затваряне '+money.format(bar.close));
  byId('hover-card').hidden = false;
});
byId('chart').addEventListener('pointerleave',clearCursor);
byId('chart').addEventListener('pointercancel',clearCursor);
byId('chart').addEventListener('pointerup',event=>{ if (event.pointerType!=='mouse') clearCursor(); });

let lastPoll = 0;
function checkQuotes() {
  if (document.hidden || byId('refresh').disabled) return;
  if (Date.now() - lastPoll >= 60000) {
    lastPoll = Date.now();
    refresh();
  }
}
document.addEventListener('visibilitychange',checkQuotes);
window.setInterval(checkQuotes,60000);
lastPoll = Date.now();
refresh();
