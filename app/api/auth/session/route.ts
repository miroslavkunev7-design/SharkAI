import { decodeJwt } from 'jose';
import { cookies } from 'next/headers';
import { getSession } from '@/lib/auth';

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export async function GET() {
  try {
    const account = await getSession();
    if (!account) return Response.json({ owner: null }, { headers });
    // getSession has already verified this request's signed cookie and loaded its owner.
    const token = (await cookies()).get('sharkai_token')?.value;
    const exp = token && decodeJwt(token).exp;
    if (typeof exp !== 'number' || exp * 1000 <= Date.now()) return Response.json({ owner: null }, { headers });
    return Response.json({
      owner: account.id, role: account.role, plan: account.plan, remainingMs: exp * 1000 - Date.now(),
    }, { headers });
  } catch {
    return Response.json({ status: 'unavailable' }, { status: 503, headers });
  }
}
