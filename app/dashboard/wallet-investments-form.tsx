'use client';

import { useState, type FormEvent } from 'react';
import {
  currencyMinorDigits, minorToInput, parseDecimalMinor, walletSettingsBody,
  type WalletSettingsInput, type WalletTargetInput,
} from '@/lib/wallet-investments-contract';
import type { WalletInvestmentsDashboard } from '@/lib/wallet-investments-server';

const periods = [
  { value: '', label: 'Без избран период' },
  { value: 'day', label: 'Ден' },
  { value: 'days', label: 'Брой дни' },
  { value: 'week', label: 'Седмица' },
  { value: 'month', label: 'Месец' },
] as const;

type Period = (typeof periods)[number]['value'];
function todayInSofia() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const date = new Map(parts.map(({ type, value }) => [type, value]));
  return [date.get('year'), date.get('month'), date.get('day')].join('-');
}

export function WalletInvestmentsForm({
  settings, busy, onSave,
}: {
  settings: WalletInvestmentsDashboard['settings'];
  busy: boolean;
  onSave: (input: WalletSettingsInput) => Promise<void>;
}) {
  const [currency, setCurrency] = useState(settings.currency ?? 'EUR');
  const initialDigits = settings.currency ? currencyMinorDigits(settings.currency) ?? 2 : 2;
  const [cap, setCap] = useState(minorToInput(settings.authorized_amount_minor, initialDigits));
  const [asset, setAsset] = useState(settings.instrument_code ?? '');
  const [strategy, setStrategy] = useState(settings.strategy_label ?? '');
  const [access, setAccess] = useState<WalletSettingsInput['ai_access']>(settings.ai_access);
  const [period, setPeriod] = useState<Period>(settings.horizon?.period ?? '');
  const [days, setDays] = useState(settings.horizon?.days?.toString() ?? '');
  const [startDate, setStartDate] = useState(() => settings.horizon?.start_date ?? todayInSofia());
  const [unit, setUnit] = useState<'none' | 'amount' | 'percent'>(settings.target?.amount_minor ? 'amount' : settings.target ? 'percent' : 'none');
  const [goal, setGoal] = useState(settings.target?.amount_minor
    ? minorToInput(settings.target.amount_minor, initialDigits)
    : minorToInput(settings.target?.return_bps?.toString() ?? null, 2));
  const [error, setError] = useState('');

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const selectedCurrency = currency.trim().toUpperCase() || null;
    const digits = selectedCurrency ? currencyMinorDigits(selectedCurrency) : null;
    if (selectedCurrency && digits === null) {
      setError('Въведи валиден трибуквен код на валута.');
      return;
    }
    const authorized = cap.trim() && digits !== null ? parseDecimalMinor(cap, digits) : null;
    if (cap.trim() && authorized === null) {
      setError('Въведи положителен лимит с точността на избраната валута.');
      return;
    }

    let target: WalletTargetInput | null = null;
    if (period) {
      const converted = unit === 'none' ? null : unit === 'percent'
        ? parseDecimalMinor(goal, 2)
        : digits === null ? null : parseDecimalMinor(goal, digits);
      if (unit !== 'none' && !converted) {
        setError('Въведи положителна стойност за целта.');
        return;
      }
      target = {
        period, days: period === 'days' && /^\d+$/.test(days) ? Number(days) : null,
        start_date: startDate,
        amount_minor: unit === 'amount' ? converted : null,
        return_bps: unit === 'percent' ? Number(converted) : null,
      };
    }
    const body = walletSettingsBody.safeParse({
      currency: selectedCurrency, authorized_amount_minor: authorized,
      instrument_code: asset.trim().toUpperCase() || null, strategy_label: strategy.trim() || null,
      ai_access: access, target,
    });
    if (!body.success) {
      setError('Провери кода на актива, периода, началната дата и стойността на целта.');
      return;
    }
    await onSave(body.data);
  }

  return (
    <form className="module-wallet-form" onSubmit={(event) => void save(event)} aria-busy={busy}>
      <fieldset disabled={busy} className="module-wallet-fields">
        <legend>Капитал и достъп</legend>
        <label>Валута <input value={currency} maxLength={3} onChange={(event) => setCurrency(event.target.value)} /></label>
        <label>Лимит върху отделената печалба <input inputMode="decimal" value={cap} onChange={(event) => setCap(event.target.value)} /></label>
        <label>Достъп на Shark AI
          <select value={access} onChange={(event) => setAccess(event.target.value as WalletSettingsInput['ai_access'])}>
            <option value="off">Изключен</option>
            <option value="analysis_only">Само анализ</option>
          </select>
        </label>
      </fieldset>
      <fieldset disabled={busy} className="module-wallet-fields">
        <legend>Цел и параметри за анализ</legend>
        <p>При една потвърдена стратегия в избраната валута активът и стратегията могат да останат празни.</p>
        <p>В края на избрания период Shark AI начислява 10% върху новата реализирана и уредена нетна печалба над последния таксуван максимум. Първо се възстановяват натрупаните загуби. Например при 100 EUR нова допустима печалба таксата е 10 EUR и 90 EUR остават за теб.</p>
        <label>Код на актив <input value={asset} maxLength={32} onChange={(event) => setAsset(event.target.value)} /></label>
        <label>Стратегия <input value={strategy} maxLength={100} onChange={(event) => setStrategy(event.target.value)} /></label>
        <label>Период
          <select value={period} onChange={(event) => setPeriod(event.target.value as Period)}>
            {periods.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        {period === 'days' && <label>Брой дни <input inputMode="numeric" value={days} required onChange={(event) => setDays(event.target.value)} /></label>}
        {period && <>
          <label>Начална дата <input type="date" value={startDate} required onChange={(event) => setStartDate(event.target.value)} /></label>
          <label>Мерна единица
            <select value={unit} onChange={(event) => setUnit(event.target.value as 'none' | 'amount' | 'percent')}>
              <option value="none">Без цел</option>
              <option value="percent">Процент</option>
              <option value="amount">Сума в избраната валута</option>
            </select>
          </label>
          {unit !== 'none' && <label>Целева печалба <input inputMode="decimal" required value={goal} onChange={(event) => setGoal(event.target.value)} /></label>}
        </>}
      </fieldset>
      {error && <p className="module-error" role="alert">{error}</p>}
      <button className="shark-action" type="submit" disabled={busy}>Запази настройките</button>
    </form>
  );
}
