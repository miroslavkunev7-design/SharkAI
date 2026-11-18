import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import bcrypt from 'bcryptjs';
import { prisma } from './db';
import type { Role, Plan } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { getEffectivePlan } from './billing';

export const LEGACY_GUEST_EMAIL = 'guest@sharkai.local';
const developmentSecret = randomBytes(32);

function sessionSecret() {
  const configured = process.env.JWT_SECRET;
  if (configured && configured !== 'sharkai-dev-secret') return new TextEncoder().encode(configured);
  if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET is not configured');
  return developmentSecret;
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

  const user = await prisma.user.findUnique({
    where: { id: claims.id },
    select: { id: true, email: true, name: true, role: true, plan: true, tokensUsed: true, tokensLimit: true },
  });
  if (!user || user.email === LEGACY_GUEST_EMAIL) return null;
  const plan = await getEffectivePlan(user);
  return { ...user, plan, tokensLimit: plan === 'PRO' && user.plan === 'FREE' ? 100_000 : user.tokensLimit };
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
