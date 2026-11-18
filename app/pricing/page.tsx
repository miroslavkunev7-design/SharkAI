'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Logo } from '@/components/Logo';
import { Check, Zap, ArrowLeft, CreditCard } from 'lucide-react';
import { PLANS } from '@/lib/agents';

type BillingPeriod = {
  plan: 'FREE' | 'PRO' | 'ULTRA';
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
};

const periodDate = new Intl.DateTimeFormat('bg-BG', { dateStyle: 'medium', timeStyle: 'short' });

export default function PricingPage() {
  const [loading, setLoading] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const [canPurchase, setCanPurchase] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const cancel = new AbortController();
    const query = new URLSearchParams(window.location.search);
    const expectedPlan = query.get('checkout') === 'complete' ? query.get('plan') : null;
    if (query.has('cancelled')) setNotice('Плащането е прекратено.');
    let timer: number | undefined;

    async function checkStatus(attempt = 0) {
      try {
        const response = await fetch('/api/payments/status', { signal: cancel.signal });
        if (!response.ok) {
          if (expectedPlan) setError(response.status === 401
            ? 'Влезте в акаунта си, за да видите състоянието на плащането.'
            : 'Състоянието на плащането временно е недостъпно.');
          return;
        }
        const { plan, period, canPurchase }: { plan: string; period: BillingPeriod | null; canPurchase: boolean } = await response.json();
        setActive(plan);
        setCanPurchase(canPurchase);
        if (!canPurchase) {
          setNotice('Този акаунт има администраторски достъп.');
        } else if (period?.plan === plan && period.currentPeriodStart && period.currentPeriodEnd) {
          setNotice(`${plan} е активен от ${periodDate.format(new Date(period.currentPeriodStart))} до ${periodDate.format(new Date(period.currentPeriodEnd))}.`);
        } else if (expectedPlan) {
          setNotice('Очакваме потвърждение на плащането от Stripe.');
        }
        if (expectedPlan && period?.plan !== expectedPlan && attempt < 9 && !cancel.signal.aborted) {
          timer = window.setTimeout(() => void checkStatus(attempt + 1), 2_000);
        }
      } catch {
        if (expectedPlan && !cancel.signal.aborted) setError('Състоянието на плащането временно е недостъпно.');
      }
    }

    void checkStatus();
    return () => { cancel.abort(); window.clearTimeout(timer); };
  }, []);

  async function handleCheckout(plan: string) {
    setLoading(plan);
    setError('');
    try {
      const res = await fetch('/api/payments/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, provider: 'stripe' }),
      });
      const data = await res.json();
      if (res.status === 401) router.push('/login');
      else if (res.ok && data.url) window.location.href = data.url;
      else setError(data.error || 'Плащането временно е недостъпно.');
    } catch {
      setError('Плащането временно е недостъпно.');
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="min-h-screen bg-shark-black">
      <header className="glass border-b border-white/5">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center gap-4">
          <Link href="/" aria-label="Начало" className="text-white/50 hover:text-white"><ArrowLeft className="w-5 h-5" /></Link>
          <Logo size="sm" />
          <span className="font-display font-bold gradient-text">Планове</span>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-4 py-16">
        <div className="text-center mb-12">
          <h1 className="font-display text-4xl font-bold mb-4">
            Изберете <span className="gradient-text">план</span>
          </h1>
          <p className="text-white/60 flex items-center justify-center gap-2 flex-wrap">
            <CreditCard className="w-4 h-4" />
            Плащане през Stripe
          </p>
          {notice && <p className="mt-4 text-shark-cyan" role="status">{notice}</p>}
          {error && <p className="mt-4 text-red-300" role="alert">{error}</p>}
        </div>

        <div className="grid md:grid-cols-2 gap-8">
          {Object.entries(PLANS).map(([key, plan]) => (
            <div
              key={key}
              className={`rounded-3xl p-8 ${
                'popular' in plan && plan.popular ? 'glass-strong border-shark-cyan/30 shadow-glow' : 'glass'
              }`}
            >
              <div className="flex items-center gap-3 mb-4">
                {key === 'ULTRA' ? <Zap className="w-7 h-7 text-shark-purple" /> : <Check className="w-7 h-7 text-shark-cyan" />}
                <h2 className="font-display text-2xl font-bold">{plan.name}</h2>
              </div>
              <p className="text-4xl font-bold gradient-text mb-6">
                €{plan.price}<span className="text-lg text-white/50">/месец</span>
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
                disabled={loading !== null || !canPurchase || active === key || active === 'ULTRA'}
                className={key === 'ULTRA' ? 'btn-primary w-full' : 'btn-secondary w-full'}
              >
                {!canPurchase ? 'Администраторски достъп' : active === key ? 'Активен план' : active === 'ULTRA' ? 'Включен в Ultra' : loading === key ? 'Отваряне на Stripe…' : `Абонамент за ${plan.name}`}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
