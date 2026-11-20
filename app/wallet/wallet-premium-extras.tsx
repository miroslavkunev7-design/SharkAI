'use client';

import Link from 'next/link';
import {useEffect, useMemo, useState} from 'react';
import {ArrowLeftRight, ArrowRight, CreditCard, RefreshCw, ShieldCheck} from 'lucide-react';
import {krakenPairRequest,verifiedKrakenReference} from './crypto-reference';

const codes = ['EUR','GBP','USD','CHF','BGN','BTC','ETH','USDT'] as const;
type CurrencyCode = typeof codes[number];
type Rate = {base: CurrencyCode; quote: CurrencyCode; date: string; rate: number; source:'identity'|'Frankfurter'|'Kraken Spot'};

function permitted(code:string):code is CurrencyCode {
  return (codes as readonly string[]).includes(code);
}
function formatEstimate(value:number,code:CurrencyCode){
  if(!Number.isFinite(value))return '—';
  const max=Math.abs(value)<1?6:2;
  return new Intl.NumberFormat('bg-BG',{maximumFractionDigits:max,minimumFractionDigits:2}).format(value)+' '+code;
}

/** Informational, read-only reference values. Never submit money or use Wise credentials. */
export function WalletReferenceConverter({compact=false,initialPair='fiat'}:{compact?:boolean;initialPair?:'fiat'|'crypto'}){
  const [base,setBase]=useState<CurrencyCode>(initialPair==='crypto'?'BTC':'EUR');
  const [quote,setQuote]=useState<CurrencyCode>(initialPair==='crypto'?'EUR':'GBP');
  const [rawAmount,setRawAmount]=useState('');
  const [status,setStatus]=useState<'loading'|'ready'|'unavailable'>('loading');
  const [reference,setReference]=useState<Rate|null>(null);
  const [reload,setReload]=useState(0);
  useEffect(()=>{
    if(base===quote){setReference({base,quote,date:'',rate:1,source:'identity'});setStatus('ready');return;}
    const controller=new AbortController();
    setStatus('loading');setReference(null);
    const kraken=krakenPairRequest(base,quote);
    // Public market data only: never transmit a Wise identifier, balance, amount or account key.
    const url=kraken?'/api/markets/crypto?q='+encodeURIComponent(kraken.pair)+'&page=1':
      'https://api.frankfurter.dev/v2/rate/'+base.toLowerCase()+'/'+quote.toLowerCase();
    fetch(url,{method:'GET',signal:controller.signal,cache:'no-store'}).then(async response=>{
      if(!response.ok)throw Error('Rate unavailable');
      const row:unknown=await response.json();
      if(kraken){
        const spot=verifiedKrakenReference(base,quote,row);
        if(!spot)throw Error('Unverified Kraken quote');
        return {...spot,base,quote};
      }
      if(!row||typeof row!=='object')throw Error('Invalid rate');
      const data=row as Record<string,unknown>;
      if(data.base!==base||data.quote!==quote||typeof data.rate!=='number'||
        !Number.isFinite(data.rate)||data.rate<=0||typeof data.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(data.date))
        throw Error('Unverified fiat rate');
      return {base,quote,date:data.date,rate:data.rate,source:'Frankfurter' as const};
    }).then(verified=>{
      if(!controller.signal.aborted){setReference(verified);setStatus('ready');}
    }).catch(()=>{if(!controller.signal.aborted){setStatus('unavailable');setReference(null);}});
    return ()=>controller.abort();
  },[base,quote,reload]);
  const amount=useMemo(()=>{
    const value=rawAmount.trim().replace(/\s/g,'').replace(',','.');
    if(!/^\d{1,10}(?:\.\d{0,6})?$/.test(value))return null;
    const n=Number(value);
    return Number.isFinite(n)&&n>=0&&n<=1_000_000_000?n:null;
  },[rawAmount]);
  const result=reference&&status==='ready'&&amount!==null?formatEstimate(amount*reference.rate,quote):'—';
  const select=(value:string,kind:'base'|'quote')=>{
    if(!permitted(value))return;
    if(kind==='base')setBase(value);else setQuote(value);
  };
  const changePair=(from:CurrencyCode,to:CurrencyCode)=>{setBase(from);setQuote(to);};
  return <section className={'sw-exchange-card sw-panel '+(compact?'is-compact':'')} aria-label="Конвертор по референтни курсове">
    <div className="sw-exchange-heading"><span className="sw-exchange-badge"><ArrowLeftRight/></span>
      <div><h2>Конвертор</h2><p>Валути · референтни курсове</p></div>
    </div>
    <div className="sw-pair-shortcuts">
      <button className={base==='EUR'&&quote==='GBP'?'is-active':''} type="button" onClick={()=>changePair('EUR','GBP')}>EUR ↔ GBP</button>
      <button className={base==='BTC'&&quote==='EUR'?'is-active':''} type="button" onClick={()=>changePair('BTC','EUR')}>BTC ↔ EUR</button>
    </div>
    <div className="sw-exchange-form">
      <label className="sw-exchange-input">От
        <span className="sw-exchange-input-line"><input type="text" inputMode="decimal" aria-label="Сума за справка"
          placeholder="Въведи сума" value={rawAmount} onChange={event=>setRawAmount(event.target.value)} />
          <select aria-label="От валута" value={base} onChange={event=>select(event.target.value,'base')}>
            {codes.map(code=><option key={code} value={code}>{code}</option>)}
          </select>
        </span>
      </label>
      <button type="button" className="sw-exchange-swap" onClick={()=>changePair(quote,base)} aria-label="Размени валутите"><ArrowLeftRight/></button>
      <div className="sw-exchange-output" aria-live="polite">Към
        <span className="sw-exchange-input-line"><strong>{result}</strong>
          <select aria-label="Към валута" value={quote} onChange={event=>select(event.target.value,'quote')}>
            {codes.map(code=><option key={code} value={code}>{code}</option>)}
          </select>
        </span>
      </div>
    </div>
    <div className="sw-exchange-rate" role="status">
      {status==='loading'?'Проверка на референтен курс…':
      status==='unavailable'?'В момента няма потвърден курс за избраната двойка.':
      reference?(base===quote?'Една и съща валута.':
        '1 '+base+' ≈ '+new Intl.NumberFormat('bg-BG',{maximumFractionDigits:7}).format(reference.rate)+' '+quote+' · '+reference.source+' · '+reference.date):'—'}
    </div>
    <button type="button" className="sw-btn sw-exchange-action" onClick={()=>setReload(n=>n+1)} disabled={status==='loading'}>
      <RefreshCw/> Обнови курса
    </button>
    <p className="sw-exchange-disclaimer">Информационни курсове от {reference?.source==='Kraken Spot'?'Kraken Spot':'Frankfurter'}.
      Това не е курс на Wise, оферта, препоръка за търговия или извършен превод.</p>
    {!compact&&<Link className="sw-exchange-more" href="/wallet?tab=settings">Настройки на платежната сметка <ArrowRight/></Link>}
  </section>;
}

export function WalletCardsReadOnly(){
  return <section className="sw-panel sw-cards-info" aria-label="Wise виртуални карти">
    <div className="sw-section-head"><h2>Виртуални карти</h2><CreditCard/></div>
    <p>За този акаунт все още няма предоставени и потвърдени картови метаданни от Wise. Не показваме измислен номер, наличност или статус на карта.</p>
    <div className="sw-cards-placeholder" role="status"><CreditCard/><span>Картовите данни са недостъпни</span></div>
    <a href="https://wise.com/home/" target="_blank" rel="noopener noreferrer" className="sw-btn"><ShieldCheck/> Преглед в Wise <ArrowRight/></a>
  </section>;
}
