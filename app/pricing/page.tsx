'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Logo } from '@/components/Logo';
import { Check, Zap, ArrowLeft, ArrowRight, CreditCard } from 'lucide-react';
import { PLANS } from '@/lib/agents';
import { accountPlanLabel, hasLifetimeUltra, type AccountPlan } from '../account-plan';
import '../entry.css';

type BillingPeriod = {
  plan: 'FREE' | 'PRO' | 'ULTRA';
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
};
type BillingStatus = AccountPlan & { period: BillingPeriod | null; canPurchase: boolean };

const periodDate = new Intl.DateTimeFormat('bg-BG', { dateStyle: 'medium', timeStyle: 'short' });
const planDetails = [
  { key: 'PRO', art: 'agent', icon: Check, features: ['Месечен лимит за AI чат', 'Разширен модел при наличен доставчик', 'Файлове, история и проекти', 'Преглед и експортиране от Студио'] },
  { key: 'ULTRA', art: 'team', icon: Zap, features: ['Без токенов лимит от SharkAI', 'Разширен модел при наличен доставчик', 'Инструменти в чата и Студио'] },
] as const;

export default function PricingPage() {
  const [loading, setLoading] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const [canPurchase, setCanPurchase] = useState(false);
  const [lifetime, setLifetime] = useState(false);
  const [checking, setChecking] = useState(true);
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
          if (response.status === 401) {
            setCanPurchase(true);
            if (expectedPlan) setError('Влезте в акаунта си, за да видите състоянието на плащането.');
          } else setError('Състоянието на плащането временно е недостъпно.');
          return;
        }
        const billing: BillingStatus = await response.json();
        if (cancel.signal.aborted) return;
        const { plan, period, canPurchase } = billing;
        const ownerAccess = hasLifetimeUltra(billing);
        setActive(plan);
        setLifetime(ownerAccess);
        setCanPurchase(canPurchase && !ownerAccess);
        if (ownerAccess) {
          setNotice(accountPlanLabel(billing));
        } else if (!canPurchase) {
          setNotice('Този акаунт има администраторски достъп.');
        } else if (period?.plan === plan && period.currentPeriodStart && period.currentPeriodEnd) {
          setNotice(`${plan} е активен от ${periodDate.format(new Date(period.currentPeriodStart))} до ${periodDate.format(new Date(period.currentPeriodEnd))}.`);
        } else if (expectedPlan) {
          setNotice('Очакваме потвърждение на плащането от Stripe.');
        }
        if (canPurchase && !ownerAccess && expectedPlan && period?.plan !== expectedPlan && attempt < 9) {
          timer = window.setTimeout(() => void checkStatus(attempt + 1), 2_000);
        }
      } catch {
        if (!cancel.signal.aborted) setError('Състоянието на плащането временно е недостъпно.');
      } finally {
        if (!cancel.signal.aborted) setChecking(false);
      }
    }

    void checkStatus();
    return () => { cancel.abort(); window.clearTimeout(timer); };
  }, []);

  async function handleCheckout(plan: string) {
    if (!canPurchase || checking) return;
    setLoading(plan);
    setError('');
    try {
      const res = await fetch('/api/payments/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, provider: 'stripe' }),
      });
      const data = await res.json();
      if (res.status === 401) router.push('/login?next=/pricing');
      else if (res.ok && data.url) window.location.href = data.url;
      else setError(data.error || 'Плащането временно е недостъпно.');
    } catch {
      setError('Плащането временно е недостъпно.');
    } finally {
      setLoading(null);
    }
  }

  function checkoutLabel(plan: 'PRO' | 'ULTRA') {
    if (checking) return 'Проверяваме достъпа…';
    if (lifetime && plan === 'ULTRA') return 'Активен план';
    if (!canPurchase) return active ? 'Администраторски достъп' : 'Временно недостъпно';
    if (active === plan) return 'Активен план';
    if (active === 'ULTRA') return 'Включен в Ultra';
    if (loading === plan) return 'Отваряне на Stripe…';
    return `Абонамент за ${PLANS[plan].name}`;
  }

  return (
    <main className="shark-entry-page shark-entry-pricing">
      <header className="shark-entry-return">
        <Link href="/" className="shark-wordmark" aria-label="SharkAI, начало">
          <ArrowLeft size={17} aria-hidden="true" /><Logo size="sm" />
          <span aria-hidden="true">SharkAI</span>
        </Link>
      </header>
      <section className="ice-section shark-entry-price-intro" data-ice-art="agent" aria-labelledby="plans-title">
        <div className="shark-entry-price-lede">
          <h1 id="plans-title">Планове</h1>
          <p>{lifetime ? <><Check size={17} aria-hidden="true" /> Достъп без плащане</> : <><CreditCard size={17} aria-hidden="true" /> Месечни абонаменти през Stripe</>}</p>
          <Link className="shark-entry-inline-link" href="/chat">{lifetime ? 'Към чата' : 'Започни без абонамент'} <ArrowRight size={16} aria-hidden="true" /></Link>
        </div>
      </section>
      {(notice || error) && <div className="shark-entry-price-message ice-section" data-ice-art="agent">
        {notice && <p role="status">{notice}</p>}
        {error && <p role="alert" className="shark-entry-error">{error}</p>}
      </div>}
      <div className="shark-entry-price-grid">
        {planDetails.map(({ key, art, icon: Icon, features }) => (
          <article key={key} className="ice-section shark-entry-plan" data-ice-art={art}>
            <div className="shark-entry-plan-copy">
              <h2><Icon size={19} aria-hidden="true" /> {PLANS[key].name}</h2>
              <p className="shark-entry-plan-price">{lifetime && key === 'ULTRA' ? 'Без такса' : <>€{PLANS[key].price}<span> / месец</span></>}</p>
              <ul>
                {features.map((feature) => <li key={feature}><Check size={15} aria-hidden="true" />{feature}</li>)}
                {key === 'ULTRA' && <li><Check size={15} aria-hidden="true" />{lifetime ? 'Права без срок' : 'Права за целия платен период'}</li>}
              </ul>
              <button
                type="button"
                onClick={() => void handleCheckout(key)}
                disabled={checking || loading !== null || !canPurchase || active === key || active === 'ULTRA'}
                className="shark-action"
              >{checkoutLabel(key)}</button>
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}
