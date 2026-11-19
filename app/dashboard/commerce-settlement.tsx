'use client';

import {useEffect,useState,type FormEvent} from 'react';
import {currencyMinorDigits,displayMinor,minorToInput,parseDecimalMinor} from '@/lib/wallet-investments-contract';

type ClosedWeek={start_date:string;end_date:string;profit_minor:string;target_minor:string|null;allocable_minor:string;reinvested_minor:string|null;
  owner_minor:string|null;status:'awaiting_allocation'|'allocated'|'no_profit'};
type Settlement={status:'available'|'unavailable';currency:string;period:{start_date:string;end_date:string;target_minor:string|null;verified_profit_minor:string|null;verified_days:number}|null;
  closed:ClosedWeek[];reinvested_total_minor:string;owner_reserved_minor:string;owner_paid_minor:string;owner_payout_url:string|null};
const api='/api/commerce/settlement';
const readMinor=(raw:string,digits:number)=>/^0(?:[.,]0+)?$/.test(raw.trim())?'0':parseDecimalMinor(raw,digits);
const day=(value:string)=>new Intl.DateTimeFormat('bg-BG',{dateStyle:'medium',timeZone:'UTC'}).format(new Date(value+'T00:00:00Z'));

function Allocate({week,currency,done}:{week:ClosedWeek;currency:string;done:()=>void}) {
  const [raw,setRaw]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const chosen=readMinor(raw,currencyMinorDigits(currency)??2);
  const remaining=chosen!==null && BigInt(chosen)<=BigInt(week.allocable_minor) ? (BigInt(week.allocable_minor)-BigInt(chosen)).toString() : null;
  async function allocate(event:FormEvent) {
    event.preventDefault();
    if(busy || remaining===null)return;
    setBusy(true);setError('');
    try {
      const res=await fetch(api,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'allocate',currency,period_start:week.start_date,reinvest_minor:chosen})});
      if(!res.ok)throw Error();
      done();
    }catch{setError('Разпределението не е потвърдено. Обнови справката преди повторен опит.');}
    finally{setBusy(false);}
  }
  return <form className="commerce-form" onSubmit={allocate}>
    <label>Сума за реинвестиране ({currency}) <input inputMode="decimal" value={raw} onChange={e=>setRaw(e.target.value)} required/></label>
    <p>За собственика ще бъдат заделени {remaining===null?'—':displayMinor(remaining,currency)}.</p>
    {raw && remaining===null && <p role="alert">Въведи сума от нула до {displayMinor(week.allocable_minor,currency)}.</p>}
    <button className="shark-action" disabled={busy||remaining===null}>Потвърди разпределението за седмицата</button>
    {error&&<p role="alert">{error}</p>}
  </form>;
}
function WeeklyTarget({value,currency,done}:{value:string|null;currency:string;done:()=>void}) {
  const digits=currencyMinorDigits(currency)??2;
  const [raw,setRaw]=useState(minorToInput(value,digits)),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function save(event:FormEvent) {
    event.preventDefault();
    if(busy)return;
    const money=readMinor(raw,digits);
    if(money===null||money.length>12){setError('Въведи валидна цел в избраната валута.');return;}
    setBusy(true);setError('');
    try {
      const res=await fetch(api,{method:'PUT',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'target',currency,target_minor:money})});
      if(!res.ok)throw Error();
      done();
    }catch{setError('Целта временно не може да се запази.');}
    finally{setBusy(false);}
  }
  return <form className="commerce-form" onSubmit={save}>
    <label>Цел за седмична нетна печалба ({currency}) <input value={raw} inputMode="decimal" onChange={e=>setRaw(e.target.value)} required/></label>
    <button className="shark-action-secondary" disabled={busy}>Запази седмичната цел</button>
    {error&&<p role="alert">{error}</p>}
  </form>;
}
export function CommerceSettlement({currency,onAllocated}:{currency:string;onAllocated:()=>void}) {
  const [revision,setRevision]=useState(0),[notice,setNotice]=useState('');
  const [result,setResult]=useState<{currency:string;data:Settlement|null}|null>(null);
  useEffect(()=>{
    const controller=new AbortController();
    void fetch(api+'?'+new URLSearchParams({currency}),{cache:'no-store',signal:controller.signal}).then(async res=>{
      if(!res.ok)throw Error();
      const data=await res.json() as Settlement;
      if(data.currency!==currency||!Array.isArray(data.closed))throw Error();
      if(!controller.signal.aborted)setResult({currency,data});
    }).catch(()=>{if(!controller.signal.aborted)setResult({currency,data:null});});
    return ()=>controller.abort();
  },[currency,revision]);
  const current=result?.currency===currency?result:null;
  const data=current?.data;
  return <section className="ice-section module-panel module-wallet-panel" data-ice-art="markets">
    <h2>Седмична цел и разпределение на печалбата</h2>
    {!current ? <p role="status">Зареждане на седмичния отчет…</p> : data?.status!=='available'
      ? <p>Няма потвърден седмичен отчет за този магазин и валута.</p> : <>
        <p>Седмицата завършва в неделя по UTC. След приспадане на предишните загуби избираш каква част от уредената печалба да върнеш в магазина. Дотогава тя остава извън бюджета за нови покупки.</p>
        <dl className="module-wallet-metrics">
          <div><dt>Текущ седмичен период (UTC)</dt><dd>{data.period?day(data.period.start_date)+' – '+day(data.period.end_date):'Няма започнат период'}</dd></div>
          <div><dt>Действаща цел</dt><dd>{displayMinor(data.period?.target_minor??null,currency)}</dd></div>
          <div><dt>Междинен търговски резултат</dt><dd>{displayMinor(data.period?.verified_profit_minor??null,currency)}</dd>
            <small>{data.period?.verified_days??0} от 7 дни с проверен отчет</small></div>
          <div><dt>Общо разпределено за реинвестиране</dt><dd>{displayMinor(data.reinvested_total_minor,currency)}</dd></div>
          <div><dt>Заделено за собственика, чака изплащане</dt><dd>{displayMinor(data.owner_reserved_minor,currency)}</dd></div>
          <div><dt>Потвърдено получено от собственика</dt><dd>{displayMinor(data.owner_paid_minor??null,currency)}</dd></div>
        </dl>
        <p>Окончателното разпределение използва седмичния нетен резултат след данъци и корекции.</p>
        {data.owner_payout_url==='https://wise.com/home/' && <a className="shark-action-secondary" href={data.owner_payout_url}
          target="_blank" rel="noopener noreferrer">Отвори Wise Business за изплащане</a>}
        <WeeklyTarget key={currency+'-'+data.period?.target_minor} value={data.period?.target_minor??null} currency={currency}
          done={()=>{setNotice('Седмичната цел е запазена.');setRevision(n=>n+1);}}/>
        <h3>Приключени седмици</h3>
        {data.closed.length===0 && <p>Още няма приключена седмица с проверен отчет.</p>}
        {data.closed.map(week=><div key={week.start_date} className="commerce-candidate">
          <h4>{day(week.start_date)} – {day(week.end_date)}</h4>
          <dl className="module-wallet-metrics"><div><dt>Уреден нетен резултат</dt><dd>{displayMinor(week.profit_minor,currency)}</dd></div>
            <div><dt>Цел за тази седмица</dt><dd>{week.target_minor===null?'Не е зададена':displayMinor(week.target_minor,currency)}</dd></div>
            <div><dt>Допустима печалба за разпределяне</dt><dd>{displayMinor(week.allocable_minor,currency)}</dd></div>
            {week.status==='allocated'&&<><div><dt>За реинвестиране</dt><dd>{displayMinor(week.reinvested_minor,currency)}</dd></div>
              <div><dt>За собственика</dt><dd>{displayMinor(week.owner_minor,currency)}</dd></div></>}</dl>
          {week.status==='awaiting_allocation' && <Allocate week={week} currency={currency} done={()=>{
            setNotice('Разпределението е записано.');setRevision(n=>n+1);onAllocated();
          }}/>}
        </div>)}
      </>}
    {notice&&<p role="status">{notice}</p>}
    <button type="button" className="shark-action-secondary" onClick={()=>setRevision(n=>n+1)}>Обнови седмичния отчет</button>
  </section>;
}
