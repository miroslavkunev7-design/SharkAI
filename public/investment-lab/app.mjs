import {
  ASSETS, DEFAULT_PLAN, scenarioData, initSession, account, quote, paperTime,
  selectMarket, configure, previewOrder, submitOrder, cancelOrder, analysis,
  hasNext, step, backtest, importCsv, historicalMarket, assetFor, exportJournal,
} from './engine.mjs';
import { mountWeek } from './weekly-ui.mjs';
import { loadMarket } from './market-feed.mjs';

const STORAGE = 'sharkai.investments.preview.v1';
const $ = (selector, root = document) => root.querySelector(selector);
const all = (selector, root = document) => [...root.querySelectorAll(selector)];
const safe = value => String(value ?? '').replace(/[&<>"']/g, character => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
));
const euros = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR' });
const decimal = new Intl.NumberFormat('bg-BG', { maximumFractionDigits: 8 });
const shortNumber = new Intl.NumberFormat('bg-BG', { maximumFractionDigits: 1, notation: 'compact' });
const date = new Intl.DateTimeFormat('bg-BG', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const compactDate = new Intl.DateTimeFormat('bg-BG', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
const money = value => euros.format(Math.abs(value) < 0.005 ? 0 : value);
const percent = value => new Intl.NumberFormat('bg-BG', { minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(Math.abs(value) < 0.005 ? 0 : value) + '%';
const signed = (value, format = money) => (value > 0.005 ? '+' : '') + format(value);
const tone = value => value > 0.005 ? 'up' : value < -0.005 ? 'down' : '';
const statuses = { pending: 'Чакаща', filled: 'Изпълнена', cancelled: 'Отменена', rejected: 'Отхвърлена' };
const events = { system: 'Сметка', order: 'Поръчка', fill: 'Изпълнение', risk: 'Риск', cancelled: 'Отмяна', settings: 'План' };
const HELP = 'Опитай „портфейл“, „анализ“, „риск“, „купи за 100 евро“, „продай всичко“, „седмична цел“, „цел 2%“, „пусни бек-тест“ или „пауза“.';
const initialChat = [{ role: 'agent', text: 'Здравей! Виртуалната ти сметка е готова. Мога да измеря движението на пазара, да подготвя поръчка или да тествам стратегия. ' + HELP }];

const icons = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  wallet: '<path d="M20 8V6a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h13a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H6a3 3 0 0 1-3-3V7"/><path d="M16 13h5v3h-5a1.5 1.5 0 1 1 0-3Z"/>',
  strategy: '<path d="M3 18l6-6 4 4 8-9"/><path d="M16 7h5v5"/>',
  journal: '<path d="M6 4h12a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/>',
  shield: '<path d="M12 22s7-3.5 7-10V5l-7-3-7 3v7c0 6.5 7 10 7 10Z"/><path d="m9 12 2 2 4-4"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  arrow: '<path d="M3 12h17m-7-7 7 7-7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  activity: '<path d="M2 12h5l3-7 4 14 3-7h5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  next: '<path d="m5 5 10 7-10 7zM19 5v14"/>',
  play: '<path d="m7 4 13 8-13 8z"/>',
  pause: '<path d="M9 5v14m6-14v14"/>',
  spark: '<path d="M12 2v4m0 12v4M2 12h4m12 0h4M5 5l3 3m8 8 3 3M19 5l-3 3M8 16l-3 3"/><circle cx="12" cy="12" r="3"/>',
  send: '<path d="M22 2 9 15m13-13-8 20-4-8-8-4z"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  eye: '<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>',
};
function icon(name) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (icons[name] || '') + '</svg>';
}
function iconElement(name) {
  return '<i data-icon="' + name + '">' + icon(name) + '</i>';
}

let dataset;
let state;
let messages = initialChat;
let range = 30;
let currentView = 'overview';
let ticker = null;
let draft = null;
let orderContext = null;
let liveSocket = null;
let liveTimeout = null;
let livePrices = {};
let liveMode = 'off';
let dragIndex = null;
let toastTimer = 0;
let backtestResult = null;
let savedLocally = true;
let checkedSource = null;
let weeklyPane = null;

function restore() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE) || 'null');
    if (!stored || stored.version !== 1) return;
    const source = stored.dataset?.kind === 'scenario' ? scenarioData(stored.dataset.scenario) : stored.dataset;
    const next = stored.state;
    if (!source?.series?.[next?.symbol]?.[next.cursor] || !Number.isFinite(next.cash)
      || !next.plan || !Array.isArray(next.fills) || !Array.isArray(next.orders)
      || !Array.isArray(next.journal) || !next.positions || !Array.isArray(next.equity)) return;
    account(next, source);
    dataset = source;
    state = next;
    if (Array.isArray(stored.messages)) messages = stored.messages.filter(
      item => ['user', 'agent'].includes(item.role) && typeof item.text === 'string'
    ).slice(-60);
    return true;
  } catch {
    return false;
  }
}

function save() {
  try {
    const source = dataset.kind === 'scenario' ? { kind: dataset.kind, scenario: dataset.scenario } : dataset;
    localStorage.setItem(STORAGE, JSON.stringify({ version: 1, dataset: source, state, messages: messages.slice(-60) }));
    savedLocally = true;
  } catch {
    savedLocally = false;
  }
}

function showToast(text, error = false) {
  const toast = $('#toast');
  toast.textContent = text;
  toast.classList.toggle('error', error);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3900);
}

function formStatus(selector, text, error = false) {
  const output = $(selector);
  output.textContent = text;
  output.classList.toggle('error', error);
}

function text(selector, value, color = '') {
  const el = $(selector);
  el.textContent = value;
  for (const className of ['up', 'down', 'amber']) el.classList.toggle(className, className === color);
}

function datasetLabel() {
  if (dataset.kind === 'market') return 'Борсова история · ' + dataset.sources[state.symbol];
  if (dataset.kind !== 'scenario') return dataset.label;
  return { base: 'Демо сценарий', volatile: 'Демо · волатилност', down: 'Демо · спад' }[dataset.scenario] || 'Демо сценарий';
}

function showView(view) {
  if (!$('[data-pane="' + view + '"]')) return;
  currentView = view;
  document.body.classList.toggle('week-active', view === 'weekly');
  for (const pane of all('[data-pane]')) pane.hidden = pane.dataset.pane !== view;
  for (const button of all('.navigation [data-view]')) {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (view === 'strategy') updatePlanFields();
  if (view === 'weekly') weeklyPane?.open();
  render();
  if (view === 'overview') renderChat();
  if (window.scrollY > 90) window.scrollTo(0, 0);
}

function marketOptions(element, pairs, selected) {
  element.replaceChildren(...pairs.map(symbol => new Option(symbol, symbol, false, symbol === selected)));
}

function updateMarkets() {
  const pairs = Object.keys(dataset.series);
  marketOptions($('#market'), pairs, state.symbol);
  marketOptions($('#plan-form').elements.strategySymbol, pairs, state.plan.strategySymbol);
  marketOptions($('#session-form').elements.symbol, ASSETS.map(asset => asset.symbol), state.symbol);
}

function updatePlanFields() {
  for (const input of all('[name]', $('#plan-form'))) input.value = state.plan[input.name];
  formStatus('#plan-status', '');
}

function renderMetrics(values) {
  text('#metric-equity', money(values.equity));
  text('#metric-free', 'Свободни ' + money(values.freeCash));
  text('#metric-pnl', signed(values.pnl), tone(values.pnl));
  text('#metric-realized', 'Реализиран ' + signed(values.realized) + ' · ' + signed(values.roi, percent));
  text('#metric-target', money(values.target));
  text('#metric-age', percent(state.plan.target) + ' · ден ' + Math.floor(values.age) + ' от ' + state.plan.days);
  text('#metric-drawdown', percent(values.drawdown), values.drawdown >= state.plan.drawdown * 0.8 ? 'amber' : '');
  text('#metric-risk', 'Праг ' + percent(state.plan.drawdown) + ' · такси ' + money(values.fees));
  text('#sidebar-capital', money(state.initial) + ' начален капитал');
  $('#risk-notice').hidden = !state.halt;
  $('#risk-notice').textContent = state.halt ? state.halt.message + ' Можеш да затваряш позиции.' : '';
}

function cell(value, className = '') {
  return '<td class="' + className + '">' + value + '</td>';
}

function table(columns, rows, empty) {
  if (!rows.length) return '<p class="empty">' + safe(empty) + '</p>';
  const head = columns.map(column => '<th scope="col" class="' + (column[1] || '') + '">' + safe(column[0]) + '</th>').join('');
  return '<div class="table-wrap"><table><thead><tr>' + head + '</tr></thead><tbody>' + rows.map(row => '<tr>' + row + '</tr>').join('') + '</tbody></table></div>';
}

function renderPortfolio(values) {
  const positions = values.positions.map(position => {
    return cell('<b>' + safe(position.symbol) + '</b>') + cell(decimal.format(position.quantity), 'numeric')
      + cell(money(position.cost), 'numeric') + cell(money(position.exitValue), 'numeric')
      + cell(signed(position.pnl), 'numeric ' + tone(position.pnl))
      + cell('<button class="table-button" data-liquidate="' + safe(position.symbol) + '">Продай</button>', 'numeric');
  });
  $('#position-table').innerHTML = table([
    ['Пазар'], ['Количество','numeric'], ['Себестойност','numeric'], ['Нетна оценка','numeric'], ['Резултат','numeric'], ['Действие','numeric'],
  ], positions, 'Нямаш отворени позиции. Изпълни виртуална покупка, за да отвориш позиция.');
  const filter = $('#order-filter').value;
  const rows = state.orders.filter(order => filter === 'all' || order.status === filter).slice().reverse().map(order => {
    const direction = order.side === 'buy' ? 'Купи' : 'Продай';
    return cell('<b>' + safe(order.symbol) + '</b><span class="muted">' + safe(order.id) + '</span>')
      + cell(direction + '<span class="muted">' + (order.type === 'limit' ? 'Лимитирана' : 'Пазарна') + '</span>')
      + cell(money(order.fillPrice ?? order.price), 'numeric')
      + cell(decimal.format(order.quantity), 'numeric')
      + cell('<span class="badge ' + order.status + '">' + safe(statuses[order.status]) + '</span>' + (order.reason ? '<span class="muted">' + safe(order.reason) + '</span>' : ''))
      + cell(order.status === 'pending' ? '<button class="table-button" data-cancel-order="' + safe(order.id) + '">Отмени</button>' : '·', 'numeric');
  });
  $('#order-table').innerHTML = table([['Пазар'],['Посока'],['Цена','numeric'],['Количество','numeric'],['Статус'],['Действие','numeric']], rows, 'Няма поръчки за избрания филтър.');
}

function renderJournal() {
  const filter = $('#journal-filter').value;
  const fills = new Map(state.fills.map(fill => [fill.orderId, fill]));
  const rows = state.journal.filter(entry => filter === 'all' || entry.type === filter).slice(-250).reverse().map(entry => {
    const fill = entry.type === 'fill' ? fills.get(entry.orderId) : null;
    return cell(date.format(entry.time)) + cell('<span class="badge ' + entry.type + '">' + safe(events[entry.type]) + '</span>')
      + cell(safe(entry.message) + (entry.orderId ? '<span class="muted">' + safe([entry.orderId, fill?.source].filter(Boolean).join(' · ')) + '</span>' : ''))
      + cell(fill ? money(fill.fee) : '·', 'numeric')
      + cell(fill?.realized != null ? signed(fill.realized) : '·', 'numeric ' + tone(fill?.realized ?? 0));
  });
  $('#journal-table').innerHTML = table([['Дата'],['Събитие'],['Подробности'],['Такса','numeric'],['Реализирано','numeric']], rows, 'Няма събития за този филтър.');
}

function miniRow(label, right) {
  return '<div class="mini-row"><b>' + label + '</b><span>' + right + '</span></div>';
}

function renderOverview(values) {
  $('#overview-positions').innerHTML = values.positions.length
    ? values.positions.slice(0, 3).map(item => miniRow(safe(item.symbol), money(item.exitValue))).join('')
    : '<p class="empty card-empty">' + iconElement('wallet') + ' Няма отворени позиции.</p>';
  $('#overview-events').innerHTML = state.journal.slice(-3).reverse().map(event => miniRow(safe(event.message), compactDate.format(event.time))).join('');
  const instrument = assetFor(state.symbol);
  const tape = analysis(dataset, state);
  text('#asset-monogram', ({ BTC: '₿', ETH: 'Ξ', SOL: 'S' })[instrument.code]);
  $('#asset-monogram').style.color = instrument.color;
  text('#asset-name', instrument.name);
  text('#chart-price', money(tape.close));
  text('#chart-change', signed(tape.change, percent), tone(tape.change));
  text('#chart-source', datasetLabel() + ' · ' + Math.min(range, state.cursor + 1) + ' свещи');
  text('#paper-date', date.format(paperTime(dataset, state)));
  text('#step-text', dataset.kind === 'csv' ? 'Следваща свещ' : 'Следващ ден');
  text('#clock-status', (ticker ? 'Възпроизвеждане' : 'Пауза') + ' · '
    + (state.plan.strategy === 'sma' ? 'SMA ' + state.plan.window : 'Ръчен режим')
    + (savedLocally ? '' : ' · няма локално запазване'));
  text('#play-text', ticker ? 'Пауза' : 'Старт');
  $('#play-icon').innerHTML = icon(ticker ? 'pause' : 'play');
  $('#play-icon').dataset.icon = ticker ? 'pause' : 'play';
  $('button[data-action="step"]').disabled = !hasNext(state, dataset);
  $('button[data-action="play"]').disabled = !hasNext(state, dataset) && !ticker;
  $('#market-chart').setAttribute('aria-label', state.symbol + '. ' + datasetLabel() + '. Последна цена ' + money(tape.close));
  requestAnimationFrame(drawMarket);
}

function render() {
  const values = account(state, dataset);
  renderMetrics(values);
  if (currentView === 'overview') renderOverview(values);
  if (currentView === 'portfolio') renderPortfolio(values);
  if (currentView === 'journal') renderJournal();
  if (currentView === 'strategy' && backtestResult) renderBacktest(backtestResult);
}

function commit(next) {
  state = next;
  save();
  render();
}

function canvasContext(canvas) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.font = '10px Lab, system-ui, sans-serif';
  context.textBaseline = 'middle';
  return { context, width, height };
}

function drawMarket() {
  const canvas = $('#market-chart');
  const view = canvasContext(canvas);
  if (!view) return;
  const { context: ctx, width, height } = view;
  const items = dataset.series[state.symbol].slice(Math.max(0, state.cursor - range + 1), state.cursor + 1);
  const chart = { left: 5, right: width - 51, top: 16, bottom: height - 60, volumeBottom: height - 25 };
  const highest = Math.max(...items.map(item => item.high));
  const lowest = Math.min(...items.map(item => item.low));
  const span = Math.max(0.00000001, highest - lowest, highest * 0.0001);
  const high = highest + span * 0.065;
  const low = lowest - span * 0.065;
  const volume = Math.max(1, ...items.map(item => item.volume));
  const stride = (chart.right - chart.left) / items.length;
  const x = index => chart.left + stride * (index + 0.5);
  const y = price => chart.bottom - (price - low) / (high - low) * (chart.bottom - chart.top);
  const yAt = level => y(low + (high - low) * level / 4);
  ctx.fillStyle = '#8e9eb7';
  ctx.strokeStyle = '#29364b';
  ctx.lineWidth = 1;
  for (let tick = 0; tick <= 4; tick++) {
    const yy = yAt(tick);
    ctx.beginPath(); ctx.moveTo(chart.left, yy); ctx.lineTo(chart.right, yy); ctx.stroke();
    ctx.fillText(shortNumber.format(low + (high - low) * tick / 4), chart.right + 6, yy);
  }
  const steps = Math.min(5, Math.max(2, Math.floor(width / 102)));
  for (let n = 0; n < steps; n++) {
    const index = Math.round(n * (items.length - 1) / (steps - 1));
    const px = x(index);
    ctx.strokeStyle = '#1e2b3f';
    ctx.beginPath(); ctx.moveTo(px, chart.top); ctx.lineTo(px, chart.volumeBottom); ctx.stroke();
    ctx.fillStyle = '#8e9eb7';
    ctx.fillText(compactDate.format(items[index].time), Math.min(px, chart.right - 29), height - 11);
  }
  const body = Math.max(1.8, Math.min(11, stride * 0.6));
  for (const [index, item] of items.entries()) {
    const good = item.close >= item.open;
    const color = good ? '#4bddb1' : '#ef8290';
    const px = x(index);
    ctx.strokeStyle = color;
    ctx.beginPath(); ctx.moveTo(px, y(item.high)); ctx.lineTo(px, y(item.low)); ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillRect(px - body / 2, Math.min(y(item.open), y(item.close)), body, Math.max(1.4, Math.abs(y(item.open) - y(item.close))));
    ctx.fillStyle = good ? '#4bddb13a' : '#ef82903c';
    const vol = item.volume / volume * 27;
    ctx.fillRect(px - body / 2, chart.volumeBottom - vol, body, vol);
  }
  const tooltip = $('#chart-tooltip');
  tooltip.hidden = dragIndex == null || !items[dragIndex];
  if (!tooltip.hidden) {
    const item = items[dragIndex];
    const px = x(dragIndex);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#7aabdd';
    ctx.beginPath(); ctx.moveTo(px, chart.top); ctx.lineTo(px, chart.volumeBottom); ctx.stroke();
    ctx.restore();
    tooltip.textContent = compactDate.format(item.time) + ' · затв. ' + money(item.close) + ' · макс. ' + money(item.high) + ' · мин. ' + money(item.low);
  }
}

function drawBacktest(result) {
  const canvas = $('#backtest-canvas');
  if (!canvas) return;
  const view = canvasContext(canvas);
  if (!view) return;
  const { context: ctx, width, height } = view;
  const points = result.points.map(point => point.value);
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const spread = Math.max(hi - lo, 0.01);
  const position = (value, index) => [9 + (width - 18) * index / Math.max(1, points.length - 1), height - 14 - (height - 31) * (value - lo) / spread];
  ctx.strokeStyle = '#253448';
  for (const y of [16, Math.floor(height / 2), height - 14]) {
    ctx.beginPath(); ctx.moveTo(8, y); ctx.lineTo(width - 8, y); ctx.stroke();
  }
  ctx.beginPath();
  for (const [index, value] of points.entries()) {
    if (index === 0) ctx.moveTo(...position(value, index));
    else ctx.lineTo(...position(value, index));
  }
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#67d5fe';
  ctx.stroke();
}

function renderBacktest(result) {
  const metric = (label, value) => '<div><span>' + label + '</span><b class="' + tone(value) + '">' + signed(value, percent) + '</b></div>';
  $('#backtest-result').innerHTML =
    '<p class="backtest-meta">' + safe(result.symbol) + ' · SMA ' + result.window + ' · ' + result.count + ' свещи · ' + compactDate.format(result.first) + ' – ' + compactDate.format(result.last) + '</p>'
    + '<div class="backtest-cards">' + metric('Стратегия', result.roi) + metric('Задържане', result.holdRoi) + metric('Кеш', 0) + '</div>'
    + '<canvas class="backtest-canvas" id="backtest-canvas" role="img" aria-label="Нетна стойност при историческия тест"></canvas>'
    + '<div class="backtest-details"><div><small>Нетен резултат</small>' + signed(result.pnl) + '</div><div><small>Максимален спад</small>' + percent(result.maxDrawdown) + '</div><div><small>Изпълнения</small>' + result.trades + '</div><div><small>Такси</small>' + money(result.fees) + '</div></div>'
    + (result.halt ? '<p class="backtest-meta">' + safe(result.halt) + '</p>' : '');
  requestAnimationFrame(() => drawBacktest(result));
}

function executeBacktest() {
  backtestResult = backtest(state, dataset, Number($('#backtest-window').value));
  if (currentView === 'strategy') renderBacktest(backtestResult);
  return backtestResult;
}

function clearPlayback() {
  clearInterval(ticker);
  ticker = null;
}

function pause() {
  clearPlayback();
  render();
}

function stepForward() {
  if (!hasNext(state, dataset)) {
    pause();
    showToast('Достигна края на заредените данни.');
    return;
  }
  const previousHalt = state.halt;
  const next = step(state, dataset);
  if (!hasNext(next, dataset) || (!previousHalt && next.halt)) {
    clearPlayback();
    if (next.halt && !previousHalt) showToast(next.halt.message);
  }
  commit(next);
}

function startPlayback() {
  if (ticker) return;
  if (!hasNext(state, dataset)) throw Error('Достигна края на заредените данни.');
  ticker = setInterval(stepForward, 560);
  render();
}

function updateOrderFields() {
  const form = $('#order-form');
  const buy = form.elements.side.value === 'buy';
  const limit = form.elements.type.value === 'limit';
  const whole = !buy && form.elements.all.checked;
  $('#limit-wrap').hidden = !limit;
  form.elements.limit.required = limit;
  $('#all-position-wrap').hidden = buy;
  $('#order-amount-wrap').firstChild.textContent = buy ? 'Бюджет с такса (€)' : 'Стойност преди такса (€)';
  $('#order-amount-wrap').hidden = whole;
  form.elements.amount.required = !whole;
  if (buy) form.elements.all.checked = false;
  draft = null;
  $('#order-preview').hidden = true;
  $('#confirm-order').disabled = true;
  formStatus('#order-message', '');
}

function openOrder(options = {}) {
  pause();
  const form = $('#order-form');
  form.reset();
  orderContext = { symbol: options.symbol || state.symbol, source: options.source || 'Ръчно' };
  form.elements.side.value = options.side || 'buy';
  form.elements.type.value = options.type || 'market';
  form.elements.amount.value = options.amount ?? 100;
  form.elements.all.checked = !!options.all;
  form.elements.limit.value = options.limit ?? '';
  text('#order-market', orderContext.symbol + ' · ' + datasetLabel() + ' · ' + money(quote(dataset, state, orderContext.symbol).close));
  formStatus('#order-message', '');
  updateOrderFields();
  const dialog = $('#order-dialog');
  if (!dialog.open) dialog.showModal();
  if (options.source === 'Команда от чата' || options.all) prepareOrder();
}

function prepareOrder() {
  try {
    const form = $('#order-form');
    draft = previewOrder(state, dataset, {
      ...orderContext, side: form.elements.side.value, type: form.elements.type.value,
      limit: form.elements.limit.value, amount: form.elements.amount.value, all: form.elements.all.checked,
    });
    const description = (label, value) => '<div><span>' + label + '</span><b>' + value + '</b></div>';
    $('#order-preview').innerHTML = description('Цена', money(draft.price)) + description('Количество', decimal.format(draft.quantity))
      + description(draft.side === 'buy' ? 'Общо с таксата' : 'Нетни средства', money(draft.total))
      + description('Прогнозна такса', money(draft.fee));
    $('#order-preview').hidden = false;
    $('#confirm-order').disabled = false;
    formStatus('#order-message', draft.type === 'limit' ? 'Изчаква докосване на цената в следваща свещ.' : 'Поръчката ще се изпълни на виртуалната сметка.');
  } catch (error) {
    draft = null;
    $('#order-preview').hidden = true;
    $('#confirm-order').disabled = true;
    formStatus('#order-message', error.message, true);
  }
}

function confirmOrder() {
  if (!draft) return;
  try {
    const next = submitOrder(state, dataset, draft);
    const latest = next.orders.at(-1);
    const fromChat = draft.source === 'Команда от чата';
    draft = null;
    $('#confirm-order').disabled = true;
    $('#order-dialog').close();
    const message = latest.status === 'filled' ? 'Изпълнена поръчка ' + latest.id + ' за ' + latest.symbol + '.' : 'Чакаща поръчка ' + latest.id + ' за ' + latest.symbol + '.';
    if (fromChat) appendChat('agent', message);
    commit(next);
    if (fromChat) renderChat();
    showToast(message);
  } catch (error) {
    draft = null;
    $('#confirm-order').disabled = true;
    formStatus('#order-message', error.message, true);
  }
}

function appendChat(role, value) {
  messages = [...messages, { role, text: value }].slice(-60);
}

function renderChat() {
  const log = $('#chat-log');
  log.replaceChildren(...messages.map(message => {
    const block = document.createElement('div');
    block.className = 'message ' + (message.role === 'user' ? 'user' : 'agent');
    if (message.role === 'agent') {
      const label = document.createElement('b');
      label.textContent = 'SharkAI';
      block.append(label);
    }
    block.append(document.createTextNode(message.text));
    return block;
  }));
  log.scrollTop = log.scrollHeight;
}

function handleCommand(command) {
  const entered = command.trim();
  if (!entered) return;
  appendChat('user', entered);
  const request = entered.toLocaleLowerCase('bg-BG');
  let answer;
  try {
    const values = account(state, dataset);
    const order = request.match(/^(купи|продай)(?:\s+за)?\s+(всичко|[0-9]+(?:[.,][0-9]+)?)(?:\s*(?:евро|eur|€))?[.!]?$/u);
    const target = request.match(/^(?:цел|таргет)(?:\s+от)?\s+([0-9]+(?:[.,][0-9]+)?)\s*%?$/u);
    if (order) {
      const side = order[1] === 'купи' ? 'buy' : 'sell';
      const everything = order[2] === 'всичко';
      if (side === 'buy' && everything) throw Error('Посочи точен бюджет за покупката в евро.');
      openOrder({ side, all: everything, amount: everything ? 100 : Number(order[2].replace(',', '.')), source: 'Команда от чата' });
      answer = 'Отворих преглед на ' + state.symbol + '. Провери сумата и таксата, после натисни „Потвърди“.';
    } else if (/седмичн\p{L}*\s+(?:цел|план|резултат)/u.test(request)) {
      showView('weekly');
      answer = 'Отворих „Седмична цел“. Можеш да сравниш плановете за 7 дни и да запишеш отчетените постъпления.';
    } else if (target) {
      const value = Number(target[1].replace(',', '.'));
      if (value < 0.01 || value > 100) throw Error('Въведи цел между 0,01% и 100%.');
      showView('strategy');
      $('#plan-form').elements.target.value = value;
      formStatus('#plan-status', 'Попълнена е цел ' + percent(value) + '. Запази плана, за да приложиш промяната.');
      answer = 'Попълних цел ' + percent(value) + '. Запази я в „Стратегии“.';
    } else if (/бек[\s-]?тест|backtest|исторически тест/u.test(request)) {
      showView('strategy');
      const result = executeBacktest();
      answer = 'Исторически тест за ' + result.symbol + '. Стратегия ' + signed(result.roi, percent) + ', задържане ' + signed(result.holdRoi, percent) + ', кеш 0%. Отворих резултата в „Стратегии“.';
    } else if (/анализ|котировка|цена|пазар/u.test(request)) {
      const info = analysis(dataset, state);
      const signal = { buy: 'пресичане нагоре', sell: 'пресичане надолу', none: 'няма пресичане' }[info.signal];
      answer = info.market + ' е ' + money(info.close) + ' в текущия източник. Последна свещ ' + signed(info.change, percent)
        + ', последните 7 стъпки ' + signed(info.week, percent) + '. SMA ' + state.plan.window + ' ' + (info.sma == null ? 'очаква още данни' : money(info.sma)) + ' · ' + signal + '.';
    } else if (/портфейл|баланс|наличност/u.test(request)) {
      answer = 'Нетна оценка ' + money(values.equity) + '. Свободни ' + money(values.freeCash) + '. Нетен резултат '
        + signed(values.pnl) + ', от които реализирани ' + signed(values.realized) + '. Отворени позиции ' + values.positions.length + ', чакащи поръчки ' + values.pending + '.';
    } else if (/риск|лимит|спад/u.test(request)) {
      answer = 'Спад от върха ' + percent(values.drawdown) + ' при праг ' + percent(state.plan.drawdown)
        + '. Дневни покупки ' + money(values.spent) + ' от ' + money(state.plan.dailyMax) + '. '
        + (state.halt?.message || 'Входовете са разрешени при валидна поръчка.');
    } else if (/^(пауза|спри)[.!]?$/u.test(request)) {
      pause();
      answer = 'Възпроизвеждането е поставено на пауза.';
    } else if (/^(старт|пусни симулацията|стартирай)[.!]?$/u.test(request)) {
      startPlayback();
      answer = 'Възпроизвеждането започна. Виждаш всяка свещ и всички изпълнения в дневника.';
    } else if (/дневник|операции/u.test(request)) {
      showView('journal');
      answer = 'Отворих дневника. Можеш да филтрираш събитията и да ги свалиш като CSV.';
    } else {
      answer = HELP;
    }
  } catch (error) {
    answer = error.message;
  }
  appendChat('agent', answer);
  save();
  renderChat();
}

function download(content, name) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.download = name;
  a.href = url;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3_000);
}

function downloadSample() {
  const symbol = $('#session-form').elements.symbol.value;
  const rows = scenarioData().series[symbol].slice(0, 101);
  const data = ['date,open,high,low,close,volume', ...rows.map(row => [
    new Date(row.time).toISOString().slice(0, 10), row.open.toFixed(6), row.high.toFixed(6),
    row.low.toFixed(6), row.close.toFixed(6), row.volume,
  ].join(','))].join('\n');
  download(data, 'sharkai-simulated-' + assetFor(symbol).code.toLowerCase() + '.csv');
  showToast('Изтеглен е примерен CSV със симулирани данни.');
}

function updateLive() {
  const pair = $('#session-form').elements.symbol.value || state.symbol;
  const entry = livePrices[pair];
  let status = 'Публичен поток само за котировки.';
  if (liveMode === 'opening') status = 'Свързване с публичния поток…';
  if (liveMode === 'online') {
    status = entry ? pair + ' · ' + money(entry.price) + ' · ' + new Date(entry.received).toLocaleTimeString('bg-BG') : 'Изчаква се котировка за ' + pair + '.';
    if (entry && Date.now() - entry.received > 45_000) status += ' · последна получена';
  }
  if (liveMode === 'error') status = 'Потокът е недостъпен в тази среда. Търговската симулация продължава със заредените данни.';
  text('#live-status', status);
  $('[data-action="live"]').textContent = liveMode === 'online' || liveMode === 'opening' ? 'Изключи' : 'Свържи';
}

function stopLive(mode = 'off') {
  const pending = liveSocket;
  liveSocket = null;
  clearTimeout(liveTimeout);
  if (pending) pending.close();
  liveMode = mode;
  updateLive();
}

function toggleLive() {
  if (liveSocket) return stopLive();
  try {
    const socket = new WebSocket('wss://ws.kraken.com/v2');
    liveSocket = socket;
    livePrices = {};
    liveMode = 'opening';
    updateLive();
    liveTimeout = setTimeout(() => stopLive('error'), 10_000);
    socket.addEventListener('open', () => {
      if (socket !== liveSocket) return;
      socket.send(JSON.stringify({ method: 'subscribe', params: { channel: 'ticker', symbol: ASSETS.map(asset => asset.symbol), snapshot: true } }));
    });
    socket.addEventListener('message', event => {
      if (socket !== liveSocket) return;
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (payload.channel !== 'ticker' || !Array.isArray(payload.data)) return;
      for (const item of payload.data) {
        if (assetFor(item.symbol) && Number.isFinite(item.last)) livePrices[item.symbol] = { price: item.last, received: Date.now() };
      }
      if (Object.keys(livePrices).length) {
        liveMode = 'online';
        clearTimeout(liveTimeout);
        updateLive();
      }
    });
    socket.addEventListener('error', () => { if (socket === liveSocket) stopLive('error'); });
    socket.addEventListener('close', () => { if (socket === liveSocket) stopLive('error'); });
  } catch {
    stopLive('error');
  }
}

function openData() {
  pause();
  const form = $('#session-form');
  form.elements.capital.value = state.initial;
  form.elements.symbol.value = state.symbol;
  form.elements.dataset.value = 'market';
  form.elements.csv.value = '';
  text('#data-description', 'Текущи данни · ' + datasetLabel());
  resetSourceCheck();
  updateLive();
  $('#data-dialog').showModal();
}

function sourceSelection() {
  const { elements } = $('#session-form');
  return { symbol: elements.symbol.value, kind: elements.dataset.value, file: elements.csv.files[0] ?? null };
}

function resetSourceCheck() {
  checkedSource = null;
  const { kind } = sourceSelection();
  $('#csv-wrap').hidden = kind !== 'csv';
  $('[data-action="check-source"]').hidden = kind !== 'market' && kind !== 'csv';
  formStatus('#session-status', '');
}

async function getDataset(selection) {
  const { kind, symbol, file } = selection;
  if (checkedSource?.kind === kind && checkedSource.symbol === symbol && checkedSource.file === file) return checkedSource.data;
  if (kind === 'csv') {
    if (!file || file.size > 2_000_000) throw Error('Избери CSV файл до 2 MB.');
    return importCsv(await file.text(), symbol);
  }
  if (kind === 'market') return historicalMarket([await loadMarket(symbol)]);
  if (['base', 'volatile', 'down'].includes(kind)) return scenarioData(kind);
  throw Error('Избери източник на котировки.');
}

async function checkSource() {
  const button = $('[data-action="check-source"]');
  const selection = sourceSelection();
  formStatus('#session-status', 'Проверявам котировките…');
  button.disabled = true;
  try {
    const data = await getDataset(selection);
    const current = sourceSelection();
    if (Object.keys(selection).some(key => selection[key] !== current[key])) return;
    checkedSource = { ...selection, data };
    const bars = data.series[selection.symbol];
    formStatus('#session-status', bars.length + ' затворени свещи · ' + date.format(bars[0].time)
      + ' до ' + date.format(bars.at(-1).time) + ' · Текущата сметка е запазена.');
  } catch (error) {
    formStatus('#session-status', error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function startSession(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const send = $('[type="submit"]', form);
  const selection = sourceSelection();
  const { symbol } = selection;
  const capital = Number(form.elements.capital.value);
  if (state.orders.length && !window.confirm('Да заменя ли текущата виртуална сметка, поръчките и дневника?')) return;
  formStatus('#session-status', 'Подготвям виртуалната сметка…');
  send.disabled = true;
  try {
    const source = await getDataset(selection);
    const next = initSession(source, { ...DEFAULT_PLAN, capital, strategySymbol: symbol }, symbol);
    clearPlayback();
    dataset = source;
    messages = [{ role: 'agent', text: 'Новата сметка е готова. ' + HELP }];
    backtestResult = null;
    $('#backtest-result').innerHTML = '<p class="empty">Избери прозорец, за да сравниш стратегията със задържане и кеш.</p>';
    commit(next);
    updateMarkets();
    updatePlanFields();
    showView('overview');
    $('#data-dialog').close();
    showToast('Отворена е нова виртуална сметка.');
  } catch (error) {
    formStatus('#session-status', error.message, true);
  } finally {
    send.disabled = false;
  }
}

function transitionAction(action) {
  if (action === 'new-order') openOrder();
  if (action === 'step') { clearPlayback(); stepForward(); }
  if (action === 'play') { if (ticker) pause(); else startPlayback(); }
  if (action === 'data') openData();
  if (action === 'live') toggleLive();
  if (action === 'sample') downloadSample();
  if (action === 'check-source') void checkSource();
  if (action === 'export') {
    download(exportJournal(state), 'sharkai-dnevnik.csv');
    showToast('Дневникът е изтеглен като CSV.');
  }
}

function bind() {
  for (const node of all('[data-icon]')) node.innerHTML = icon(node.dataset.icon);
  for (const node of all('.navigation button')) node.setAttribute('aria-label', node.textContent.trim());
  $('.data-nav').setAttribute('aria-label', 'Пазарни данни');
  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    const { view, range: period, command, action, close, liquidate, cancelOrder: cancellation } = button.dataset;
    try {
      if (view) showView(view);
      if (period) {
        range = Number(period);
        dragIndex = null;
        for (const item of all('[data-range]')) {
          item.classList.toggle('selected', item === button);
          item.setAttribute('aria-pressed', String(item === button));
        }
        render();
      }
      if (command) handleCommand(command);
      if (close) $('#' + close).close();
      if (liquidate) openOrder({ symbol: liquidate, side: 'sell', all: true });
      if (cancellation) {
        commit(cancelOrder(state, dataset, cancellation));
        showToast('Поръчката е отменена.');
      }
      if (action) transitionAction(action);
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $('#market').addEventListener('change', event => {
    dragIndex = null;
    commit(selectMarket(state, dataset, event.target.value));
  });
  $('#order-filter').addEventListener('change', render);
  $('#journal-filter').addEventListener('change', render);
  $('#chat-form').addEventListener('submit', event => {
    event.preventDefault();
    const input = $('#chat-input');
    handleCommand(input.value);
    input.value = '';
  });
  $('#order-form').addEventListener('input', updateOrderFields);
  $('#order-form').addEventListener('submit', event => {
    event.preventDefault();
    prepareOrder();
  });
  $('#confirm-order').addEventListener('click', confirmOrder);
  $('#order-dialog').addEventListener('close', () => { draft = null; });
  $('#plan-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const patch = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, form.elements[key].type === 'number' ? Number(value) : value]));
      backtestResult = null;
      $('#backtest-result').innerHTML = '<p class="empty">Планът е обновен. Пусни тест с новите параметри.</p>';
      commit(configure(state, dataset, patch));
      formStatus('#plan-status', 'Планът е запазен.');
    } catch (error) {
      formStatus('#plan-status', error.message, true);
    }
  });
  $('#backtest-form').addEventListener('submit', event => {
    event.preventDefault();
    try { executeBacktest(); }
    catch (error) { $('#backtest-result').innerHTML = '<p class="empty down">' + safe(error.message) + '</p>'; }
  });
  $('#session-form').addEventListener('submit', startSession);
  $('#session-form').addEventListener('change', event => {
    if (['dataset', 'symbol', 'csv'].includes(event.target.name)) resetSourceCheck();
    if (event.target.name === 'symbol') updateLive();
  });
  const chart = $('#market-chart');
  chart.addEventListener('pointermove', event => {
    const bounds = chart.getBoundingClientRect();
    const count = Math.min(range, state.cursor + 1);
    dragIndex = Math.max(0, Math.min(count - 1, Math.floor((event.clientX - bounds.left - 5) / (bounds.width - 56) * count)));
    drawMarket();
  });
  chart.addEventListener('pointerleave', () => { dragIndex = null; drawMarket(); });
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(() => {
      if (currentView === 'overview') drawMarket();
      if (currentView === 'strategy' && backtestResult) drawBacktest(backtestResult);
    });
    observer.observe($('#chart-wrap'));
    observer.observe($('#backtest-result'));
  }
}

function mountSimulator() {
  bind();
  weeklyPane = mountWeek(() => ({ dataset, state }));
  updateMarkets();
  updatePlanFields();
  renderChat();
  render();
  if (window.location.hash === '#weekly') showView('weekly');
}

async function firstSession() {
  const main = $('#main');
  const controls = all('.shell button:not(:disabled)').filter(button => !main.contains(button));
  controls.forEach(button => { button.disabled = true; });
  main.hidden = true;
  const notice = document.createElement('section');
  notice.className = 'hero';
  notice.setAttribute('aria-label', 'Подготовка на симулатора');
  main.before(notice);

  function begin(source) {
    dataset = source;
    state = initSession(dataset);
    save();
    controls.forEach(button => { button.disabled = false; });
    notice.remove();
    main.hidden = false;
    mountSimulator();
  }

  async function fetchHistory() {
    notice.innerHTML = '<div class="hero-content"><h1>Виртуален симулатор</h1><p role="status">Зареждане на историческите борсови цени…</p></div>';
    const results = await Promise.allSettled(ASSETS.map(asset => loadMarket(asset.symbol)));
    let source;
    try {
      source = historicalMarket(results.filter(result => result.status === 'fulfilled').map(result => result.value));
    } catch {
      notice.innerHTML = '<div class="hero-content"><h1>Историята е недостъпна</h1><p role="status">Свържи се отново с борсите или избери симулирани цени.</p></div><div class="dialog-actions"><button type="button" class="button secondary" data-demo>Демо сценарий</button><button type="button" class="button primary" data-retry>Опитай отново</button></div>';
      $('[data-retry]', notice).addEventListener('click', fetchHistory, { once: true });
      $('[data-demo]', notice).addEventListener('click', () => begin(scenarioData()), { once: true });
      return;
    }
    begin(source);
  }
  await fetchHistory();
}

if (restore()) mountSimulator();
else void firstSession();
