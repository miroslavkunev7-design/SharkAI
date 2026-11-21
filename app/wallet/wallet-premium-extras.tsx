'use client';

import Link from 'next/link';
import {useEffect, useMemo, useState} from 'react';
import {ArrowLeftRight, ArrowUpRight, Bitcoin, CircleHelp, Globe2, RefreshCw} from 'lucide-react';
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
    fetch(url,{method:'GET',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]),credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store'}).then(async response=>{
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
      const age=Date.now()-Date.parse(data.date+'T00:00:00Z');
      if(!Number.isFinite(age)||age < -86400000||age>8*86400000)throw Error('Outdated rate');
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
  const current=reference?.base===base && reference.quote===quote ? reference : null;
  const result=current&&status==='ready'&&amount!==null?formatEstimate(amount*current.rate,quote):'—';
  const select=(value:string,kind:'base'|'quote')=>{
    if(!permitted(value))return;
    if(kind==='base')setBase(value);else setQuote(value);
  };
  const changePair=(from:CurrencyCode,to:CurrencyCode)=>{setBase(from);setQuote(to);};
  const currencyNames=new Intl.DisplayNames(['bg'],{type:'currency'});
  const options=codes.map(code=>{
    const name=code==='USDT'?'Tether':code==='BTC'?'Bitcoin':code==='ETH'?'Ethereum':currencyNames.of(code);
    return <option value={code} key={code}>{code}{name&&name!==code?' · '+name:''}</option>;
  });
  const body=<div className={compact?'desktop-converter-form':undefined}>
    <div className="screen"><div className="stack">
      <form className="stack" action="/wallet" method="GET">
        <div className="panel"><label className="field"><span>От валута</span>
          <select value={base} aria-label="От валута" onChange={e=>select(e.target.value,'base')}>{options}</select></label>
          <p className="micro">Сума за справка · <button type="button" className="wallet-rate-tool" onClick={()=>changePair(quote,base)} aria-label="Размени валутите"><ArrowLeftRight size={13}/></button></p>
          <label className="field"><span>Обменяш {base}</span>
            <input inputMode="decimal" aria-label="Сума за справка" placeholder="0,00" value={rawAmount} onChange={e=>setRawAmount(e.target.value)}/></label></div>
        <div className="panel"><label className="field"><span>Към валута</span>
          <select value={quote} aria-label="Към валута" onChange={e=>select(e.target.value,'quote')}>{options}</select></label>
          <p className="micro">Ориентировъчна стойност</p><strong className="amount" aria-live="polite">{result}</strong>
          <p className="micro" role="status">{current?(base===quote?'Една и съща валута.':
            '1 '+base+' ≈ '+new Intl.NumberFormat('bg-BG',{maximumFractionDigits:7}).format(current.rate)+' '+quote+' · '+current.source+' · '+current.date):
            status==='unavailable'?'Няма потвърден курс за тази двойка.':'Проверка на референтния курс…'}{' '}
            <button type="button" className="wallet-rate-tool" disabled={status==='loading'} aria-label="Обнови курса" onClick={()=>setReload(n=>n+1)}><RefreshCw size={13}/></button></p></div>
        <button type="submit" name="tab" value="exchange" className="button primary"><ArrowUpRight size={18}/>Преглед на обмяната в Wise</button>
      </form></div></div><p className="desktop-converter-note"><CircleHelp size={16}/>Референтен курс. За изпълнима оферта прегледай обмяната в Wise.</p></div>;
  if(!compact) return body;
  return <aside className="desktop-wallet-card desktop-converter" aria-label="Конвертор">
    <div className="desktop-card-art desktop-converter-art" aria-hidden="true"/><div className="desktop-converter-heading">
      <span className="desktop-action-disc"><ArrowLeftRight size={28}/></span><div><h2>Конвертор</h2><p>Обмяна между валути</p></div></div>
    <div className="desktop-converter-mode"><span><Globe2 size={17}/>Валути</span>
      <Link href="/wallet?tab=crypto"><Bitcoin size={17}/>Крипто активи <ArrowUpRight size={15}/></Link></div>{body}</aside>;
}
