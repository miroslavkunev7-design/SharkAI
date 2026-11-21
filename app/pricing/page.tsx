'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { PublicShell } from '@/components/PublicShell';
import { Check, Zap, ArrowRight, CreditCard } from 'lucide-react';
import { PLANS } from '@/lib/agents';
import { accountPlanLabel, hasLifetimeUltra, type AccountPlan } from '../account-plan';
import '../entry.css';

type BillingPeriod = {
  plan: 'FREE' | 'PRO' | 'ULTRA';
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
};
type Plan = 'PRO' | 'ULTRA';
type PaymentMethod = 'stripe' | 'bank';
type BillingStatus = AccountPlan & { period: BillingPeriod | null; canPurchase: boolean; bankAvailable?: boolean; stripeAvailable?: boolean; stripePlans?: Plan[] };
type Transfer = { plan: Plan; iban: string; bank: string; accountName: string | null; reference: string; amount: number };

const periodDate = new Intl.DateTimeFormat('bg-BG', { dateStyle: 'medium', timeStyle: 'short' });
const euro = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR' });
const planDetails = [
  { key: 'PRO', scene: 'pro', icon: Check, features: ['Месечен лимит за AI чат', 'Разширен модел при наличен доставчик', 'Файлове, история и проекти', 'Преглед и експортиране от Студио'] },
  { key: 'ULTRA', scene: 'ultra', icon: Zap, features: ['Без токенов лимит от SharkAI', 'Разширен модел при наличен доставчик', 'Инструменти в чата и Студио'] },
] as const;

export default function PricingPage() {
  const [loading, setLoading] = useState<{ plan: Plan; method: PaymentMethod } | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const [canPurchase, setCanPurchase] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [methods, setMethods] = useState<{ stripe: Plan[]; bank: boolean }>({ stripe: [], bank: false });
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [lifetime, setLifetime] = useState(false);
  const [checking, setChecking] = useState(true);
  const router = useRouter();
  const checkoutLock = useRef(false);
  const transferSection = useRef<HTMLElement>(null);

  useEffect(() => {
    if (transfer) transferSection.current?.focus();
  }, [transfer]);

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
            setSignedOut(true);
            setCanPurchase(false);
            if (expectedPlan) setError('Влезте в акаунта си, за да видите състоянието на плащането.');
          } else setError('Състоянието на плащането временно е недостъпно.');
          return;
        }
        const billing: BillingStatus = await response.json();
        if (cancel.signal.aborted) return;
        const { plan, period, canPurchase } = billing;
        const ownerAccess = hasLifetimeUltra(billing);
        setActive(plan);
        setSignedOut(false);
        setLifetime(ownerAccess);
        setCanPurchase(canPurchase && !ownerAccess);
        setMethods({ bank: billing.bankAvailable === true, stripe: billing.stripeAvailable === true ? billing.stripePlans ?? [] : [] });
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

  async function handleCheckout(plan: Plan, method: PaymentMethod) {
    const available = method === 'bank' ? methods.bank : methods.stripe.includes(plan);
    if (!canPurchase || checking || !available || active === plan || active === 'ULTRA' || checkoutLock.current) return;
    checkoutLock.current = true;
    setLoading({ plan, method });
    setError('');
    try {
      const res = await fetch('/api/payments/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, method, ...(method === 'stripe' && { provider: 'stripe' }) }),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 401) router.push('/login?next=/pricing');
      else if (!res.ok) setError(data?.error || 'Плащането временно е недостъпно.');
      else if (method === 'stripe' && typeof data?.url === 'string') window.location.assign(data.url);
      else if (method === 'bank' && data?.method === 'bank' && data.currency === 'EUR'
        && typeof data.iban === 'string' && !!data.iban && typeof data.bank === 'string' && !!data.bank
        && typeof data.reference === 'string' && !!data.reference && typeof data.amount === 'number' && Number.isFinite(data.amount) && data.amount > 0) {
        setTransfer({ plan, iban: data.iban, bank: data.bank, accountName: typeof data.accountName === 'string' ? data.accountName : null, reference: data.reference, amount: data.amount });
      } else setError('Данните за плащането не бяха потвърдени.');
    } catch {
      setError('Плащането временно е недостъпно.');
    } finally {
      checkoutLock.current = false;
      setLoading(null);
    }
  }

  function planState(plan: Plan) {
    if (checking) return 'Проверяваме достъпа…';
    if (lifetime && plan === 'ULTRA') return 'Активен план';
    if (!canPurchase) return active ? 'Администраторски достъп' : 'Временно недостъпно';
    if (active === plan) return 'Активен план';
    if (active === 'ULTRA') return 'Включен в Ultra';
    return 'Няма наличен метод за плащане.';
  }

  return (
    <PublicShell mainClassName="shark-entry-page shark-entry-pricing">
      <section className="ice-section shark-entry-price-intro" data-scene="plans" data-scene-tone="light" aria-labelledby="plans-title">
        <div className="shark-entry-price-lede">
          <h1 id="plans-title">Планове</h1>
          <p>{lifetime ? <><Check size={17} aria-hidden="true" /> Достъп без плащане</> : <><CreditCard size={17} aria-hidden="true" /> Месечни абонаменти</>}</p>
          <Link className="shark-entry-inline-link" href="/chat">{lifetime ? 'Към чата' : 'Започни без абонамент'} <ArrowRight size={16} aria-hidden="true" /></Link>
        </div>
      </section>
      {(notice || error) && <div className="shark-entry-price-message ice-section" data-scene="billing" data-scene-tone="light">
        {notice && <p role="status">{notice}</p>}
        {error && <p role="alert" className="shark-entry-error">{error}</p>}
      </div>}
      {transfer && <section ref={transferSection} tabIndex={-1} className="ice-section p-4 sm:p-6" data-scene="transfer" data-scene-tone="light" aria-labelledby="bank-transfer-title">
        <h2 id="bank-transfer-title" className="font-bold">Банков превод за {transfer.plan}</h2>
        <dl className="mt-2 grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          {transfer.accountName && <><dt>Получател</dt><dd className="break-words font-semibold">{transfer.accountName}</dd></>}
          <dt>Банка</dt><dd className="break-words font-semibold">{transfer.bank}</dd>
          <dt>IBAN</dt><dd className="break-all font-semibold">{transfer.iban}</dd>
          <dt>Сума</dt><dd className="font-semibold">{euro.format(transfer.amount)}</dd>
          <dt>Основание</dt><dd className="break-all font-semibold">{transfer.reference}</dd>
        </dl>
        <p className="mt-3 text-sm">Използвай точно посоченото основание. Достъпът започва след потвърждение на получения превод.</p>
      </section>}
      <section className="shark-entry-price-grid" aria-label="Сравнение на плановете">
        {planDetails.map(({ key, scene, icon: Icon, features }) => (
          <article key={key} className="ice-section shark-entry-plan" data-scene={scene} data-scene-tone="light">
            <div className="shark-entry-plan-copy">
              <h2><Icon size={19} aria-hidden="true" /> {PLANS[key].name}</h2>
              <p className="shark-entry-plan-price">{lifetime && key === 'ULTRA' ? 'Без такса' : <>€{PLANS[key].price}<span> / месец</span></>}</p>
              <ul>
                {features.map((feature) => <li key={feature}><Check size={15} aria-hidden="true" />{feature}</li>)}
                {key === 'ULTRA' && <li><Check size={15} aria-hidden="true" />{lifetime ? 'Права без срок' : 'Права за целия платен период'}</li>}
              </ul>
              {signedOut ? <Link className="shark-action" href="/login?next=/pricing">Влез за абонамент</Link> :
                !checking && canPurchase && active !== key && active !== 'ULTRA' && (methods.stripe.includes(key) || methods.bank) ? (
                  <div className="grid justify-items-start gap-2">
                    {methods.stripe.includes(key) && <button type="button" className="shark-action" disabled={!!loading} onClick={() => void handleCheckout(key, 'stripe')}>
                      {loading?.plan === key && loading?.method === 'stripe' ? 'Отваряне на Stripe…' : 'Плащане през Stripe'}
                    </button>}
                    {methods.bank && <button type="button" className="shark-action" disabled={!!loading} onClick={() => void handleCheckout(key, 'bank')}>
                      {loading?.plan === key && loading?.method === 'bank' ? 'Подготвяне на заявката…' : 'Банков превод'}
                    </button>}
                  </div>
                ) : <p className="text-sm font-semibold">{planState(key)}</p>}
            </div>
          </article>
        ))}
      </section>
    </PublicShell>
  );
}
