import { z } from 'zod';

const MAX_INT = 2_147_483_647;
const MAX_MINOR = BigInt('9223372036854775807');
const SUPPORTED_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const DAY_MS = 86_400_000;
const positiveMinor = z.string().refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= MAX_MINOR);

const targetInput = z.object({
  period: z.enum(['day', 'days', 'week', 'month']),
  days: z.number().int().positive().max(MAX_INT).nullable(),
  amount_minor: positiveMinor.nullable(),
  return_bps: z.number().int().positive().max(MAX_INT).nullable(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

export type WalletTargetInput = z.infer<typeof targetInput>;

export function targetCalendar(target: WalletTargetInput) {
  const start = new Date(target.start_date + 'T00:00:00.000Z');
  if (!Number.isFinite(start.valueOf()) || start.toISOString().slice(0, 10) !== target.start_date) return null;
  if ((target.period === 'days') !== (target.days !== null)) return null;

  const end = new Date(start);
  if (target.period === 'month') {
    end.setUTCDate(1);
    end.setUTCMonth(end.getUTCMonth() + 1);
    const last = new Date(end);
    last.setUTCMonth(last.getUTCMonth() + 1, 0);
    end.setUTCDate(Math.min(start.getUTCDate(), last.getUTCDate()));
  } else {
    const days = target.period === 'week' ? 7 : target.days ?? 1;
    end.setUTCDate(end.getUTCDate() + days);
  }
  if (!Number.isFinite(end.valueOf())) return null;
  const endDate = end.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return null;
  return { target_date: endDate, horizon_days: (end.valueOf() - start.valueOf()) / DAY_MS };
}

export const walletSettingsBody = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/).refine((value) => SUPPORTED_CURRENCIES.has(value)).nullable(),
  authorized_amount_minor: positiveMinor.nullable(),
  instrument_code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$/).nullable(),
  strategy_label: z.string().trim().min(1).max(100).refine((value) => !/\p{Cc}/u.test(value)).nullable(),
  ai_access: z.enum(['off', 'analysis_only']),
  target: targetInput.nullable(),
}).strict().superRefine((settings, context) => {
  if (settings.currency === null && (settings.authorized_amount_minor !== null || settings.target?.amount_minor)) {
    context.addIssue({ code: 'custom', path: ['currency'], message: 'Въведи валута за сумите.' });
  }
  if (settings.target && (!targetCalendar(settings.target)
      || (settings.target.amount_minor !== null && settings.target.return_bps !== null))) {
    context.addIssue({ code: 'custom', path: ['target'], message: 'Провери началната дата, периода и стойността на целта.' });
  }
});

export type WalletSettingsInput = z.infer<typeof walletSettingsBody>;

export function currencyMinorDigits(currency: string) {
  if (!SUPPORTED_CURRENCIES.has(currency)) return null;
  return new Intl.NumberFormat('bg-BG', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

export function parseDecimalMinor(value: string, digits: number) {
  const match = /^([0-9]{1,19})(?:[.,]([0-9]{1,4}))?$/.exec(value.trim());
  if (!match) return null;
  const [, whole, fraction = ''] = match;
  if (fraction.length > digits) return null;
  const units = BigInt(whole + fraction.padEnd(digits, '0'));
  return units > BigInt(0) && units <= MAX_MINOR ? units.toString() : null;
}

export function minorToInput(minor: string | null, digits: number) {
  if (minor === null) return '';
  if (digits === 0) return minor;
  const sign = minor.startsWith('-') ? '-' : '';
  const value = (sign ? minor.slice(1) : minor).padStart(digits + 1, '0');
  return sign + value.slice(0, -digits) + ',' + value.slice(-digits);
}

export function displayMinor(minor: string | null, currency: string | null) {
  const digits = currency === null ? null : currencyMinorDigits(currency);
  if (minor === null || digits === null) return 'Недостъпно';
  const [whole, fraction] = minorToInput(minor, digits).split(',');
  const formatted = new Intl.NumberFormat('bg-BG').format(BigInt(whole));
  const sign = whole === '-0' ? '−' : '';
  return sign + formatted + (fraction === undefined ? '' : ',' + fraction) + ' ' + currency;
}
