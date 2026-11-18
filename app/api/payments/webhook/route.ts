import type Stripe from 'stripe';
import { NextRequest, NextResponse } from 'next/server';
import { applyStripeEvent, stripeBilling } from '@/lib/stripe-billing';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const billing = stripeBilling();
  if (!billing) return NextResponse.json({ error: 'Billing is unavailable' }, { status: 503 });

  const signature = req.headers.get('stripe-signature');
  if (!signature) return NextResponse.json({ error: 'Missing signature' }, { status: 400 });

  const { stripe, webhookSecret } = billing;
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(await req.text(), signature, webhookSecret);
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  try {
    await applyStripeEvent(stripe, event);
    return NextResponse.json({ received: true });
  } catch {
    console.error('Stripe subscription event could not be applied', event.type);
    return NextResponse.json({ error: 'Subscription update failed' }, { status: 500 });
  }
}
