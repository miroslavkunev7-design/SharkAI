import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { verifyPassword, createToken, setAuthCookie, LEGACY_GUEST_EMAIL } from '@/lib/auth';
import { getEffectivePlan } from '@/lib/billing';

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json();

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.email === LEGACY_GUEST_EMAIL || !(await verifyPassword(password, user.passwordHash))) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const sessionUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      plan: await getEffectivePlan(user),
    };

    const token = await createToken(sessionUser);
    await setAuthCookie(token);

    return NextResponse.json({ user: sessionUser });
  } catch {
    return NextResponse.json({ error: 'Login failed' }, { status: 500 });
  }
}
