import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/db';
import { readChatMemory } from '../lib/personal-memory.server';
import { MAX_MEMORY_NOTE_LENGTH, MAX_MEMORY_NOTES, type MemoryChange, type PersonalMemory } from '../lib/personal-memory';

const base = new URL(process.env.SHARKAI_TEST_URL || 'http://127.0.0.1:3847');
const database = new URL(process.env.POSTGRES_PRISMA_URL ?? '');
const loopback = ['localhost', '127.0.0.1', '[::1]'];
assert.ok(loopback.includes(base.hostname) && loopback.includes(database.hostname), 'Use a local server and test database.');
const emails: string[] = [];

async function account() {
  const email = 'memory-test-' + randomUUID() + '@example.test';
  emails.push(email);
  const response = await fetch(new URL('/api/auth/register', base), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: randomUUID(), name: 'Local personal memory fixture' }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const { user } = await response.json();
  return { id: user.id as string, cookie };
}

async function change(cookie: string, revision: number, data: MemoryChange, expected = 200): Promise<PersonalMemory> {
  const response = await fetch(new URL('/api/settings/memory', base), {
    method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision, ...data }),
  });
  const result = await response.json();
  assert.equal(response.status, expected, result.error);
  return result;
}

async function get(cookie?: string, expected = 200): Promise<PersonalMemory> {
  const response = await fetch(new URL('/api/settings/memory', base), { headers: cookie ? { Cookie: cookie } : undefined });
  const memory = await response.json();
  assert.equal(response.status, expected, memory.error);
  assert.match(response.headers.get('cache-control') ?? '', /private, no-store/);
  return memory;
}

async function run() {
  await get(undefined, 401);
  const [a, b] = await Promise.all([account(), account()]);
  assert.deepEqual(await get(a.cookie), { enabled: false, revision: 0, notes: [] });
  assert.deepEqual(await readChatMemory(a.id), []);
  await change(a.cookie, 0, { action: 'add', text: 'No implicit opt-in.' }, 409);
  let state = await change(a.cookie, 0, { action: 'enable', enabled: true });
  const text = 'Предпочитам кратки обяснения.';
  state = await change(a.cookie, state.revision, { action: 'add', text: '  ' + text + '  ' });
  const [note] = state.notes;
  assert.equal(note.text, text);
  assert.deepEqual(await get(a.cookie), state);
  assert.deepEqual(await readChatMemory(a.id), [text]);
  assert.deepEqual(await get(b.cookie), { enabled: false, revision: 0, notes: [] });
  assert.deepEqual(await readChatMemory(b.id), []);
  await change(b.cookie, 0, { action: 'edit', id: note.id, text: 'Private fixture' }, 404);
  await change(b.cookie, 0, { action: 'delete', id: note.id }, 404);
  await change(a.cookie, state.revision - 1, { action: 'clear' }, 409);
  await change(a.cookie, state.revision, { action: 'add', text: 'a'.repeat(MAX_MEMORY_NOTE_LENGTH + 1) }, 400);

  const edited = 'Предпочитам отговори в таблица.';
  state = await change(a.cookie, state.revision, { action: 'edit', id: note.id, text: edited });
  assert.deepEqual(await readChatMemory(a.id), [edited]);
  state = await change(a.cookie, state.revision, { action: 'enable', enabled: false });
  assert.deepEqual(await readChatMemory(a.id), []);
  assert.equal((await get(a.cookie)).notes[0].text, edited);
  state = await change(a.cookie, state.revision, { action: 'delete', id: note.id });
  assert.deepEqual(state.notes, []);

  state = await change(a.cookie, state.revision, { action: 'enable', enabled: true });
  const concurrent = (text: string) => fetch(new URL('/api/settings/memory', base), {
    method: 'PATCH', headers: { Cookie: a.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: state.revision, action: 'add', text }),
  });
  assert.deepEqual((await Promise.all([concurrent('One'), concurrent('Two')])).map((response) => response.status).sort(), [200, 409]);
  state = await get(a.cookie);
  assert.equal(state.notes.length, 1);
  for (let i = 1; i < MAX_MEMORY_NOTES; i++) {
    state = await change(a.cookie, state.revision, { action: 'add', text: 'Fixture ' + i });
  }
  await change(a.cookie, state.revision, { action: 'add', text: 'Exceeds account storage.' }, 409);
  state = await change(a.cookie, state.revision, { action: 'clear' });
  assert.equal(state.enabled, true);
  assert.deepEqual(state.notes, []);
  assert.deepEqual(await readChatMemory(a.id), []);
  assert.deepEqual(await get(b.cookie), { enabled: false, revision: 0, notes: [] });
  console.log('Personal memory passed: opt-in, retained private notes, edit/deletion/clear, disabled context, concurrent revision guard, per-account isolation and bounds.');
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});
