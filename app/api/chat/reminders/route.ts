import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { reminderInputSchema } from '@/lib/reminder-input';
import { acknowledgeReminder, cancelReminder, createReminder, listReminders, ReminderInputError } from '@/lib/reminders';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store' };
const createInput = reminderInputSchema.extend({ requestId: z.string().uuid() });
const changeInput = z.object({ id: z.string().uuid(), action: z.enum(['cancel', 'acknowledge']) });

async function respond(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) throw new ReminderInputError('Влез, за да отвориш напомнянията си.', 401);
    if (req.method === 'GET') return NextResponse.json(await listReminders(session.id), { headers });
    const body = await req.json().catch(() => null);
    if (req.method === 'POST') {
      const input = createInput.safeParse(body);
      if (!input.success) throw new ReminderInputError('Невалидни данни за напомняне.');
      const { requestId, ...data } = input.data;
      return NextResponse.json({ reminder: await createReminder(session.id, requestId, data) }, { headers });
    }
    const change = changeInput.safeParse(body);
    if (!change.success) throw new ReminderInputError('Невалидно действие за напомняне.');
    const { action, id } = change.data;
    await (action === 'cancel' ? cancelReminder(session.id, id) : acknowledgeReminder(session.id, id));
    return NextResponse.json({ ok: true }, { headers });
  } catch (error) {
    if (error instanceof ReminderInputError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers });
    }
    console.error('Reminder request failed:', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json({ error: 'Напомнянията не могат да се заредят. Опитай отново.' }, { status: 500, headers });
  }
}

export const GET = respond;
export const POST = respond;
export const PATCH = respond;
