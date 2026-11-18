import { z } from 'zod';

const timeZone = /^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/;

export const reminderInputSchema = z.object({
  text: z.string().trim().min(1).max(500),
  localTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  timeZone: z.string().trim().max(100).regex(timeZone),
  repeat: z.enum(['NONE', 'DAILY', 'WEEKLY', 'MONTHLY']).default('NONE'),
});

export type ReminderInput = z.output<typeof reminderInputSchema>;

const recurrence: Record<string, ReminderInput['repeat']> = {
  none: 'NONE', once: 'NONE', еднократно: 'NONE',
  daily: 'DAILY', 'every day': 'DAILY', 'всеки ден': 'DAILY', ежедневно: 'DAILY',
  weekly: 'WEEKLY', 'every week': 'WEEKLY', 'всяка седмица': 'WEEKLY', седмично: 'WEEKLY',
  monthly: 'MONTHLY', 'every month': 'MONTHLY', 'всеки месец': 'MONTHLY', месечно: 'MONTHLY',
};

export function parseReminderPrompt(prompt: string, now = new Date()): ReminderInput | null {
  const normalized = prompt.trim().replace(/^(?:моля|please)[,\s]+/iu, '');
  const explicit = /^(?:напомни(?:\s+ми)?|remind\s+me)\s*:\s*(.+)$/iu.exec(normalized);
  if (explicit && explicit[1].includes('|')) {
    const [text, local, zone, interval, ...extra] = explicit[1].split('|').map((part) => part.trim());
    const repeat = interval ? recurrence[interval.toLowerCase()] : 'NONE';
    return extra.length || !repeat ? null : parse({ text, localTime: local?.replace(' ', 'T'), timeZone: zone, repeat });
  }
  const match = /^(?:напомни(?:\s+ми)?(?:\s+да)?|(?:планирай|създай)\s+напомняне(?:\s+да)?|remind\s+me(?:\s+to)?)[:\s]+(.+?)\s+(?:(?:на|on)\s+)?(\d{4}-\d{2}-\d{2}|днес|утре|today|tomorrow)(?:T|\s+(?:(?:в|at)\s+)?)(\d{2}:\d{2})\s+(UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)(?:\s+([^.!?]+))?[.!?]*$/iu.exec(normalized);
  if (!match) return null;
  const [, text, day, clock, zone, interval] = match;
  const repeat = interval ? recurrence[interval.trim().toLowerCase()] : 'NONE';
  const date = resolveDay(day, zone, now);
  return repeat && date ? parse({ text, localTime: `${date}T${clock}`, timeZone: zone, repeat }) : null;
}

function resolveDay(day: string, timeZone: string, now: Date): string | null {
  if (/^\d/.test(day)) return day;
  const tomorrow = ['утре', 'tomorrow'].includes(day.toLowerCase());
  try {
    const localToday = new Intl.DateTimeFormat('sv-SE', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
    return new Date(Date.parse(`${localToday}T00:00:00Z`) + (tomorrow ? 86_400_000 : 0)).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function parse(value: unknown): ReminderInput | null {
  const parsed = reminderInputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
