import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';

export async function POST(req: NextRequest) {
  const session = await getSession();
  const { plan, provider } = await req.json();

  if (!session) {
    return NextResponse.json({ error: 'Please sign in first' }, { status: 401 });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;

  if (stripeKey && stripeKey.length > 10) {
    try {
      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(stripeKey);

      const priceId = plan === 'ULTRA'
        ? process.env.STRIPE_ULTRA_PRICE_ID
        : process.env.STRIPE_PRO_PRICE_ID;

      if (priceId) {
        const checkoutSession = await stripe.checkout.sessions.create({
          mode: 'subscription',
          payment_method_types: ['card'],
          line_items: [{ price: priceId, quantity: 1 }],
          success_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?success=true`,
          cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/pricing?cancelled=true`,
          customer_email: session.email,
          metadata: { userId: session.id, plan },
        });

        return NextResponse.json({ url: checkoutSession.url });
      }
    } catch (err) {
      console.error('Stripe error:', err);
    }
  }

  await prisma.user.update({
    where: { id: session.id },
    data: {
      plan: plan as 'PRO' | 'ULTRA',
      tokensLimit: plan === 'ULTRA' ? 999999999 : 100000,
    },
  });

  await prisma.subscription.upsert({
    where: { id: `${session.id}-${plan}` },
    create: {
      id: `${session.id}-${plan}`,
      userId: session.id,
      plan: plan as 'PRO' | 'ULTRA',
      status: 'active',
    },
    update: { status: 'active', plan: plan as 'PRO' | 'ULTRA' },
  });

  return NextResponse.json({
    message: `${plan} plan activated! Payment via ${provider || 'stripe'} will be configured in production.`,
    success: true,
  });
}
