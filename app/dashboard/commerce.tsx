'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { currencyMinorDigits,displayMinor,minorToInput,parseDecimalMinor } from '@/lib/wallet-investments-contract';
import { ResearchPanel } from './research';
import { CommerceSettlement } from './commerce-settlement';
import { Procurement } from './procurement';
import './commerce.css';

type Money=string|null;
type Daily={date:string;orders:number;units:number;revenue_minor:Money;refunds_minor:Money;goods_minor:Money;
  fulfillment_minor:Money;advertising_minor:Money;fees_minor:Money;other_costs_minor:Money};
type Order={order_ref:string;status:'paid'|'refunded'|'partially_refunded'|'cancelled'|'pending';total_minor:Money;
  refunded_minor:Money;ordered_at:string;source_observed_at:string|null;fulfillment:'none'|'reviewed'|'submitting'|'accepted'|'uncertain'};
type Capital={limit_minor:string;cash_minor:Money;held_minor:string;available_minor:string;observed_at:string|null;agent_read_allowed:boolean};
type Dashboard={status:'available'|'unavailable';currency:string;from:string;to:string;shop:{connected:boolean;supplier_connected:boolean};
  capital:Capital;orders:Order[];daily:Daily[];period_complete:boolean;source_observed_at:string|null};
const billable=['goods_minor','fulfillment_minor','advertising_minor','fees_minor','other_costs_minor'] as const;
const costNames=['Закупуване на стоки','Изпълнение и доставка','Реклама','Такси','Други разходи'];
const states={paid:'Платена',refunded:'Възстановена',partially_refunded:'Частично възстановена',cancelled:'Отменена',pending:'В изчакване'};
const shipping={none:'Няма заявка',reviewed:'За потвърждение',submitting:'Изпраща се',accepted:'Приета от доставчика',uncertain:'Изисква сверяване'};
const dayMs=86_400_000;
const utcDay=(date=new Date())=>date.toISOString().slice(0,10);
const before=(day:string,n:number)=>utcDay(new Date(Date.parse(day+'T00:00:00Z')-n*dayMs));
const seen=(value:string|null)=>value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('bg-BG',
  {dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Sofia'}).format(new Date(value)) : 'Непотвърдено';
const minor=(value:Money)=>typeof value==='string' && /^-?\d{1,30}$/.test(value) ? BigInt(value) : null;
function margin(row:Daily) {
  const revenue=minor(row.revenue_minor), refunds=minor(row.refunds_minor);
  const costs=billable.map(key=>minor(row[key]));
  if(revenue===null||refunds===null||costs.some(cost=>cost===null))return null;
  return costs.reduce<bigint>((total,cost)=>total-(cost??BigInt(0)),revenue-refunds);
}
const amount=(value:bigint|null,currency:string)=>displayMinor(value?.toString()??null,currency);
type ShopifyStatus={status:'connected'|'not_configured'|'unauthorized'|'identity_mismatch'|'unavailable';shop:string|null;
  orders_last_60_days:'none'|'present'|'unverified';checked_at:string};
const shopErrors={not_configured:'Липсва връзка за Shopify магазина на този профил.',unauthorized:'Shopify не потвърди нужните права за четене.',
  identity_mismatch:'Shopify върна различен магазин от одобрения за този профил.',unavailable:'Проверката на Shopify е временно недостъпна.'};
function ShopifyConnection() {
  const [busy,setBusy]=useState(false),[report,setReport]=useState<ShopifyStatus|null>(null);
  async function inspect() {
    if(busy)return;
    setBusy(true);setReport(null);
    try {
      const response=await fetch('/api/commerce/shopify-connection',{cache:'no-store'});
      const result=await response.json() as ShopifyStatus;
      if(!['connected','not_configured','unauthorized','identity_mismatch','unavailable'].includes(result.status))throw Error();
      if(result.status==='connected' && (!response.ok || !result.shop || !['none','present','unverified'].includes(result.orders_last_60_days)))throw Error();
      setReport(result);
    }catch{setReport({status:'unavailable',shop:null,orders_last_60_days:'unverified',checked_at:new Date().toISOString()});}
    finally{setBusy(false);}
  }
  return <div className="commerce-form">
    <button type="button" disabled={busy} className="shark-action-secondary" onClick={()=>void inspect()}>{busy?'Проверка в Shopify…':'Провери връзката с Shopify'}</button>
    {report&&<div role="status">
      {report.status==='connected'?<><strong>Потвърден Shopify магазин · {report.shop}</strong><p>{report.orders_last_60_days==='none'?
        'Shopify потвърди 0 видими поръчки за последните 60 дни.':report.orders_last_60_days==='present'?'Има видими поръчки през последните 60 дни.':
        'Броят на поръчките за последните 60 дни е непотвърден.'}</p></>:<p>{shopErrors[report.status]}</p>}
      <small>Проверено към {seen(report.checked_at)} (София).</small>
    </div>}
  </div>;
}
function chartSeries(from:string,to:string,rows:Daily[]) {
  const values=new Map(rows.map(row=>[row.date,row]));
  const count=Math.floor((Date.parse(to)-Date.parse(from))/dayMs)+1;
  return Array.from({length:Math.min(366,count)},(_,i)=>{
    const date=before(from,-i);return {date,day:values.get(date)};
  });
}
function CommerceChart({data}:{data:Dashboard}) {
  const [mode,setMode]=useState<'orders'|'margin'>('orders');
  const [chosen,setChosen]=useState<string|null>(null);
  const series=chartSeries(data.from,data.to,data.daily).map(({date,day})=>({
    date,day,value:!day ? null : mode==='margin'?margin(day):BigInt(day.orders),
  }));
  const selected=series.find(row=>row.date===chosen)??series.findLast(row=>row.day)??series.at(-1);
  const maximum=series.reduce((highest,{value})=>{
    const abs=value===null?BigInt(0):value<BigInt(0)?-value:value;return abs>highest?abs:highest;
  },BigInt(1));
  const dailyMargins=data.daily.map(margin);
  const realized=dailyMargins.length && dailyMargins.every(value=>value!==null)
    ? dailyMargins.reduce<bigint>((total,value)=>total+(value??BigInt(0)),BigInt(0)) : null;
  return <section className="ice-section module-panel module-wallet-panel" data-ice-art="markets">
    <h2>Поръчки и реализиран марж по дни</h2>
    <div className="commerce-actions"><button type="button" className="shark-action-secondary" aria-pressed={mode==='orders'} onClick={()=>setMode('orders')}>Поръчки</button>
      <button type="button" className="shark-action-secondary" aria-pressed={mode==='margin'} onClick={()=>setMode('margin')}>Реализиран марж</button></div>
    {data.daily.length===0 ? <p>Няма потвърдени дневни отчети за избрания период.</p> : <>
      <dl className="module-wallet-metrics">
        <div><dt>Отчетени платени поръчки</dt><dd>{data.daily.reduce((total,day)=>total+day.orders,0)}</dd></div>
        <div><dt>Марж за потвърдените дни</dt><dd>{amount(realized,data.currency)}</dd></div>
        <div><dt>Дни с потвърден отчет</dt><dd>{data.daily.length} от {series.length}</dd></div>
      </dl>
      <div className="commerce-plot" role="group" aria-label="Дневни стойности; избери ден за подробности">
        {series.map(row=>{
          const positive=row.value!==null&&row.value>=BigInt(0),absolute=row.value===null?BigInt(0):positive?row.value:-row.value;
          const height=Math.max(1,Number(absolute*BigInt(100)/maximum)/2);
          const label=row.value===null?'Няма отчет':mode==='margin'?amount(row.value,data.currency):row.value.toString()+' поръчки';
          return <button key={row.date} type="button" aria-label={row.date+' · '+label} aria-pressed={selected?.date===row.date}
            title={row.date+' · '+label} onClick={()=>setChosen(row.date)}>
            {row.value===null ? <span className="commerce-missing"/> : <span className={positive?'commerce-up':'commerce-down'} style={{height:height+'%'}}/>}
          </button>;
        })}
      </div>
      <div className="commerce-axis" aria-hidden="true"><span>{data.from}</span><span>{data.to}</span></div>
      <label className="commerce-day">Ден в графиката <select value={selected?.date??''} onChange={e=>setChosen(e.target.value)}>
        {series.map(row=><option key={row.date}>{row.date}</option>)}</select></label>
      {!selected?.day ? <p>За този ден липсва потвърден отчет.</p> : <dl className="module-wallet-metrics">
        <div><dt>Платени поръчки</dt><dd>{selected.day.orders}</dd></div><div><dt>Продадени бройки</dt><dd>{selected.day.units}</dd></div>
        <div><dt>Уреден оборот</dt><dd>{displayMinor(selected.day.revenue_minor,data.currency)}</dd></div>
        <div><dt>Възстановявания</dt><dd>{displayMinor(selected.day.refunds_minor,data.currency)}</dd></div>
        {billable.map((key,i)=><div key={key}><dt>{costNames[i]}</dt><dd>{displayMinor(selected.day![key],data.currency)}</dd></div>)}
        <div><dt>Реализиран марж след разходите</dt><dd>{amount(margin(selected.day),data.currency)}</dd></div>
      </dl>}
    </>}
  </section>;
}

function CapitalForm({capital,currency,refresh}:{capital:Capital;currency:string;refresh:()=>void}) {
  const digits=currencyMinorDigits(currency)??2;
  const [limit,setLimit]=useState(minorToInput(capital.limit_minor,digits));
  const [allow,setAllow]=useState(capital.agent_read_allowed);
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  async function save(event:FormEvent) {
    event.preventDefault();
    if(busy)return;
    const value=/^0(?:[.,]0+)?$/.test(limit.trim())?'0':parseDecimalMinor(limit,digits);
    if(value===null || value.length>12){setNotice('Въведи валидна сума за избраната валута.');return;}
    setBusy(true);setNotice('');
    try {
      const res=await fetch('/api/commerce/capital',{method:'PUT',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({currency,amount_minor:value,agent_read_allowed:allow})});
      if(!res.ok)throw Error();
      setNotice('Търговските настройки са запазени.');refresh();
    } catch {setNotice('Настройките временно не могат да бъдат запазени.');}
    finally {setBusy(false);}
  }
  return <section className="ice-section module-panel module-wallet-panel" data-ice-art="studio">
    <h2>Капитал за магазина</h2>
    <dl className="module-wallet-metrics">
      <div><dt>Потвърдена търговска наличност</dt><dd>{displayMinor(capital.cash_minor,currency)}</dd></div>
      <div><dt>Резервирано за поръчки</dt><dd>{displayMinor(capital.held_minor,currency)}</dd></div>
      <div><dt>Свободен оперативен бюджет</dt><dd>{displayMinor(capital.available_minor,currency)}</dd></div>
      <div><dt>Проверено към (София)</dt><dd>{seen(capital.observed_at)}</dd></div>
    </dl>
    <form className="commerce-form" onSubmit={save}>
      <label>Лимит за разходи на магазина ({currency}) <input value={limit} inputMode="decimal" required onChange={e=>setLimit(e.target.value)}/></label>
      <label className="commerce-permission"><input type="checkbox" checked={allow} onChange={e=>setAllow(e.target.checked)}/> Разрешавам на агента да чете данните за магазина</label>
      <button className="shark-action" disabled={busy}>Запази настройките на магазина</button>
    </form>
    {notice && <p role="status">{notice}</p>}
  </section>;
}

type Review={review_id:string;currency:string;max_cost_minor:string;expires_at:string};
function OrderAction({order,refresh}:{order:Order;refresh:()=>void}) {
  const [review,setReview]=useState<Review|null>(null);
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  async function act() {
    if(busy)return;
    setBusy(true);setNotice('');
    try {
      const res=await fetch('/api/commerce/fulfillment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        order_ref:order.order_ref,action:review?'confirm':'review',...(review && {review_id:review.review_id}),
      })});
      const value=await res.json();if(!res.ok)throw Error();
      if (value.status==='reviewed' && typeof value.review_id==='string')setReview(value);
      else {
        setReview(null);
        setNotice(value.status==='accepted'?'Доставчикът е приел поръчката.':value.status==='uncertain'?'Потвърждението от доставчика предстои да се свери.':'Заявката е блокирана или недостъпна.');
        refresh();
      }
    }catch{setReview(null);setNotice('Доставката е недостъпна. Обнови статуса на поръчката.');}
    finally{setBusy(false);}
  }
  if(order.status!=='paid'||!['none','reviewed'].includes(order.fulfillment))return null;
  return <div>{review&&<p>Максимален разход {displayMinor(review.max_cost_minor,review.currency)}. Потвърди до {seen(review.expires_at)} (София).</p>}
    <button type="button" className="shark-action-secondary" disabled={busy} onClick={()=>void act()}>
      {review?'Потвърди реалната поръчка към доставчика':'Прегледай доставката'}</button>
    {review && <button type="button" className="shark-action-secondary" disabled={busy} onClick={()=>setReview(null)}>Отказ</button>}
    {notice && <p role="status">{notice}</p>}</div>;
}

export function Commerce({signInHref}:{signInHref:string}) {
  const [today]=useState(()=>utcDay());
  const [from,setFrom]=useState(()=>before(today,6)),[to,setTo]=useState(today);
  const [currency,setCurrency]=useState('EUR'),[tick,setTick]=useState(0);
  const [result,setResult]=useState<{key:string;data:Dashboard|null;signedOut:boolean}|null>(null);
  const valid=from.length===10 && to.length===10 && from<=to && to<=today && (Date.parse(to)-Date.parse(from))/dayMs<366;
  const key=new URLSearchParams({from,to,currency}).toString();
  useEffect(()=>{
    if(!valid)return;
    const controller=new AbortController();let ongoing=false;
    async function load() {
      if(ongoing||document.hidden)return;ongoing=true;
      try{
        const res=await fetch('/api/commerce?'+key,{cache:'no-store',signal:controller.signal});
        if(res.status===401){if(!controller.signal.aborted)setResult({key,data:null,signedOut:true});return;}
        const data:Dashboard=await res.json();
        if(!res.ok||data.currency!==currency||!data.capital||!data.shop||!Array.isArray(data.orders)||!Array.isArray(data.daily))throw Error();
        if(!controller.signal.aborted)setResult({key,data,signedOut:false});
      }catch{if(!controller.signal.aborted)setResult({key,data:null,signedOut:false});}finally{ongoing=false;}
    }
    const refresh=()=>void load();refresh();const timer=window.setInterval(refresh,30_000);
    window.addEventListener('focus',refresh);
    return ()=>{controller.abort();window.clearInterval(timer);window.removeEventListener('focus',refresh);};
  },[key,tick,currency,valid]);
  const current=result?.key===key ? result:null;
  const data=current?.data;
  const refresh=()=>setTick(n=>n+1);
  return <>
    <section className="ice-section module-panel module-wallet-panel" data-ice-art="studio">
      <h2>Отчет за магазина</h2>
      <div className="commerce-actions">
        <label>От (UTC) <input type="date" value={from} max={to} onChange={e=>setFrom(e.target.value)}/></label>
        <label>До (UTC) <input type="date" value={to} min={from} max={today} onChange={e=>setTo(e.target.value)}/></label>
        <label>Валута на магазина <select value={currency} onChange={e=>setCurrency(e.target.value)}>
          {['EUR','USD','GBP','BGN'].map(c=><option key={c}>{c}</option>)}</select></label>
        <button type="button" className="shark-action-secondary" onClick={refresh}>Обнови отчета</button>
      </div>
      {!valid ? <p role="alert">Избери период до 366 дни с край най-късно днес.</p> : !current ? <p role="status">Зареждане на магазина…</p>
        : current.signedOut?<Link className="shark-action" href={signInHref}>Вход в профила</Link>
        : !data ? <p role="alert">Данните за магазина са временно недостъпни.</p>
        : <><p>Витрина за продажби в Shopify · {data.shop.connected?'Свързан магазин':'Няма потвърдена връзка'}</p>
          <p>Изработка по клиентска поръчка чрез Printful · {data.shop.supplier_connected?'Свързан доставчик':'Няма потвърдена връзка'}</p>
          <p>{data.period_complete?'Всички дни в периода са потвърдени.':'Налични са само потвърдените дни от периода.'} Последен счетоводен отчет · {seen(data.source_observed_at)} (София).</p>
          {(!data.shop.connected || !data.shop.supplier_connected) && <div className="commerce-actions">
            {!data.shop.connected && <a className="shark-action-secondary" href="https://help.shopify.com/en/manual/intro-to-shopify/initial-setup/setup-business-settings/" target="_blank" rel="noopener noreferrer">Настрой магазин в Shopify</a>}
            {!data.shop.supplier_connected && <a className="shark-action-secondary" href="https://help.printful.com/hc/en-us/articles/50262260641297-How-do-I-connect-my-Shopify-store-to-Printful" target="_blank" rel="noopener noreferrer">Свържи Printful с Shopify</a>}
          </div>}<ShopifyConnection/></>}
    </section>
    {valid && data && <>
      <CapitalForm key={currency} capital={data.capital} currency={currency} refresh={refresh}/>
      <CommerceSettlement key={currency} currency={currency} onAllocated={refresh}/>
      <CommerceChart key={key} data={data}/>
      <Procurement key={'stock-'+currency} currency={currency} refreshCapital={refresh}/>
      <section className="ice-section module-panel module-wallet-panel" data-ice-art="studio">
        <h2>Поръчки на клиенти</h2>
        {data.orders.length===0?<p>{data.shop.connected?'Няма потвърдени поръчки за периода.':'Поръчките ще се покажат след свързване на магазин.'}</p>
          : data.orders.map(order=><details className="commerce-candidate" key={order.order_ref}>
            <summary>{order.order_ref} · {states[order.status]} · {displayMinor(order.total_minor,currency)}</summary>
            <dl className="module-wallet-metrics">
              <div><dt>Поръчана на</dt><dd>{seen(order.ordered_at)}</dd></div>
              <div><dt>Възстановявания</dt><dd>{displayMinor(order.refunded_minor,currency)}</dd></div>
              <div><dt>Доставка</dt><dd>{shipping[order.fulfillment]}</dd></div>
              <div><dt>Данни от Shopify към</dt><dd>{seen(order.source_observed_at)}</dd></div>
            </dl>
            {data.shop.supplier_connected&&<OrderAction order={order} refresh={refresh}/>}
          </details>)}
      </section>
      <ResearchPanel domain="products" currency={currency}/>
    </>}
  </>;
}
