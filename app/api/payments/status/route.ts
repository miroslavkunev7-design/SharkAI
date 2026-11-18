import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveBillingPeriod } from '@/lib/billing';

export async function GET() {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: 'Влезте в акаунта си.' }, { status: 401 });

  const period = user.role === 'ADMIN' ? null : await getActiveBillingPeriod(user.id);
  return NextResponse.json({ plan: user.plan, period, canPurchase: user.role !== 'ADMIN' });
}
