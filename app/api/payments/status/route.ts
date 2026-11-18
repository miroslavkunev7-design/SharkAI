import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { bankTransferDetails } from '@/lib/bank-payments';
import { getActiveBillingPeriod } from '@/lib/billing';
import { stripeBilling, stripePriceId } from '@/lib/stripe-billing';

function configuredStripePlans() {
  if (!stripeBilling() || !process.env.NEXT_PUBLIC_APP_URL) return [];
  try {
    const url = new URL(process.env.NEXT_PUBLIC_APP_URL);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) return [];
  } catch { return []; }
  const pro = stripePriceId('PRO');
  const ultra = stripePriceId('ULTRA');
  if (pro && pro === ultra) return [];
  return ['PRO', 'ULTRA'] as const;
}

export async function GET() {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: 'Влезте в акаунта си.' }, { status: 401 });

  const period = user.role === 'ADMIN' ? null : await getActiveBillingPeriod(user.id);
  const stripePlans = user.role === 'ADMIN' ? [] : configuredStripePlans();
  return NextResponse.json({ plan: user.plan, period, canPurchase: user.role !== 'ADMIN',
    bankAvailable: user.role !== 'ADMIN' && !!bankTransferDetails(), stripeAvailable: stripePlans.length > 0, stripePlans,
    ...(user.lifetime && { lifetime: true }),
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}
