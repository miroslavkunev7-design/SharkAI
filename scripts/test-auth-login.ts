import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { jwtVerify } from 'jose';
import { NextRequest } from 'next/server';
import { POST as loginRoute } from '../app/api/auth/login/route';
import { createToken, hashPassword, requireSessionConfiguration, SessionConfigurationError } from '../lib/auth';
import { prisma } from '../lib/db';

const base = new URL(process.env.SHARKAI_AUTH_TEST_URL || 'http://127.0.0.1:3847');
const local = ['localhost', '127.0.0.1', '[::1]'];
assert(local.includes(base.hostname) && local.includes(new URL(process.env.POSTGRES_PRISMA_URL ?? '').hostname), 'Use a disposable local web server and PostgreSQL database.');

async function verifyMissingSecret() {
  const { NODE_ENV, JWT_SECRET } = process.env;
  try {
    Reflect.set(process.env, 'NODE_ENV', 'production');
    delete process.env.JWT_SECRET;
    const request = new NextRequest(base, {
      method: 'POST', body: JSON.stringify({ email: `missing-auth-${randomUUID()}@example.test`, password: randomUUID() }),
    });
    const response = await loginRoute(request);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'SESSION_UNAVAILABLE');
    assert.equal(response.headers.has('set-cookie'), false);
    for (const placeholder of [' \t ', 'sharkai-dev-secret', ' change-me-long-random-secret ']) {
      process.env.JWT_SECRET = placeholder;
      assert.throws(requireSessionConfiguration, SessionConfigurationError);
    }
    const key = ` ${randomUUID()} `;
    process.env.JWT_SECRET = key;
    const fixture = { id: randomUUID(), email: 'jwt-bytes@example.test', name: null, role: 'USER', plan: 'FREE' } as const;
    const token = await createToken(fixture);
    assert.equal((await jwtVerify(token, new TextEncoder().encode(key))).payload.id, fixture.id);
  } finally {
    if (NODE_ENV === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
    else Reflect.set(process.env, 'NODE_ENV', NODE_ENV);
    if (JWT_SECRET === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = JWT_SECRET;
  }
}

async function login(email: string, password: string, expect: number) {
  const response = await fetch(new URL('/api/auth/login', base), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(25_000),
  });
  const data = await response.json();
  assert.equal(response.status, expect, data.error);
  const cookie = response.headers.get('set-cookie');
  if (expect !== 200) {
    assert.equal(cookie, null);
    return null;
  }
  assert(cookie);
  assert.match(cookie, /^sharkai_token=/);
  assert.match(cookie, /; HttpOnly(?:;|$)/i);
  assert.match(cookie, /; SameSite=lax(?:;|$)/i);
  if (process.env.SHARKAI_AUTH_TEST_SECURE_COOKIE === '1') assert.match(cookie, /; Secure(?:;|$)/i);
  return { user: data.user, cookie: cookie.split(';', 1)[0] };
}

async function run() {
  const tag = process.env.SHARKAI_AUTH_TEST_TAG ?? randomUUID();
  assert(/^[a-f\d-]{30,40}$/i.test(tag));
  const email = `Legacy_Auth_${tag}@example.test`;
  const alternative = email.toUpperCase();
  const password = ` ${randomUUID()} `;
  const ids: string[] = [];
  try {
    const admin = await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), role: 'ADMIN', plan: 'FREE' } });
    ids.push(admin.id);
    await login(email, password.trim(), 401);
    await login(`Legacy%Auth_${tag}@example.test`, password, 401);
    const exact = await login(email, password, 200);
    const spaced = await login(`\u2003${email}\u2003`, password, 200);
    const loose = await login(email.toLowerCase(), password, 200);
    for (const result of [exact, spaced, loose]) {
      assert.equal(result?.user.id, admin.id);
      assert.equal(result?.user.email, admin.email);
      assert.equal(result?.user.role, 'ADMIN');
    }
    const session = await fetch(new URL('/api/payments/status', base), { headers: { Cookie: loose!.cookie }, signal: AbortSignal.timeout(25_000) });
    assert.equal(session.status, 200);
    const entitlement = await session.json();
    assert.equal(entitlement.canPurchase, false);
    assert.equal(entitlement.period, null);
    if (process.env.SHARKAI_AUTH_TEST_EXPECT_OWNER === '1') {
      assert.equal(entitlement.plan, 'ULTRA');
      assert.equal(entitlement.lifetime, true);
    }

    const duplicatePassword = randomUUID();
    const duplicate = await prisma.user.create({ data: { email: alternative, passwordHash: await hashPassword(duplicatePassword) } });
    ids.push(duplicate.id);
    await login(email.toLowerCase(), password, 401);
    await login(email.toLowerCase(), duplicatePassword, 401);
    await login(alternative, password, 401);
    assert.equal((await login(alternative, duplicatePassword, 200))?.user.id, duplicate.id);
    assert.equal((await login(email, password, 200))?.user.id, admin.id);
    const malformed = await fetch(new URL('/api/auth/login', base), { method: 'POST', body: '{invalid json', signal: AbortSignal.timeout(25_000) });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.headers.has('set-cookie'), false);
    assert.deepEqual(await prisma.user.findUniqueOrThrow({ where: { id: admin.id } }), admin);
    assert.deepEqual(await prisma.user.findUniqueOrThrow({ where: { id: duplicate.id } }), duplicate);
    await verifyMissingSecret();
    console.log('Auth login passed over HTTP: existing ID/hash, normalized unique email, case ambiguity, literal characters, protected cookie, reloaded session, and signing preflight.');
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
}

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
