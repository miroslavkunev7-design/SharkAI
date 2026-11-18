import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { loadAdminPendingPayments } from '@/lib/admin-billing.server';
import { getSession } from '@/lib/auth';
import { BankPaymentError, confirmManualPayment } from '@/lib/bank-payments';

const headers = { 'Cache-Control': 'private, no-store' };
const approval = z.object({
  subscriptionId: z.string().trim().min(1).max(128),
  reference: z.string().trim().min(1).max(160),
  amount: z.number().finite().positive().max(100_000),
  verified: z.literal(true),
});

export async function GET() {
  if ((await getSession())?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Само за администратор.' }, { status: 403, headers });
  }
  try {
    const result = await loadAdminPendingPayments();
    if (result.availability !== 'available') return NextResponse.json({ error: result.reason }, { status: 503, headers });
    return NextResponse.json({ pending: result.items, total: result.total }, { headers });
  } catch {
    return NextResponse.json({ error: 'Чакащите плащания временно не могат да се заредят.' }, { status: 503, headers });
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (session?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Само за администратор.' }, { status: 403, headers });
  }
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    return NextResponse.json({ error: 'Изпратете потвърждението като JSON.' }, { status: 415, headers });
  }

  const input = approval.safeParse(await req.json().catch(() => null));
  if (!input.success) {
    return NextResponse.json({ error: 'Въведете референцията и действително постъпилата сума и потвърдете, че са сверени.' }, { status: 400, headers });
  }
  const { subscriptionId, amount, reference } = input.data;
  try {
    const subscription = await confirmManualPayment(session.id, subscriptionId, reference, amount);
    return NextResponse.json({ ok: true, subscription }, { headers });
  } catch (error) {
    if (error instanceof BankPaymentError) return NextResponse.json({ error: error.message }, { status: error.status, headers });
    return NextResponse.json({ error: 'Потвърждението временно не може да се запише.' }, { status: 503, headers });
  }
}
