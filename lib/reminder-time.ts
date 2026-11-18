import type { ReminderInput } from './reminder-input';

const DAY = 86_400_000;

type Recurrence = ReminderInput['repeat'];

function localMinute(ms: number) {
  return new Date(ms).toISOString().slice(0, 16);
}

function parseMinute(local: string) {
  const ms = Date.parse(`${local}:00.000Z`);
  return Number.isFinite(ms) && localMinute(ms) === local ? ms : null;
}

function dateInZone(timeZone: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
}

function wallAt(formatter: Intl.DateTimeFormat, instant: number) {
  const parts = new Map(formatter.formatToParts(instant).map(({ type, value }) => [type, value]));
  return Date.parse(`${parts.get('year')}-${parts.get('month')}-${parts.get('day')}T${parts.get('hour')}:${parts.get('minute')}:00.000Z`);
}

export function reminderInstant(local: string, timeZone: string, shiftDstGap = false): Date | null {
  const desired = parseMinute(local);
  if (desired === null) return null;
  const formatter = dateInZone(timeZone);
  const offsets = new Set([desired - 2 * DAY, desired, desired + 2 * DAY].map((instant) => wallAt(formatter, instant) - instant));
  const matches = [...offsets].map((offset) => {
    const instant = desired - offset;
    return { instant, wall: wallAt(formatter, instant) };
  }).filter(({ wall }) => wall === desired || (shiftDstGap && wall > desired));
  // During the fall overlap use the earlier occurrence. For recurring spring gaps move forward by the local clock change.
  matches.sort((a, b) => (a.wall - b.wall) || (a.instant - b.instant));
  return matches.length ? new Date(matches[0].instant) : null;
}

export function nextReminderLocal(currentLocal: string, firstLocal: string, repeat: Recurrence): string | null {
  if (repeat === 'NONE') return null;
  const current = parseMinute(currentLocal);
  if (current === null) return null;
  if (repeat === 'DAILY' || repeat === 'WEEKLY') return localMinute(current + DAY * (repeat === 'DAILY' ? 1 : 7));
  const date = new Date(current);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const anchorDay = Number(firstLocal.slice(8, 10));
  const endOfFollowingMonth = new Date(Date.UTC(year, month + 2, 0)).getUTCDate();
  return localMinute(Date.UTC(year, month + 1, Math.min(anchorDay, endOfFollowingMonth), date.getUTCHours(), date.getUTCMinutes()));
}
