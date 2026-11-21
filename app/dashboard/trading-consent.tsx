'use client';

import { useCallback, useEffect, useState } from 'react';
import type { OwnerMandateView, OwnerOfferTerms } from '@/lib/investments/trading-consent.server';
import { displayMinor } from '@/lib/wallet-investments-contract';

const route='/api/wallet-investments/trading-consent';
const date=(value:string)=>new Intl.DateTimeFormat('bg-BG',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Sofia'}).format(new Date(value));
function MandateTerms({ terms }: { terms: OwnerOfferTerms }) {
  const period={DAY:'Дневен',WEEK:'Седмичен',MONTH:'Месечен',CUSTOM_DAYS:`На всеки ${terms.days} дни`}[terms.period];
  const goal=terms.goal_minor ? displayMinor(terms.goal_minor,terms.currency)
    : terms.goal_bps ? (terms.goal_bps/100).toLocaleString('bg-BG')+' %' : 'Без зададена цел';
  return <dl className="module-wallet-metrics">
    <div><dt>Брокер</dt><dd>{terms.provider==='ibkr'?'Interactive Brokers':'Saxo'}</dd></div>
    <div><dt>Лимит върху отделената нетна печалба</dt><dd>{displayMinor(terms.capital_minor,terms.currency)}</dd></div>
    <div><dt>Инструменти</dt><dd>{terms.assets.join(', ')}</dd></div>
    <div><dt>Стратегия</dt><dd>{terms.strategy}</dd></div>
    <div><dt>Цел</dt><dd>{goal}</dd></div>
    <div><dt>Период</dt><dd>{period} от {terms.start_date} (UTC)</dd></div>
    <div><dt>Такса на Shark AI</dt><dd>{terms.performance_fee_bps/100}% от новата допустима печалба в края на избрания период</dd></div>
    <div><dt>Спиране при отчетена загуба</dt><dd>{displayMinor(terms.max_loss_minor,terms.currency)}</dd></div>
    <div><dt>Максимален брой позиции</dt><dd>{terms.max_positions}</dd></div>
    <div><dt>Съгласието изтича</dt><dd>{date(terms.expires_at)} (София)</dd></div>
  </dl>;
}

export function TradingConsent({readOnly=false}:{readOnly?:boolean}={}) {
  const [view,setView]=useState<OwnerMandateView|null>(null);
  const [selected,setSelected]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const refresh=useCallback(async(signal?:AbortSignal)=>{
    const res=await fetch(route,{cache:'no-store',signal});
    if (!res.ok) throw Error();
    const value=await res.json() as OwnerMandateView;
    if (signal?.aborted) return;
    setView(value); setSelected('');
  },[]);
  useEffect(()=>{
    const controller=new AbortController();
    refresh(controller.signal).catch(()=>{ if(!controller.signal.aborted) setError('Статусът на разрешението е временно недостъпен.'); });
    return ()=>controller.abort();
  },[refresh]);
  async function accept(review:string) {
    if (readOnly || selected!==review || busy) return;
    setBusy(true); setError('');
    try {
      const res=await fetch(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accepted:true,review})});
      await refresh();
      if (!res.ok) setError('Условията са изтекли или променени. Прегледай текущите условия.');
    } catch {
      setError('Потвърждението е недостъпно. Провери статуса преди повторен опит.');
    } finally { setBusy(false); }
  }
  return <section className={readOnly?'panel':'ice-section module-panel module-wallet-panel'} data-scene={readOnly ? undefined : 'verification'} data-scene-tone={readOnly ? undefined : 'light'} aria-label="Разрешение за автоматизирана търговия">
    <h2>Разрешение за автоматизирана търговия</h2>
    {error && <p role="alert">{error}</p>}
    {!view && !error && <p role="status">Проверка на разрешението…</p>}
    {view?.active && <>
      <p>{view.active.valid?'Съгласието е активно.':'Автоматичните поръчки са спрени.'} Потвърдено на {date(view.active.accepted_at)} (София).</p>
      <MandateTerms terms={view.active.terms}/>
    </>}
    {readOnly && view && !view.active && <p>Няма активно разрешение.</p>}
    {!readOnly && view && !view.active && view.offers.length===0 && <p>Условия за разрешение ще се покажат при одобрени брокерски права и потвърдена свободна реализирана печалба в отделена сметка.</p>}
    {!readOnly && view?.offers.map(({terms,review})=><div key={terms.policy_id}>
      <MandateTerms terms={terms}/>
      <p>Разрешаваш многократни покупки и продажби с отделената нетна печалба. Личният депозит остава извън сметката за търговия. Отчетена загуба може да спре нови покупки. Цената на отворените позиции продължава да се променя.</p>
      <p>В края на всеки избран период Shark AI начислява 10% само върху новата реализирана и уредена нетна печалба над последния таксуван максимум. Печалбите първо покриват натрупаните загуби. Сумите, върху които вече е начислена такса, се изключват. Таблото показва отделно начисляването и потвърденото от брокера постъпление.</p>
      <label><input type="checkbox" checked={selected===review} disabled={busy}
        onChange={e=>setSelected(e.target.checked?review:'')}/> Потвърждавам лимита, инструментите, срока и таксата от 10% върху новата допустима печалба за избрания период.</label>
      <button className="shark-action" type="button" disabled={busy || selected!==review} onClick={()=>void accept(review)}>Разреши реални автоматични поръчки</button>
    </div>)}
  </section>;
}
