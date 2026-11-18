import { randomUUID } from 'node:crypto';
import { Prisma, type Reminder } from '@prisma/client';
import { prisma } from './db';
import { parseReminderPrompt, reminderInputSchema, type ReminderInput } from './reminder-input';
import { nextReminderLocal, reminderInstant } from './reminder-time';

const reminderSelect = {
  id: true, text: true, localTime: true, timeZone: true, repeat: true, nextAt: true, cancelledAt: true, createdAt: true,
} satisfies Prisma.ReminderSelect;

export class ReminderInputError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export async function createReminder(userId: string, requestId: string, input: ReminderInput, now = new Date()) {
  const key = { userId_requestId: { userId, requestId } };
  const prior = await prisma.reminder.findUnique({ where: key, select: reminderSelect });
  if (prior) return prior;
  const parsed = reminderInputSchema.safeParse(input);
  if (!parsed.success) throw new ReminderInputError('Провери текста, датата, часовата зона и повторението на напомнянето.');
  const { text, timeZone, localTime, repeat } = parsed.data;
  let nextAt: Date | null;
  try {
    nextAt = reminderInstant(localTime, timeZone);
  } catch {
    throw new ReminderInputError('Избери валидна часова зона, например Europe/Sofia.');
  }
  if (!nextAt) throw new ReminderInputError('Тази дата или местен час не съществува в избраната часова зона.');
  if (nextAt <= now) throw new ReminderInputError('Избери дата и час след текущия момент.');
  try {
    return await prisma.reminder.create({
      data: { id: randomUUID(), userId, requestId, text, localTime, timeZone, repeat, nextAt, nextLocal: localTime },
      select: reminderSelect,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return prisma.reminder.findUniqueOrThrow({ where: key, select: reminderSelect });
    }
    throw error;
  }
}

export function createReminderFromPrompt(userId: string, requestId: string, prompt: string) {
  const input = parseReminderPrompt(prompt);
  if (!input) {
    const example = new Date(Date.now() + 172_800_000).toISOString().slice(0, 10);
    throw new ReminderInputError(`Посочи текст, дата, час и часова зона. Можеш да напишеш „Напомни ми да проверя пощата на ${example} 10:00 Europe/Sofia всяка седмица“.`);
  }
  return createReminder(userId, requestId, input);
}

async function deliver(reminder: Pick<Reminder, 'id' | 'userId' | 'nextAt' | 'nextLocal' | 'localTime' | 'repeat' | 'timeZone'>, now: Date) {
  if (!reminder.nextAt || !reminder.nextLocal) return;
  let nextAt: Date | null = reminder.nextAt;
  let nextLocal: string | null = reminder.nextLocal;
  const pending: Prisma.ReminderOccurrenceCreateManyInput[] = [];
  // Advance in bounded batches so a long absence can be processed over several status requests.
  while (nextAt && nextLocal && nextAt <= now && pending.length < 32) {
    pending.push({ id: randomUUID(), reminderId: reminder.id, dueAt: nextAt });
    nextLocal = nextReminderLocal(nextLocal, reminder.localTime, reminder.repeat);
    nextAt = nextLocal ? reminderInstant(nextLocal, reminder.timeZone, true) : null;
  }
  if (!pending.length) return;
  await prisma.$transaction(async (tx) => {
    const claim = await tx.reminder.updateMany({
      where: { id: reminder.id, userId: reminder.userId, nextAt: reminder.nextAt, nextLocal: reminder.nextLocal, cancelledAt: null },
      data: { nextAt, nextLocal },
    });
    if (claim.count) await tx.reminderOccurrence.createMany({ data: pending, skipDuplicates: true });
  });
}

export async function listReminders(userId: string, now = new Date()) {
  const due = await prisma.reminder.findMany({
    where: { userId, nextAt: { lte: now }, cancelledAt: null },
    orderBy: { nextAt: 'asc' }, take: 24,
    select: { id: true, userId: true, nextAt: true, nextLocal: true, localTime: true, repeat: true, timeZone: true },
  });
  for (const reminder of due) await deliver(reminder, now);
  const [reminders, rows] = await Promise.all([
    prisma.reminder.findMany({ where: { userId }, select: reminderSelect, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 100 }),
    prisma.reminderOccurrence.findMany({
      where: { reminder: { userId }, acknowledgedAt: null, dueAt: { lte: now } },
      select: { id: true, reminderId: true, dueAt: true, reminder: { select: { text: true, timeZone: true } } },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }], take: 100,
    }),
  ]);
  const notifications = rows.map(({ reminder, ...occurrence }) => ({ ...occurrence, ...reminder }));
  return { reminders, notifications };
}

export async function cancelReminder(userId: string, id: string, now = new Date()) {
  const where = { id, userId };
  const changed = await prisma.reminder.updateMany({
    where: { ...where, cancelledAt: null }, data: { cancelledAt: now, nextAt: null, nextLocal: null },
  });
  if (!changed.count && !(await prisma.reminder.findFirst({ where, select: { id: true } }))) {
    throw new ReminderInputError('Напомнянето не е намерено.', 404);
  }
}

export async function acknowledgeReminder(userId: string, id: string, now = new Date()) {
  const where = { id, reminder: { userId } };
  const changed = await prisma.reminderOccurrence.updateMany({
    where: { ...where, acknowledgedAt: null }, data: { acknowledgedAt: now },
  });
  if (!changed.count && !(await prisma.reminderOccurrence.findFirst({ where, select: { id: true } }))) {
    throw new ReminderInputError('Известието не е намерено.', 404);
  }
}
