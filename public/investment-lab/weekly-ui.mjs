import { adsOption, compareWeek, marketOptionsForWeek, resaleOption, weekCash, weekInputs } from './weekly.mjs';

const SETTINGS = 'sharkai.weekly.preview.v1';
const CASH = 'sharkai.weekly.cash.v1';
const original = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR' });
const decimal = new Intl.NumberFormat('bg-BG', { maximumFractionDigits: 1 });
const date = new Intl.DateTimeFormat('bg-BG', { dateStyle: 'short', timeZone: 'UTC' });
const euro = value => original.format(Math.abs(value) < 0.005 ? 0 : value);
const pct = value => decimal.format(value) + '%';
const tone = value => value > 0 ? 'up' : value < 0 ? 'down' : '';
const safe = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function fromStorage(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; }
  catch { return {}; }
}

function toStorage(key, data) {
  try { localStorage.setItem(key, JSON.stringify(data)); return true; }
  catch { return false; }
}

function currentMonday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date());
  const numbers = Object.fromEntries(parts.map(part => [part.type, Number(part.value)]));
  const day = new Date(Date.UTC(numbers.year, numbers.month - 1, numbers.day));
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day.toISOString().slice(0, 10);
}

function oneOfEach(ranked) {
  const seen = new Set();
  return ranked.filter(result => {
    if (seen.has(result.label)) return false;
    seen.add(result.label);
    return true;
  }).slice(0, 7);
}

function paintComparison(box, result) {
  const picked = result.selected;
  const plan = result.plan;
  const rows = oneOfEach(result.ranked).map(item =>
    '<tr><td><b>' + safe(item.label) + '</b></td><td class="numeric">' + euro(item.commitment)
    + '</td><td class="numeric ' + tone(item.mean) + '">' + euro(item.mean)
    + '</td><td class="numeric">' + pct(item.thresholdShare)
    + '</td><td class="numeric ' + tone(item.worst) + '">' + euro(item.worst) + '</td></tr>'
  ).join('');
  const deployed = picked.routes.length
    ? picked.routes.map(item => safe(item.label) + ' ' + euro(item.amount) + (item.samples ? ' (' + item.samples + ' периода)' : '')).join(' · ')
    : 'Бюджетът остава в кеш в подредения най-горе сценарий.';
  const comparison = picked.thresholdShare > 0
    ? pct(picked.thresholdShare) + ' от сценариите достигат ' + euro(plan.minimum) + '.'
    : 'Избраният план не достига ' + euro(plan.minimum) + ' в нито един от моделираните сценарии.';
  const heading = picked.thresholdShare > 0 ? 'Избран сценарий' : 'Най-близък по модел';
  box.innerHTML = '<div class="week-selection"><div><h3>' + heading + ' · ' + safe(picked.label) + '</h3><p>'
    + deployed + '</p><p>' + comparison + '</p></div><dl>'
    + '<dt>Среден нетен резултат</dt><dd class="' + tone(picked.mean) + '">' + euro(picked.mean) + '</dd>'
    + '<dt>Дял с ' + euro(plan.goal) + ' или повече</dt><dd>' + pct(picked.targetShare) + '</dd>'
    + '<dt>Среден недостиг до прага</dt><dd>' + euro(picked.gap) + '</dd>'
    + '<dt>Кеш извън операции</dt><dd>' + euro(picked.cash) + '</dd>'
    + '</dl></div><div class="table-wrap"><table><caption>Сравнени варианти · ' + result.ranked.length
    + '. Виж до седем различни плана, подредени първо по среден резултат поне 0 €, после по дял над прага.</caption>'
    + '<thead><tr><th scope="col">План</th><th scope="col" class="numeric">В операции</th>'
    + '<th scope="col" class="numeric">Среден резултат</th><th scope="col" class="numeric">Дял ≥ ' + euro(plan.minimum)
    + '</th><th scope="col" class="numeric">Най-слаб сценарий</th></tr></thead><tbody>' + rows
    + '</tbody></table></div>';
}

export function mountWeek(getMarket) {
  const form = document.getElementById('week-model-form');
  const ledger = document.getElementById('week-cash-form');
  const results = document.getElementById('week-results');
  const status = document.getElementById('week-model-status');
  const cashStatus = document.getElementById('week-cash-status');
  const read = (element, name) => element.elements[name].valueAsNumber;
  const n = key => read(form, key);
  const draft = () => ({
    budget: n('budget'), reserve: n('reserve'), minimum: n('minimum'), goal: n('goal'),
  });
  let saved = null;
  let dirty = true;
  let resultMarket = null;
  let resultState = null;

  function toggleFields() {
    document.getElementById('week-resale-fields').disabled = !form.elements.useResale.checked;
    document.getElementById('week-ads-fields').disabled = !form.elements.useAds.checked;
  }

  function cashView() {
    const netLabel = document.getElementById('week-net');
    const note = document.getElementById('week-net-note');
    try {
      const net = weekCash(read(ledger, 'received'), read(ledger, 'spent'));
      const plan = weekInputs(draft());
      netLabel.textContent = euro(net);
      netLabel.className = tone(net);
      note.textContent = net >= plan.goal ? 'Желаната сума е достигната.'
        : net >= plan.minimum ? 'Прагът е достигнат · до желаната сума ' + euro(plan.goal - net)
          : 'До прага остават ' + euro(plan.minimum - net) + ' · до желаната сума ' + euro(plan.goal - net);
    } catch {
      netLabel.textContent = '—';
      netLabel.className = '';
      note.textContent = 'Провери въведените стойности.';
    }
  }

  function setCurrentSource() {
    const { dataset, state } = getMarket();
    const source = dataset.kind === 'scenario' ? 'Симулирани свещи' : dataset.label;
    const last = dataset.series[state.symbol]?.[state.cursor]?.time;
    document.getElementById('week-market-source').textContent = 'Източник · ' + source
      + ' · ' + Object.keys(dataset.series).join(', ') + (last ? ' · до ' + date.format(last) : '');
  }

  function showRatio() {
    const ratio = document.getElementById('week-required');
    try {
      const { minimum, goal, budget } = weekInputs(draft());
      ratio.textContent = pct(minimum / budget * 100) + ' – ' + pct(goal / budget * 100);
    } catch { ratio.textContent = '—'; }
  }

  function run(saveDraft) {
    status.textContent = '';
    status.classList.remove('error');
    try {
      weekInputs(draft());
      const { dataset, state } = getMarket();
      const markets = form.elements.useMarket.checked ? marketOptionsForWeek(dataset, state) : [];
      const resale = resaleOption({
        enabled: form.elements.useResale.checked, purchase: n('resalePurchase'), fees: n('resaleFees'),
        paid: n('resalePaid'), chance: n('resaleChance'),
      });
      const ads = adsOption({
        enabled: form.elements.useAds.checked, spend: n('adsSpend'), margin: n('adsMargin'),
        sales: n('adsSales'), chance: n('adsChance'),
      });
      const result = compareWeek(draft(), { markets, resale, ads });
      paintComparison(results, result);
      saved = result;
      dirty = false;
      resultMarket = dataset;
      resultState = state;
      const notes = [];
      if (form.elements.useMarket.checked && !markets.length) notes.push('За този източник липсват съпоставими седемдневни периоди.');
      if (result.overBudget) notes.push(result.overBudget + ' комбинации над наличния бюджет са пропуснати.');
      if (saveDraft && !toStorage(SETTINGS, Object.fromEntries([...form.elements]
        .filter(field => field.name)
        .map(field => [field.name, field.type === 'checkbox' ? field.checked : field.value])))) {
        notes.push('Настройките са активни за текущия преглед.');
      }
      status.textContent = notes.join(' ');
    } catch (error) {
      status.textContent = error.message;
      status.classList.add('error');
    }
  }

  function restoreLedger() {
    const loaded = fromStorage(CASH)[ledger.elements.period.value];
    ledger.elements.received.value = Number.isFinite(loaded?.received) ? loaded.received : 0;
    ledger.elements.spent.value = Number.isFinite(loaded?.spent) ? loaded.spent : 0;
    cashStatus.textContent = '';
    cashView();
  }

  for (const [name, value] of Object.entries(fromStorage(SETTINGS))) {
    const field = form.elements[name];
    if (!field) continue;
    if (field.type === 'checkbox' && typeof value === 'boolean') field.checked = value;
    if (field.type === 'number' && typeof value === 'string') field.value = value;
  }
  ledger.elements.period.value = currentMonday();
  toggleFields();
  restoreLedger();
  form.addEventListener('input', () => {
    toggleFields();
    showRatio();
    cashView();
    dirty = true;
    if (saved) {
      status.classList.remove('error');
      status.textContent = 'Параметрите са променени. Сравни плановете за актуален резултат.';
    }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    run(true);
  });
  ledger.elements.period.addEventListener('change', restoreLedger);
  ledger.addEventListener('input', event => {
    if (event.target.name !== 'period') {
      cashStatus.textContent = '';
      cashView();
    }
  });
  ledger.addEventListener('submit', event => {
    event.preventDefault();
    const received = read(ledger, 'received');
    const spent = read(ledger, 'spent');
    try {
      weekCash(received, spent);
      const reports = fromStorage(CASH);
      reports[ledger.elements.period.value] = { received, spent };
      cashStatus.textContent = toStorage(CASH, reports) ? 'Отчетът е запазен в този браузър.' : 'Този браузър отказа запазването.';
    } catch (error) { cashStatus.textContent = error.message; }
  });

  return {
    open() {
      setCurrentSource();
      showRatio();
      cashView();
      const { dataset, state } = getMarket();
      if (!saved || (!dirty && (dataset !== resultMarket || state !== resultState))) run(false);
    },
  };
}
