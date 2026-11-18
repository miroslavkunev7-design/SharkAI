const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const base = new URL(process.env.SHARKAI_TEST_URL || 'http://127.0.0.1:3847');
const db = new URL(process.env.POSTGRES_PRISMA_URL || 'postgresql://localhost');
const loopback = ['localhost', '127.0.0.1', '[::1]'];
assert(loopback.includes(base.hostname) && loopback.includes(db.hostname), 'Use a local app and a disposable database.');
const prisma = new PrismaClient();
const emails = [`reminder-${randomUUID()}@example.test`, `reminder-${randomUUID()}@example.test`];
const apiPath = '/api/chat/reminders';
const timeZone = 'Europe/Sofia';
const futureYear = new Date().getUTCFullYear() + 1;

async function request(path, cookie, method = 'GET', body) {
  return fetch(new URL(path, base), { method, headers: {
    ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
  }, body: body ? JSON.stringify(body) : undefined });
}

async function call(path, cookie, method, body, expected = 200) {
  const response = await request(path, cookie, method, body);
  const data = await response.json();
  assert.equal(response.status, expected, `${method || 'GET'} ${path}: ${data.error || ''}`);
  return data;
}

async function register(email) {
  const res = await request('/api/auth/register', null, 'POST', { email, password: randomUUID() });
  const body = await res.json();
  assert.equal(res.status, 200, body.error);
  return { id: body.user.id, cookie: res.headers.get('set-cookie').split(';')[0] };
}

function localAt(date) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date).replace(' ', 'T');
}

async function run() {
  await call(apiPath, null, 'GET', undefined, 401);
  const [a, b] = await Promise.all(emails.map(register));
  const initial = { text: 'Check inbox', localTime: `${futureYear}-01-30T10:00`, timeZone, repeat: 'NONE', requestId: randomUUID() };
  const { reminder: once } = await call(apiPath, a.cookie, 'POST', initial);
  assert.equal(once.nextAt, `${futureYear}-01-30T08:00:00.000Z`);
  assert.equal((await call(apiPath, a.cookie, 'POST', initial)).reminder.id, once.id);
  await call(apiPath, a.cookie, 'POST', { ...initial, requestId: randomUUID(), timeZone: 'Europe/Unknown' }, 400);
  await call(apiPath, a.cookie, 'POST', { ...initial, requestId: randomUUID(), localTime: '2000-01-01T10:00' }, 400);

  const dailyRequest = { ...initial, text: 'Water plants', repeat: 'DAILY', requestId: randomUUID() };
  let repetitionId;
  if (process.env.SHARKAI_TEST_REMINDER_CHAT === '1') {
    const { requestId, ...reminder } = dailyRequest;
    const conversationId = randomUUID();
    const payload = { conversationId, requestId, mode: 'work', toolId: 'scheduled-task', message: reminder.text, reminder };
    const created = await call('/api/chat', a.cookie, 'POST', payload);
    repetitionId = created.toolResult.reminderId;
    assert(repetitionId);
    assert.equal((await call('/api/chat', a.cookie, 'POST', payload)).toolResult.reminderId, repetitionId);
    const history = await call(`/api/chat?conversationId=${conversationId}`, a.cookie);
    assert.equal(history.messages.at(-1).toolResult.reminderId, repetitionId);
    const natural = await call('/api/chat', a.cookie, 'POST', {
      conversationId: randomUUID(), requestId: randomUUID(), mode: 'work',
      message: `Напомни ми да проверя графика на ${futureYear}-01-31 в 11:00 Europe/Sofia всеки месец.`,
    });
    assert(natural.toolResult.reminderId);
    const tasks = (await call(apiPath, a.cookie)).reminders;
    assert.equal(tasks.find(({ id }) => id === natural.toolResult.reminderId).repeat, 'MONTHLY');
  } else {
    repetitionId = (await call(apiPath, a.cookie, 'POST', dailyRequest)).reminder.id;
  }

  const twiceDue = new Date(Math.floor((Date.now() - 42 * 3600_000) / 60_000) * 60_000);
  const dueOnce = new Date(Math.floor((Date.now() - 100_000) / 60_000) * 60_000);
  await prisma.reminder.update({ where: { id: once.id }, data: { nextAt: dueOnce, nextLocal: localAt(dueOnce) } });
  await prisma.reminder.update({ where: { id: repetitionId }, data: { nextAt: twiceDue, nextLocal: localAt(twiceDue) } });
  await Promise.all(Array.from({ length: 3 }, () => call(apiPath, a.cookie)));
  const active = await call(apiPath, a.cookie);
  assert.equal(active.notifications.filter(({ reminderId }) => reminderId === once.id).length, 1);
  assert.equal(active.notifications.filter(({ reminderId }) => reminderId === repetitionId).length, 2);
  assert.equal(active.reminders.find(({ id }) => id === once.id).nextAt, null);
  assert(new Date(active.reminders.find(({ id }) => id === repetitionId).nextAt) > new Date());
  assert.deepEqual((await call(apiPath, a.cookie)).notifications, active.notifications);
  assert.equal(await prisma.reminderOccurrence.count({ where: { reminderId: repetitionId } }), 2);

  assert.deepEqual(await call(apiPath, b.cookie), { reminders: [], notifications: [] });
  const delivered = active.notifications.find(({ reminderId }) => reminderId === once.id);
  await call(apiPath, b.cookie, 'PATCH', { action: 'acknowledge', id: delivered.id }, 404);
  await call(apiPath, a.cookie, 'PATCH', { action: 'acknowledge', id: delivered.id });
  await call(apiPath, a.cookie, 'PATCH', { action: 'acknowledge', id: delivered.id });
  await call(apiPath, b.cookie, 'PATCH', { action: 'cancel', id: repetitionId }, 404);
  await call(apiPath, a.cookie, 'PATCH', { action: 'cancel', id: repetitionId });
  await call(apiPath, a.cookie, 'PATCH', { action: 'cancel', id: repetitionId });
  const reopened = await call(apiPath, a.cookie);
  const canceled = reopened.reminders.find(({ id }) => id === repetitionId);
  assert.equal(canceled.nextAt, null);
  assert(canceled.cancelledAt);
  assert(!reopened.notifications.some(({ id }) => id === delivered.id));
  assert.equal(reopened.notifications.filter(({ reminderId }) => reminderId === repetitionId).length, 2);
  console.log('Reminder API passed for creation, clock conversion, idempotent recurrence, isolation, cancel, acknowledgment and reload.');
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});
