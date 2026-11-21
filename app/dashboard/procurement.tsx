'use client';

import {useEffect,useState,type FormEvent} from 'react';
import {currencyMinorDigits,displayMinor,parseDecimalMinor} from '@/lib/wallet-investments-contract';

const endpoint='/api/commerce/procurement';
const labels={offered:'Има оферта',reviewed:'Прегледана оферта',submitting:'Изпраща се',issued:'Издадена поръчка',
  uncertain:'Предстои сверяване',received:'Получено в склада'};
type StockItem={offer_id:string;product_name:string;supplier_name:string;units:number;currency:string;max_cost_minor:string;
  state:keyof typeof labels;received_units:number;sold_units:number|null;stock_units:number|null;realized_margin_minor:string|null};
type StockQuote={review_id:string;currency:string;max_cost_minor:string;expires_at:string};
type Mandate={mandate_id:string;product_id:string;supplier_name:string;currency:string;max_per_po_minor:string;total_minor:string;expires_at:string};
type Stock={status:'available'|'unavailable';items:StockItem[];mandates:Mandate[]};
const dateSofia=(iso:string)=>new Intl.DateTimeFormat('bg-BG',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Sofia'}).format(new Date(iso));

function StockPermission({item,refresh}:{item:StockItem;refresh:()=>void}) {
  const [each,setEach]=useState(''),[total,setTotal]=useState(''),[until,setUntil]=useState('');
  const [accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const digits=currencyMinorDigits(item.currency)??2;
  async function submit(event:FormEvent) {
    event.preventDefault();if(busy||!accepted)return;
    const per=parseDecimalMinor(each,digits),all=parseDecimalMinor(total,digits),expiry=new Date(until);
    if(!per||!all||per.length>12||all.length>12||BigInt(all)<BigInt(per)||!Number.isFinite(expiry.getTime())||expiry.getTime()<=Date.now()) {
      setNotice('Въведи положителни лимити, общ лимит поне колкото този на поръчка и бъдещ час на изтичане.');return;
    }
    setBusy(true);setNotice('');
    try {
      const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        action:'enable_automation',offer_id:item.offer_id,max_per_po_minor:per,total_minor:all,expires_at:expiry.toISOString(),accepted:true,
      })});
      const result=await response.json();
      if(!response.ok||result.status!=='enabled')throw Error();
      setAccepted(false);setNotice('Разрешението за автоматични покупки е записано.');refresh();
    }catch{setNotice('Разрешението не е потвърдено. Провери свободния лимит и срока на договора.');}
    finally{setBusy(false);}
  }
  return <details className="commerce-candidate" data-scene="verification" data-scene-tone="light"><summary>Разрешение за автоматични покупки</summary>
    <form className="commerce-form" onSubmit={submit}>
      <p>{item.product_name} · {item.supplier_name} · договорен склад. Поръчките се издават без повторно потвърждение в рамките на посочените лимити.</p>
      <label>Максимум на покупка ({item.currency})<input required inputMode="decimal" value={each} onChange={e=>setEach(e.target.value)}/></label>
      <label>Общ лимит за разрешението ({item.currency})<input required inputMode="decimal" value={total} onChange={e=>setTotal(e.target.value)}/></label>
      <label>Валидно до (местно време)<input required type="datetime-local" value={until} onChange={e=>setUntil(e.target.value)}/></label>
      <label className="commerce-permission"><input required type="checkbox" checked={accepted} onChange={e=>setAccepted(e.target.checked)}/>
        Разрешавам реални автоматични покупки на този артикул от този доставчик до посочените лимити и срок.</label>
      <button className="shark-action-secondary" disabled={busy||!accepted}>Разреши автоматичните покупки</button>
      {notice && <p role="status">{notice}</p>}
    </form></details>;
}
function ActivePermission({mandate,refresh}:{mandate:Mandate;refresh:()=>void}) {
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  async function revoke() {
    if(busy)return;
    setBusy(true);setNotice('');
    try{
      const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        action:'disable_automation',mandate_id:mandate.mandate_id,
      })});const value=await response.json();
      if(!response.ok||value.status!=='revoked')throw Error();
      refresh();
    }catch{setNotice('Оттеглянето не е потвърдено. Обнови разрешенията.');}
    finally{setBusy(false);}
  }
  return <article className="commerce-candidate" data-scene="supplier" data-scene-tone="light"><h4>{mandate.product_id} · {mandate.supplier_name}</h4>
    <p>До {displayMinor(mandate.max_per_po_minor,mandate.currency)} на поръчка, общо до {displayMinor(mandate.total_minor,mandate.currency)}.
      {' '}Валидно до {dateSofia(mandate.expires_at)} (София).</p>
    <button className="shark-action-secondary" type="button" disabled={busy} onClick={()=>void revoke()}>Оттегли разрешението за покупки</button>
    {notice&&<p role="status">{notice}</p>}
  </article>;
}

function StockOffer({item,refresh}:{item:StockItem;refresh:()=>void}) {
  const [quote,setQuote]=useState<StockQuote|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  async function submit() {
    if(busy)return;
    setBusy(true);setNotice('');
    try {
      const res=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        offer_id:item.offer_id,action:quote?'confirm':'review',...(quote && {review_id:quote.review_id}),
      })});
      const data=await res.json();
      if(!res.ok)throw Error();
      if(data.status==='reviewed' && typeof data.review_id==='string' && data.currency===item.currency) {
        setQuote(data);
      }else {
        setQuote(null);
        setNotice(data.status==='issued'?'Поръчката е издадена в Zoho Inventory.':data.status==='uncertain'?
          'Доставчикът още не е потвърдил резултата. Предстои сверяване.':'Покупката е блокирана или временно недостъпна.');
        refresh();
      }
    }catch{setQuote(null);setNotice('Статусът на покупката е недостъпен. Обнови офертите преди повторен опит.');}
    finally{setBusy(false);}
  }
  const canReview=item.state==='offered'||item.state==='reviewed';
  return <details className="commerce-candidate" data-scene="shipping" data-scene-tone="light">
    <summary>{item.product_name} · {item.supplier_name} · {labels[item.state]}</summary>
    <dl className="module-wallet-metrics">
      <div><dt>Бройки за поръчка</dt><dd>{item.units}</dd></div>
      <div><dt>Максимален общ разход</dt><dd>{displayMinor(item.max_cost_minor,item.currency)}</dd></div>
      <div><dt>Получено в склада</dt><dd>{item.received_units}</dd></div>
      <div><dt>Продадени бройки</dt><dd>{item.sold_units??'Непотвърдено'}</dd></div>
      <div><dt>На склад</dt><dd>{item.stock_units??'Непотвърдено'}</dd></div>
      <div><dt>Реализиран марж от препродажбата</dt><dd>{displayMinor(item.realized_margin_minor,item.currency)}</dd></div>
    </dl>
    {canReview&&<div className="commerce-actions">
      {quote&&<p>Общо до {displayMinor(quote.max_cost_minor,item.currency)} за {item.units} бр. Потвърди до {new Intl.DateTimeFormat('bg-BG',
        {dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Sofia'}).format(new Date(quote.expires_at))} (София).</p>}
      <button type="button" className="shark-action-secondary" disabled={busy} onClick={()=>void submit()}>
        {quote?'Потвърди покупката за склад':'Прегледай офертата за склад'}</button>
      {quote&&<button type="button" className="shark-action-secondary" disabled={busy} onClick={()=>setQuote(null)}>Отказ</button>}
    </div>}
    {notice&&<p role="status">{notice}</p>}
    {canReview&&<StockPermission item={item} refresh={refresh}/>}
  </details>;
}

export function Procurement({currency,refreshCapital}:{currency:string;refreshCapital:()=>void}) {
  const [revision,setRevision]=useState(0);
  const [stock,setStock]=useState<Stock|null>(null);
  useEffect(()=>{
    const controller=new AbortController();
    void fetch(endpoint,{cache:'no-store',signal:controller.signal}).then(async res=>{
      const data=await res.json() as Stock;
      if(!res.ok||!Array.isArray(data.items))throw Error();
      if(!controller.signal.aborted)setStock(data);
    }).catch(()=>{if(!controller.signal.aborted)setStock({status:'unavailable',items:[],mandates:[]});});
    return ()=>controller.abort();
  },[revision]);
  const items=stock?.items.filter(item=>item.currency===currency)??[];
  const mandates=stock?.mandates?.filter(row=>row.currency===currency)??[];
  return <section className="ice-section module-panel module-wallet-panel" data-scene="inventory" data-scene-tone="light">
    <h2>Покупки за склад и препродажба</h2>
    <p>Офертите показват колко струва цялата доставка. При потвърждение се издава поръчка в Zoho Inventory в рамките на свободния бюджет на магазина.</p>
    {!stock?<p role="status">Зареждане на офертите…</p>:stock.status!=='available'?<p>Данните от доставчика за склада са временно недостъпни.</p>
      :items.length===0?<p>Няма потвърдени складови оферти в {currency}.</p>:items.map(item=><StockOffer item={item} key={item.offer_id}
        refresh={()=>{setRevision(n=>n+1);refreshCapital();}}/>)}
    {stock?.status==='available'&&<><h3>Действащи разрешения за покупки</h3>{mandates.length===0?<p>Няма действащо разрешение в {currency}.</p>:
      mandates.map(row=><ActivePermission key={row.mandate_id} mandate={row} refresh={()=>setRevision(n=>n+1)}/>)}</>}
    <button type="button" className="shark-action-secondary" onClick={()=>setRevision(n=>n+1)}>Обнови складовите оферти</button>
  </section>;
}
