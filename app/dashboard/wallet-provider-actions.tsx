'use client';

import { useEffect, useRef, useState } from 'react';
import { displayMinor } from '@/lib/wallet-investments-contract';
import type { WalletDepositSummary } from '@/lib/investments/wallet-operations.server';
import type { WalletInvestmentsOwnerDashboard } from '@/lib/wallet-investments-server';

const reviews: Record<string,string> = {
  NEW: 'Предстои преглед от Wise', PASSED: 'Потвърден от Wise', PASSED_WITH_REQUIREMENTS: 'Потвърден с допълнителни изисквания',
  WAITING_CUSTOMER_INPUT: 'Wise очаква информация от теб', PROCESSING: 'Wise разглежда данните', EXPIRED: 'Срокът на проверката е изтекъл',
};
const api = '/api/wallet-investments/provider/';

export function WalletProviderActions({ data, action }: {
  data: WalletInvestmentsOwnerDashboard; action: 'funding' | 'withdrawal' | null;
}) {
  const actionSection = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!action) return;
    const section = actionSection.current;
    const target = section?.querySelector<HTMLElement>('[data-provider-action]') ?? section;
    target?.focus({ preventScroll: true });
    section?.scrollIntoView({ block: 'center' });
  }, [action]);
  const [deposits,setDeposits] = useState<WalletDepositSummary|null>(null);
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState('');
  const [review,setReview] = useState<string|null>(null);
  const capable = data.wallet_capabilities;
  useEffect(()=>{
    if (new URLSearchParams(window.location.search).get('wallet_review')==='unavailable') {
      setNotice('Wise временно не предоставя връзка за проверката. Опитай отново след обновяване на статуса.');
    }
    if (!capable.hosted_kyc) return;
    const controller = new AbortController();
    void fetch(api+'review',{method:'POST',cache:'no-store',signal:controller.signal})
      .then(async r=>r.ok && (await r.json()).status)
      .then(v=>{ if (!controller.signal.aborted) setReview(typeof v === 'string' && Object.hasOwn(reviews,v) ? v : 'UNKNOWN'); })
      .catch(()=>{ if (!controller.signal.aborted) setReview('UNKNOWN'); });
    return ()=>controller.abort();
  },[capable.hosted_kyc,data.settings.currency]);
  async function checkDeposits() {
    setBusy(true); setNotice(''); setDeposits(null);
    try {
      const response=await fetch(api+'deposits',{method:'POST',cache:'no-store'});
      const body=await response.json();
      if (!response.ok || body.deposits?.source!=='wise_balance_statement') throw new Error();
      setDeposits(body.deposits);
    } catch { setNotice('Извлечението е недостъпно. Провери в Wise дали се изисква потвърждение.'); }
    finally { setBusy(false); }
  }
  const actionLabel = action === 'funding' ? 'Зареждане' : 'Теглене';
  return <div ref={actionSection} tabIndex={-1} className="module-wallet-provider-actions" aria-label={action ? actionLabel : 'Действия в Wise'}>
    {action && <h3>{actionLabel} чрез Wise</h3>}
    {action && data.wallet.status !== 'verified' && <p role="status">
      За {action === 'funding' ? 'зареждане' : 'теглене'} е необходим потвърден портфейл в Wise.
    </p>}
    {capable.hosted_kyc && <p role="status">Проверка на самоличността · {review === null ? 'Зареждане…' : reviews[review] ?? 'Временно недостъпна'}</p>}
    {review === 'WAITING_CUSTOMER_INPUT' && <form method="POST" action={api+'onboarding'}>
      <button className="shark-action-secondary" type="submit">{data.wallet.status === 'verified' ? 'Продължи проверката в Wise' : 'Създай портфейл в Wise'}</button>
    </form>}
<<<<<<< HEAD
    {!capable.hosted_kyc && data.wallet.status !== 'verified' && <button className="shark-action-secondary" type="button" disabled>Създай портфейл</button>}
    {data.wallet.status === 'verified' && <a href="https://wise.com/home/" data-provider-action className="shark-action-secondary" target="_blank" rel="noopener noreferrer">
      {action ? actionLabel + ' в Wise' : 'Зареждане или теглене в Wise'}
    </a>}
=======
    {data.wallet.status === 'verified' && <a href="https://wise.com/home/" className="shark-action-secondary" target="_blank" rel="noopener noreferrer">Зареждане или теглене в Wise</a>}
>>>>>>> 7d7cfed (Publish standalone Shark wallet and source-backed period forecasts)
    {capable.deposit_statements && <button className="shark-action-secondary" type="button" onClick={()=>void checkDeposits()} disabled={busy}>
      {busy ? 'Проверка…' : 'Постъпления за последните 7 дни'}
    </button>}
    {deposits && <p role="status">
      Осчетоводени постъпления · {deposits.count}{deposits.latest && <> · Последно {displayMinor(deposits.latest.amount_minor,deposits.currency)} на {new Date(deposits.latest.occurred_at).toLocaleDateString('bg-BG',{timeZone:'Europe/Sofia'})}</>}
    </p>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
