'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Logo } from '@/components/Logo';
import { Check, Crown, Zap, ArrowLeft, CreditCard } from 'lucide-react';
import { PLANS } from '@/lib/agents';

export default function PricingPage() {
  const [loading, setLoading] = useState<string | null>(null);

  async function handleCheckout(plan: string) {
    setLoading(plan);
    try {
      const res = await fetch('/api/payments/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, provider: 'stripe' }),
      });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
      else if (data.message) alert(data.message);
    } catch {
      alert('Payment system initializing. Please try again.');
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="min-h-screen bg-shark-black">
      <header className="glass border-b border-white/5">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center gap-4">
          <Link href="/" className="text-white/50 hover:text-white"><ArrowLeft className="w-5 h-5" /></Link>
          <Logo size="sm" />
          <span className="font-display font-bold gradient-text">Pricing</span>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-4 py-16">
        <div className="text-center mb-12">
          <h1 className="font-display text-4xl font-bold mb-4">
            Choose Your <span className="gradient-text">Plan</span>
          </h1>
          <p className="text-white/60 flex items-center justify-center gap-2 flex-wrap">
            <CreditCard className="w-4 h-4" />
            Stripe · PayPal · Apple Pay · Google Pay
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-8">
          {Object.entries(PLANS).map(([key, plan]) => (
            <div
              key={key}
              className={`rounded-3xl p-8 ${
                'popular' in plan && plan.popular ? 'glass-strong border-shark-cyan/30 shadow-glow' : 'glass'
              }`}
            >
              {'popular' in plan && plan.popular && (
                <div className="flex items-center gap-1 text-shark-purple text-sm font-semibold mb-4">
                  <Crown className="w-4 h-4" /> Most Popular
                </div>
              )}
              <div className="flex items-center gap-3 mb-4">
                {key === 'ULTRA' ? <Zap className="w-7 h-7 text-shark-purple" /> : <Check className="w-7 h-7 text-shark-cyan" />}
                <h2 className="font-display text-2xl font-bold">{plan.name}</h2>
              </div>
              <p className="text-4xl font-bold gradient-text mb-6">
                €{plan.price}<span className="text-lg text-white/50">/mo</span>
              </p>
              <ul className="space-y-3 mb-8">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-white/70">
                    <Check className="w-4 h-4 text-shark-cyan shrink-0 mt-0.5" />{f}
                  </li>
                ))}
              </ul>
              <button
                onClick={() => handleCheckout(key)}
                disabled={loading === key}
                className={key === 'ULTRA' ? 'btn-primary w-full' : 'btn-secondary w-full'}
              >
                {loading === key ? 'Processing...' : `Subscribe to ${plan.name}`}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
