import { NextRequest, NextResponse } from 'next/server';
import { authenticatePassword, createToken, requireSessionConfiguration, SessionConfigurationError, setAuthCookie } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const { email, password } = await req.json().catch(() => null) ?? {};
  if (typeof email !== 'string' || !email || email.includes('\0') || typeof password !== 'string') {
    return NextResponse.json({ error: 'Въведи имейл и парола.' }, { status: 400 });
  }

  try {
    requireSessionConfiguration();
    const user = await authenticatePassword(email, password);
    if (!user) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }
    await setAuthCookie(await createToken(user));
    return NextResponse.json({ user });
  } catch (error) {
    const configMissing = error instanceof SessionConfigurationError;
    console.error('Login unavailable:', configMissing ? 'session configuration' : error instanceof Error ? error.name : 'unknown failure');
    return NextResponse.json({ error: 'Входът временно е недостъпен. Опитай отново.', code: configMissing ? 'SESSION_UNAVAILABLE' : 'AUTH_UNAVAILABLE' }, { status: 503 });
  }
}
