'use client';

import {useEffect, useState} from 'react';
import type {WalletInvestmentsOwnerDashboard} from '@/lib/wallet-investments-server';
import {displayMinor} from '@/lib/wallet-investments-contract';
import {isWalletOwnerDashboard} from '../dashboard/wallet-dashboard-shape';

export type Account = {state: 'loading' | 'guest' | 'unavailable'; data: null} |
  {state: 'ready'; data: WalletInvestmentsOwnerDashboard};
type Movement = {direction:'credit'|'debit'; amount_minor:string; occurred_at:string; category:string};
export type Statement = {currency:string; from:string; to:string; as_of:string; has_more:boolean; transactions:Movement[]};

export function dateLabel(value: string | null, withTime = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Непотвърдено';
  return new Intl.DateTimeFormat('bg-BG', {
    dateStyle: 'medium', timeZone: 'Europe/Sofia', ...(withTime && {timeStyle:'short'}),
  }).format(new Date(value));
}

export function accountLabel(account: Account) {
  if (account.state === 'guest') return 'Влез, за да видиш сметката си';
  if (account.state === 'loading') return 'Зареждане на сметката…';
  if (account.state === 'unavailable') return 'Временно недостъпно';
  const status = account.data?.wallet.status;
  const capabilities=account.data?.wallet_capabilities;
  if(capabilities?.currencies?.length && !capabilities.selected_currency) return 'Избери валута на сметката';
  if (status === 'verified') return 'Данни от Wise';
  if (status === 'stale') return 'Необходима е нова проверка';
  if (status === 'provider_unconfigured') return 'Връзката с Wise не е настроена';
  return status === 'unavailable' ? 'Временно недостъпно' : 'Не е свързано';
}

export function accountBalance(account: Account) {
  const wallet = account.data?.wallet;
  return wallet?.status === 'verified' && wallet.currency && wallet.balance_minor !== null
    ? displayMinor(wallet.balance_minor, wallet.currency).replace(' '+wallet.currency, '') : '—';
}

function validMovement(value: unknown): value is Movement {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (row.direction === 'debit' || row.direction === 'credit') && typeof row.category === 'string' &&
    typeof row.amount_minor === 'string' && /^\d{1,30}$/.test(row.amount_minor) &&
    typeof row.occurred_at === 'string' && Number.isFinite(Date.parse(row.occurred_at));
}

export function useWalletData() {
  const [account, setAccount] = useState<Account>({state:'loading', data:null});
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{owner: Account; statement: Statement | null} | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const clear = () => { setAccount({state:'loading', data:null}); setLoaded(null); };
    // A restored document can belong to a previous sign-in on a shared device.
    const restore = (event: PageTransitionEvent) => { if (event.persisted) { clear(); setRevision(n => n+1); } };
    const reload = () => { clear(); setRevision(n => n+1); };
    window.addEventListener('pageshow', restore);
    window.addEventListener('pagehide', clear);
    window.addEventListener('sharkai:wise-return',reload);
    fetch('/api/wallet-investments', {cache:'no-store', signal:AbortSignal.any([controller.signal, AbortSignal.timeout(20000)])})
      .then(async response => {
        if (response.status === 401) return {state:'guest', data:null} as const;
        const data:unknown = await response.json();
        if (!response.ok || !isWalletOwnerDashboard(data)) throw Error();
        return {state:'ready', data} as const;
      }).then(next => { if (!controller.signal.aborted) setAccount(next); })
      .catch(() => { if (!controller.signal.aborted) setAccount({state:'unavailable', data:null}); });
    return () => {
      controller.abort();
      window.removeEventListener('pageshow',restore);
      window.removeEventListener('pagehide',clear);
      window.removeEventListener('sharkai:wise-return',reload);
    };
  }, [revision]);
  useEffect(() => {
    if (!account.data?.wallet_capabilities.deposit_statements) return;
    const currency = account.data.wallet.currency ?? account.data.wallet_capabilities.selected_currency ?? account.data.settings.currency;
    const controller = new AbortController();
    fetch('/api/wallet-investments/provider/transactions', {
      method:'POST', cache:'no-store', signal:AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
    }).then(async response => {
      const result = await response.json();
      if (!response.ok || result.status !== 'available' || result.currency !== currency ||
        !Array.isArray(result.transactions) || !result.transactions.every(validMovement)) throw Error();
      if (!controller.signal.aborted) setLoaded({owner:account,statement:result});
    }).catch(() => { if (!controller.signal.aborted) setLoaded({owner:account,statement:null}); });
    return () => controller.abort();
  }, [account]);
  const statement = loaded?.owner === account ? loaded.statement : undefined;
  const historyStatus = account.state === 'guest' ? 'Влез, за да видиш движенията по своята сметка.' :
    account.state === 'unavailable' ? 'Извлечението е временно недостъпно.' :
    account.state === 'loading' ? 'Зареждане…' : !account.data?.wallet_capabilities.deposit_statements ?
    'Няма потвърден достъп до извлечението от Wise.' : statement === undefined ? 'Зареждане на извлечението…' :
    statement === null ? 'Wise временно не предоставя извлечението.' : 'Няма осчетоводени движения за периода.';
  return {account,setAccount,statement,historyStatus,refresh:() => {
    setAccount({state:'loading',data:null}); setLoaded(null); setRevision(n=>n+1);
  }};
}
export type WalletData = ReturnType<typeof useWalletData>;
