'use client';

import { useEffect, useId, useState } from 'react';
import { z } from 'zod';
import { currencyMinorDigits, displayMinor, minorToInput, parseDecimalMinor } from '@/lib/wallet-investments-contract';
import './wallet-forecast.css';

const periods = [
  ['day', '1 ден'], ['week_1', '1 седмица'], ['week_2', '2 седмици'],
  ['week_3', '3 седмици'], ['week_4', '4 седмици'], ['month', '1 месец'],
] as const;
type Period = typeof periods[number][0];
const currencies = Intl.supportedValuesOf('currency');
const integer = z.string().regex(/^-?\d+$/);
const percentage = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const range = z.object({ lower_minor: integer, upper_minor: integer, lower_pct: percentage, upper_pct: percentage });
const forecast = z.object({
  status: z.enum(['available', 'unavailable']), reason: z.literal('insufficient_verified_history').nullable(),
  currency: z.string(), amount_minor: integer, period: z.string(), start_date: z.string().date(), end_date_exclusive: z.string().date(),
  range: range.nullable(), sample_count: z.number().int().nonnegative().nullable(), source: z.string().nullable(),
  instrument_code: z.string().nullable(), strategy_label: z.string().nullable(),
  as_of: z.string().nullable(), window_start: z.string().date().nullable(), window_end: z.string().date().nullable(),
  authorized_funded_minor: z.string().regex(/^\d+$/), authorized_range: range.nullable(),
  basis: z.literal('historical_observed_extrema'), performance_fee_basis: z.literal('before_platform_performance_fee'),
});
type Forecast = z.infer<typeof forecast>;
type Result = { key: string; data?: Forecast; error?: string; requiresLogin?: boolean };
const dates = new Intl.DateTimeFormat('bg-BG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const sources: Record<string, string> = {
  ibkr_portfolio_analyst_net_strategy: 'Interactive Brokers · PortfolioAnalyst',
  saxo_account_history_net_strategy: 'Saxo · История на стратегията',
};

function formatPercent(value: string) {
  const [whole, fraction = ''] = value.split('.');
  const digits = fraction.replace(/0+$/, '');
  const formatted = (whole + (digits ? ',' + digits : '')).replace(/^-/, '−');
  if (formatted === '−0') return '0%';
  return (formatted !== '0' && !formatted.startsWith('−') ? '+' : '') + formatted + '%';
}

function periodLabel(start: string, endExclusive: string) {
  const end = new Date(Date.parse(endExclusive) - 86400000);
  return Date.parse(start) === end.getTime() ? dates.format(end) : dates.format(new Date(start)) + ' – ' + dates.format(end);
}

const euroEvidence = z.object({
  status: z.enum(['available', 'unavailable']), source: z.literal('ECB_ESTR_COMPOUNDED_INDEX'),
  source_url: z.string().url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && /(^|\.)ecb\.europa\.eu$/.test(url.hostname); }),
  period: z.string(), from: z.string().date().nullable(), as_of: z.string().date().nullable(), samples: z.number().int().nonnegative(),
  lower_pct_micros: integer.nullable(), median_pct_micros: integer.nullable(), upper_pct_micros: integer.nullable(),
});

function cashAtEuroRate(minor: string, rate: string) {
  const product = BigInt(minor) * BigInt(rate);
  const sign = product < BigInt(0) ? BigInt(-1) : BigInt(1);
  return (sign * ((sign * product + BigInt(50000000)) / BigInt(100000000))).toString();
}

function EuroReference({ minor, period, expanded }: { minor: string; period: Period; expanded: boolean }) {
  const [evidence, setEvidence] = useState<z.infer<typeof euroEvidence> | null>(null);
  const [failed, setFailed] = useState<Period | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const res = await fetch('/api/market/euro-reference?period=' + period, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
        if (!res.ok) throw new Error('ECB unavailable');
        const data = euroEvidence.parse(await res.json());
        if (data.period !== period) throw new Error('Different period');
        if (!controller.signal.aborted) { setFailed(null); setEvidence(data); }
      } catch { if (!controller.signal.aborted) setFailed(period); }
    }
    void load();
    return () => controller.abort();
  }, [period, retry]);
  const data = evidence?.period === period ? evidence : null;
  const title = 'Паричен пазар в евро · ЕЦБ (€STR)';
  const rates = data && [
    ['Най-нисък', data.lower_pct_micros], ['Медиана', data.median_pct_micros], ['Най-висок', data.upper_pct_micros],
  ] as const;
  const content = <>
    <p className="wallet-projection-note">Исторически индекс за евро. Лихвата на портфейла и доходността на агента зависят от отделните им условия.</p>
    {failed === period ? <p className="wallet-projection-error">Данните на ЕЦБ временно са недостъпни. <button type="button" onClick={() => { setFailed(null); setRetry(n => n + 1); }}>Опитай отново</button></p>
      : !data ? <p role="status">Зареждане на данните на ЕЦБ…</p>
      : data.status !== 'available' || !rates || data.lower_pct_micros === null || data.upper_pct_micros === null
        ? <p>За този период липсва достатъчно история от ЕЦБ.</p>
        : <>
          <dl className="wallet-projection-range wallet-euro-range">{rates.map(([label, rate]) => rate === null ? null :
            <div key={label}><dt>{label}</dt><dd><strong>{formatPercent(minorToInput(rate, 6).replace(',', '.'))}</strong>
              <span>{displayMinor(cashAtEuroRate(minor, rate), 'EUR')}</span></dd></div>)}</dl>
          <p className="wallet-projection-source">{data.samples} наблюдавани подвижни периода със съпоставими дати
            {data.from && data.as_of && ' · ' + dates.format(new Date(data.from)) + ' – ' + dates.format(new Date(data.as_of))} · <a href={data.source_url} target="_blank" rel="noreferrer">Източник: ЕЦБ</a></p>
        </>}
  </>;
  return expanded ? <section className="wallet-euro-reference"><h3>{title}</h3>{content}</section>
    : <details className="wallet-euro-reference"><summary>{title}</summary>{content}</details>;
}

function RangeResult({ data }: { data: Forecast }) {
  const bounds = data.range;
  if (!bounds || data.status !== 'available') return <p className="wallet-projection-note">
    За тази сума, валута и период няма достатъчно проверена история на стратегията, за да се изчисли диапазон.
  </p>;
  return <>
    <p className="wallet-projection-period">{periodLabel(data.start_date, data.end_date_exclusive)} · {displayMinor(data.amount_minor, data.currency)}</p>
    <dl className="wallet-projection-range">
      {([['Най-нисък наблюдаван резултат', bounds.lower_minor, bounds.lower_pct],
        ['Най-висок наблюдаван резултат', bounds.upper_minor, bounds.upper_pct]] as const).map(([label, cash, percent]) =>
        <div key={label}>
          <dt>{label}</dt>
          <dd data-sign={BigInt(cash) < BigInt(0) ? 'negative' : BigInt(cash) > BigInt(0) ? 'positive' : 'zero'}>
            <strong>{formatPercent(percent)}</strong><span>{displayMinor(cash, data.currency)}</span>
          </dd>
        </div>)}
    </dl>
    <p className="wallet-projection-note">Резултатът е след отчетените брокерски разходи и преди евентуалната такса на Shark AI върху печалбата. Бъдещата загуба или печалба може да е извън показания диапазон.</p>
    <p className="wallet-projection-source">
      {[data.strategy_label, data.instrument_code, data.source && (sources[data.source] ?? data.source)].filter(Boolean).join(' · ')}
      {data.sample_count !== null && ' · ' + data.sample_count + ' исторически периода'}
      {data.window_start && data.window_end && ' · ' + dates.format(new Date(data.window_start)) + ' – ' + dates.format(new Date(data.window_end))}
      {data.as_of && Number.isFinite(Date.parse(data.as_of)) && ' · Проверено на ' + dates.format(new Date(data.as_of))}
    </p>
  </>;
}

export default function WalletForecast({ currency = 'EUR', initialAmountMinor = null, withScene = false }: { currency?: string; initialAmountMinor?: string | null; withScene?: boolean }) {
  const id = useId();
  const [entry, setEntry] = useState<{ unit: string; amount: string } | null>(null);
  const unit = entry?.unit ?? (currencies.includes(currency) ? currency : 'EUR');
  const amount = entry?.amount ?? minorToInput(initialAmountMinor, currencyMinorDigits(unit) ?? 2);
  const [period, setPeriod] = useState<Period>('week_1');
  const [result, setResult] = useState<Result | null>(null);
  const [retry, setRetry] = useState(0);
  const [touched, setTouched] = useState(false);
  const minor = parseDecimalMinor(amount, currencyMinorDigits(unit) ?? 2);
  const key = unit + '|' + minor + '|' + period;
  const current = result?.key === key ? result : null;

  useEffect(() => {
    if (!minor) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch('/api/wallet-investments/forecast', {
          method: 'POST', cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount_minor: minor, currency: unit, period }),
        });
        if (response.status === 401) {
          if (!controller.signal.aborted) setResult({ key, error: 'Влез в профила си за историческата прогноза на твоята стратегия.', requiresLogin: true });
          return;
        }
        if (!response.ok) throw new Error('Forecast unavailable');
        const data = forecast.parse(await response.json());
        if (data.currency !== unit || data.amount_minor !== minor || data.period !== period) throw new Error('Different forecast');
        if (!controller.signal.aborted) setResult({ key, data });
      } catch {
        if (!controller.signal.aborted) setResult({ key, error: 'Прогнозата временно е недостъпна.' });
      }
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, minor, period, retry, unit]);

  const invalid = Boolean(touched && amount.trim() && !minor);
  const data = current?.data;
  return <section className="wallet-projection" data-scene={withScene ? 'forecast' : undefined} data-scene-tone={withScene ? 'light' : undefined} aria-labelledby={id + '-title'}>
    <h2 id={id + '-title'}>Прогноза за сума и период</h2>
    <p>Виж какъв резултат би дала въведената сума за същия период в проверената история на стратегията.</p>
    <div className="wallet-projection-fields">
      <label>Сума на депозита<input value={amount} inputMode="decimal" autoComplete="off" placeholder={minorToInput('0', currencyMinorDigits(unit) ?? 2)} maxLength={26}
        aria-invalid={invalid} aria-describedby={invalid ? id + '-amount-error' : undefined}
        onBlur={() => setTouched(true)} onChange={event => setEntry({ unit, amount: event.target.value })} /></label>
      <label>Валута<select value={unit} onChange={event => setEntry({ unit: event.target.value, amount })}>
        {currencies.map(code => <option key={code}>{code}</option>)}
      </select></label>
    </div>
    {invalid && <p id={id + '-amount-error'} className="wallet-projection-error">Въведи положителна сума с до {currencyMinorDigits(unit)} знака след десетичната запетая.</p>}
    <fieldset className="wallet-projection-periods">
      <legend>Период</legend>
      <div>{periods.map(([value, label]) => <label key={value}>
        <input type="radio" name={id + '-period'} value={value} checked={period === value} onChange={() => setPeriod(value)} /><span>{label}</span>
      </label>)}</div>
    </fieldset>
    <div className="wallet-projection-answer" aria-live="polite" aria-busy={Boolean(minor && !current)}>
      {minor && !current && <p>Изчисляване на диапазона…</p>}
      {current?.error && <p className={current.requiresLogin ? 'wallet-projection-note' : 'wallet-projection-error'}>{current.error}{!current.requiresLogin &&
        <> <button type="button" onClick={() => { setResult(null); setRetry(n => n + 1); }}>Опитай отново</button></>}</p>}
      {data && <>
        <RangeResult data={data} />
        <p className="wallet-projection-budget">Разрешена сума за търговия от потвърдена отделена печалба <strong>{displayMinor(data.authorized_funded_minor, data.currency)}</strong>.</p>
        {data.authorized_range && data.authorized_funded_minor !== data.amount_minor &&
          <p className="wallet-projection-note">При тази разрешена сума историческият резултат е от {displayMinor(data.authorized_range.lower_minor, data.currency)} до {displayMinor(data.authorized_range.upper_minor, data.currency)}.</p>}
      </>}
    </div>
    {unit === 'EUR' && minor && <EuroReference minor={minor} period={period} expanded={Boolean(current?.error || data?.status === 'unavailable')} />}
    <small>Въведената сума служи само за справка. За търговия агентът използва изрично разрешената част от отделената печалба.</small>
  </section>;
}
