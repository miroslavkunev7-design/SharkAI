import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import bcrypt from 'bcryptjs';
import { prisma } from './db';
import type { Role, Plan } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { getEffectivePlan, hasLifetimeUltraAccess } from './billing';

export const LEGACY_GUEST_EMAIL = 'guest@sharkai.local';
const developmentSecret = randomBytes(32);

export class SessionConfigurationError extends Error {}

function sessionSecret() {
  const configured = process.env.JWT_SECRET;
  const trimmed = configured?.trim();
  if (configured && trimmed && !['sharkai-dev-secret', 'change-me-long-random-secret'].includes(trimmed)) {
    return new TextEncoder().encode(configured);
  }
  if (process.env.NODE_ENV === 'production') throw new SessionConfigurationError('JWT_SECRET is not configured');
  return developmentSecret;
}

export function requireSessionConfiguration() {
  sessionSecret();
}

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  plan: Plan;
}

export interface AccountSession extends SessionUser {
  tokensUsed: number;
  tokensLimit: number;
  lifetime?: true;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

type LoginAccount = SessionUser & { passwordHash: string };
const loginAccountSelect = { id: true, email: true, name: true, role: true, plan: true, passwordHash: true } as const;

async function findLoginAccount(email: string): Promise<LoginAccount | null> {
  const trimmed = email.trim();
  const exact = await prisma.user.findMany({
    where: { email: { in: email === trimmed ? [email] : [email, trimmed] } },
    select: loginAccountSelect,
  });
  const preferred = exact.find((account) => account.email === email) ?? exact[0];
  if (preferred || !trimmed) return preferred ?? null;

  // Any case-insensitive match must be unique. Existing exact addresses retain precedence.
  const matches = await prisma.$queryRaw<LoginAccount[]>`
    SELECT "id", "email", "name", "role", "plan", "passwordHash" FROM "User"
    WHERE LOWER("email") = LOWER(${trimmed}) LIMIT 2
  `;
  return matches.length === 1 ? matches[0] : null;
}

export async function authenticatePassword(email: string, password: string): Promise<SessionUser | null> {
  const user = await findLoginAccount(email);
  if (!user || user.email === LEGACY_GUEST_EMAIL || !(await verifyPassword(password, user.passwordHash))) return null;
  return { id: user.id, email: user.email, name: user.name, role: user.role, plan: await getEffectivePlan(user) };
}

export async function createToken(user: SessionUser): Promise<string> {
  return new SignJWT({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    plan: user.plan,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('7d')
    .setIssuedAt()
    .sign(sessionSecret());
}

export async function verifyToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, sessionSecret(), { algorithms: ['HS256'] });
    if (typeof payload.id !== 'string' || payload.email === LEGACY_GUEST_EMAIL) return null;
    return {
      id: payload.id as string,
      email: payload.email as string,
      name: (payload.name as string) ?? null,
      role: payload.role as Role,
      plan: payload.plan as Plan,
    };
  } catch {
    return null;
  }
}

export async function getSession(): Promise<AccountSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get('sharkai_token')?.value;
  if (!token) return null;
  const claims = await verifyToken(token);
  if (!claims) return null;
  return getAccountSession(claims.id);
}

export async function getAccountSession(userId: string): Promise<AccountSession | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true, plan: true, tokensUsed: true, tokensLimit: true },
  });
  if (!user || user.email === LEGACY_GUEST_EMAIL) return null;
  const plan = await getEffectivePlan(user);
  return { ...user, plan, tokensLimit: plan === 'PRO' && user.plan === 'FREE' ? 100_000 : user.tokensLimit,
    ...(hasLifetimeUltraAccess(user) && { lifetime: true }) };
}

export async function requireSession(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) throw new Error('Unauthorized');
  return session;
}

export async function requireAdmin(): Promise<SessionUser> {
  const session = await requireSession();
  if (session.role !== 'ADMIN') throw new Error('Forbidden');
  return session;
}

export async function setAuthCookie(token: string) {
  const cookieStore = await cookies();
  cookieStore.set('sharkai_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7,
    path: '/',
  });
}

export async function clearAuthCookie() {
  const cookieStore = await cookies();
  cookieStore.delete('sharkai_token');
}

export async function getUserFromDb(id: string) {
  return prisma.user.findUnique({ where: { id } });
}
