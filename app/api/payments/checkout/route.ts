import type Stripe from 'stripe';
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { BankPaymentError, startBankTransfer } from '@/lib/bank-payments';
import { planRank } from '@/lib/billing';
import { prisma } from '@/lib/db';
import { isMonthlyPrice, stripeBilling, stripePriceId } from '@/lib/stripe-billing';
import { PLANS } from '@/lib/agents';

export async function POST(req: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: 'Влезте в акаунта си.' }, { status: 401 });

  const body: unknown = await req.json().catch(() => null);
  const plan = body && typeof body === 'object' && 'plan' in body ? body.plan : null;
  const method = body && typeof body === 'object' && 'method' in body ? body.method : 'stripe';
  if (plan !== 'PRO' && plan !== 'ULTRA') {
    return NextResponse.json({ error: 'Изберете валиден месечен план.' }, { status: 400 });
  }
  if (user.role === 'ADMIN' || planRank[user.plan] >= planRank[plan]) {
    return NextResponse.json({ error: 'Този акаунт вече има необходимия достъп.' }, { status: 409 });
  }

  if (method === 'bank') {
    const headers = { 'Cache-Control': 'private, no-store' };
    if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      return NextResponse.json({ error: 'Изпратете заявката като JSON.' }, { status: 415, headers });
    }
    try {
      return NextResponse.json(await startBankTransfer(user.id, plan), { headers });
    } catch (error) {
      if (error instanceof BankPaymentError) return NextResponse.json({ error: error.message }, { status: error.status, headers });
      return NextResponse.json({ error: 'Банковата заявка временно не може да се запише.' }, { status: 503, headers });
    }
  }
  if (method !== 'stripe') return NextResponse.json({ error: 'Методът на плащане не е наличен.' }, { status: 400 });

  const billing = stripeBilling();
  const priceId = stripePriceId(plan);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!billing || !appUrl || (priceId && priceId === stripePriceId(plan === 'ULTRA' ? 'PRO' : 'ULTRA'))) {
    return NextResponse.json({ error: 'Плащането временно не е конфигурирано.' }, { status: 503 });
  }

  try {
    const successUrl = new URL(`/pricing?checkout=complete&plan=${plan}`, appUrl);
    if (successUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(successUrl.hostname)) {
      return NextResponse.json({ error: 'Липсва сигурен адрес за връщане от Stripe.' }, { status: 503 });
    }

    const { stripe } = billing;
    const configured = PLANS[plan];
    let item: Stripe.Checkout.SessionCreateParams.LineItem;
    if (priceId) {
      const price = await stripe.prices.retrieve(priceId);
      if (!price.active || !isMonthlyPrice(price) || price.recurring?.usage_type !== 'licensed'
        || price.unit_amount !== configured.price * 100 || price.currency !== configured.currency.toLowerCase()) {
        return NextResponse.json({ error: 'Цената за този месечен план е недостъпна.' }, { status: 503 });
      }
      item = { price: price.id, quantity: 1 };
    } else {
      item = { quantity: 1, price_data: {
        currency: configured.currency.toLowerCase(), unit_amount: configured.price * 100,
        product_data: { name: `SharkAI ${plan}` }, recurring: { interval: 'month', interval_count: 1 },
      } };
    }

    const account = await prisma.user.findUnique({ where: { id: user.id }, select: { stripeId: true, role: true } });
    if (!account || account.role === 'ADMIN') {
      return NextResponse.json({ error: 'Акаунтът няма нужда от плащане.' }, { status: 409 });
    }

    let customer = account.stripeId;
    if (!customer) {
      const created = await stripe.customers.create({ email: user.email, metadata: { sharkaiUserId: user.id } }, {
        idempotencyKey: `sharkai-customer:${user.id}`,
      });
      const updated = await prisma.user.updateMany({
        where: { id: user.id, role: 'USER', stripeId: null },
        data: { stripeId: created.id },
      });
      customer = updated.count === 1
        ? created.id
        : (await prisma.user.findUnique({ where: { id: user.id, role: 'USER' }, select: { stripeId: true } }))?.stripeId ?? null;
      if (!customer) return NextResponse.json({ error: 'Акаунтът няма нужда от плащане.' }, { status: 409 });
    }

    const subscriptions = stripe.subscriptions.list({ customer, status: 'all', limit: 100 });
    for await (const subscription of subscriptions) {
      if (subscription.status !== 'canceled' && subscription.status !== 'incomplete_expired') {
        return NextResponse.json({ error: 'Вече има Stripe абонамент за този акаунт.' }, { status: 409 });
      }
    }

    const open = await stripe.checkout.sessions.list({ customer, status: 'open', limit: 1 });
    const pending = open.data[0];
    if (pending?.metadata?.plan === plan && pending.url) return NextResponse.json({ url: pending.url });
    if (pending) return NextResponse.json({ error: 'За този акаунт вече има отворено плащане.' }, { status: 409 });

    const checkout = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      line_items: [item],
      success_url: successUrl.href,
      cancel_url: new URL('/pricing?cancelled=true', appUrl).href,
      metadata: { userId: user.id, plan },
      subscription_data: { metadata: { sharkaiUserId: user.id, sharkaiPlan: plan, sharkaiPriceContract: 'monthly-v1' } },
    }, { idempotencyKey: `sharkai-checkout:${user.id}:${Math.floor(Date.now() / (30 * 60 * 1000))}` });

    if (checkout.url) return NextResponse.json({ url: checkout.url });
  } catch {
    return NextResponse.json({ error: 'Stripe не отвори плащането. Опитайте отново.' }, { status: 502 });
  }

  return NextResponse.json({ error: 'Stripe не върна адрес за плащане.' }, { status: 502 });
}
