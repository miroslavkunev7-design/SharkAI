'use client';

import { useEffect, useState } from 'react';
import { displayMinor } from '@/lib/wallet-investments-contract';

type Preset = 'day'|'week'|'month'|'custom';
type Plan = 'FREE'|'PRO'|'ULTRA';
type CurrencyRow = {currency:string;earned_minor:string;accrued_minor:string;credited_minor:string;reversed_minor:string;net_received_minor:string};
type Report = {
  status:'available'; from:string; to:string; timezone:'Europe/Sofia'; page:number; pageSize:number; totalRegistrations:number; hasMore:boolean;
  registrations:{plan:Plan;count:number}[]; currencies:CurrencyRow[];
  members:{id:string;email:string;name:string|null;plan:Plan;signupPlan:Plan|null;createdAt:string}[];
};
const zone='Europe/Sofia';
const plans:Plan[]=['FREE','PRO','ULTRA'];
const dateLabel=new Intl.DateTimeFormat('bg-BG',{dateStyle:'medium',timeZone:zone});
const timeLabel=new Intl.DateTimeFormat('bg-BG',{timeStyle:'medium',timeZone:zone});
const calendar=new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit',timeZone:zone});

function sofiaToday() {
  const parts=calendar.formatToParts(new Date());
  return ['year','month','day'].map(name=>parts.find(part=>part.type===name)?.value).join('-');
}
function startFor(preset:Preset,today:string) {
  if (preset==='month') return today.slice(0,8)+'01';
  if (preset!=='week') return today;
  const midnight=new Date(today+'T00:00:00Z');
  midnight.setUTCDate(midnight.getUTCDate()-(midnight.getUTCDay()+6)%7);
  return midnight.toISOString().slice(0,10);
}
function isDay(value:string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const stamp=Date.parse(value+'T00:00:00Z');
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0,10)===value;
}

export function PerformanceFeesPanel() {
  const [preset,setPreset]=useState<Preset>('month');
  const [today,setToday]=useState(sofiaToday);
  const [custom,setCustom]=useState(()=>({from:startFor('month',today),to:today}));
  const [page,setPage]=useState(1);
  const [membersOpen,setMembersOpen]=useState(false);
  const [manual,setManual]=useState(0);
  const [state,setState]=useState<{key:string;data:Report|null;updated:number;error:boolean}|null>(null);
  const from=preset==='custom' ? custom.from : startFor(preset,today);
  const to=preset==='custom' ? custom.to : today;
  const valid=isDay(from) && isDay(to) && from<=to && to<=today;
  const key=[from,to,page].join('/');
  const current=state?.key===key ? state : null;
  const report=current?.data;
  useEffect(()=>{
    if (!valid) return;
    let controller:AbortController|null=null;
    let ended=false;
    const load=async()=>{
      if (ended || document.hidden || controller) return;
      const changedDay=sofiaToday();
      if (changedDay!==today) {setToday(changedDay); return;}
      const request=new AbortController();
      controller=request;
      const timeout=window.setTimeout(()=>request.abort(),12_000);
      try {
        const query=new URLSearchParams({from,to,page:String(page)});
        const res=await fetch('/api/admin/performance-fees?'+query,{cache:'no-store',signal:request.signal});
        const value:Report=await res.json();
        if (!res.ok || value.status!=='available' || value.timezone!==zone || value.from!==from || value.to!==to || value.page!==page ||
            !Array.isArray(value.registrations) || !Array.isArray(value.currencies) || !Array.isArray(value.members)) throw Error();
        if (!ended) setState({key,data:value,updated:Date.now(),error:false});
      } catch {
        if (!ended) setState({key,data:null,updated:0,error:true});
      } finally {window.clearTimeout(timeout); controller=null;}
    };
    const reload=()=>void load();
    reload();
    const timer=window.setInterval(reload,15_000);
    document.addEventListener('visibilitychange',reload);
    window.addEventListener('focus',reload);
    return ()=>{
      ended=true;controller?.abort();window.clearInterval(timer);
      document.removeEventListener('visibilitychange',reload);window.removeEventListener('focus',reload);
    };
  },[from,to,page,today,key,valid,manual]);
  return <div className="operator-admin-panel-data">
    <div className="shark-admin-period">
      <label>Период на справката <select value={preset} onChange={e=>{
        const next=e.target.value as Preset;
        if(next==='custom') setCustom({from,to});
        setPage(1);setPreset(next);
      }}>
        <option value="day">Днес</option><option value="week">Тази седмица</option>
        <option value="month">Този месец</option><option value="custom">Избери дати</option>
      </select></label>
      {preset==='custom' && <>
        <label>От <input type="date" value={from} max={today} onChange={e=>{setPage(1);setCustom({...custom,from:e.target.value});}}/></label>
        <label>До <input type="date" value={to} max={today} min={from} onChange={e=>{setPage(1);setCustom({...custom,to:e.target.value});}}/></label>
      </>}
      <button type="button" className="shark-action-secondary" disabled={!valid} onClick={()=>setManual(n=>n+1)}>Обнови справката</button>
    </div>
    {!valid ? <p role="alert">Избери начална и крайна дата до днес в хронологичен ред.</p>
      : current?.error ? <p role="alert">Справката е временно недостъпна.</p>
      : !report ? <p role="status">Зареждане на справката…</p>
      : <>
        <p>От {dateLabel.format(new Date(from+'T12:00:00Z'))} до {dateLabel.format(new Date(to+'T12:00:00Z'))}, по софийско време. Обновено в {timeLabel.format(current.updated)}.</p>
        <h3>Регистрации за периода · {report.totalRegistrations}</h3>
        <p>По текущ план · {plans.map(plan=>plan+' '+(report.registrations.find(row=>row.plan===plan)?.count ?? 0)).join(' · ')}</p>
        {(report.members.length>0 || page>1) && <details className="shark-admin-members" open={membersOpen}
          onToggle={event=>setMembersOpen(event.currentTarget.open)}><summary>Потребители за периода</summary>
          <div className="operator-table shark-admin-table"><table>
          <thead><tr><th scope="col">Потребител</th><th scope="col">План при регистрация</th><th scope="col">Текущ план</th><th scope="col">Регистрация</th></tr></thead>
          <tbody>{report.members.map(member=><tr key={member.id}><td>{member.email}{member.name && <small>{member.name}</small>}</td>
            <td>{member.signupPlan ?? 'Няма данни'}</td><td>{member.plan}</td><td>{dateLabel.format(new Date(member.createdAt))}</td></tr>)}</tbody>
        </table></div>
        {(page>1 || report.hasMore) && <nav className="shark-admin-pager" aria-label="Регистрации за периода">
          <button className="shark-action-secondary" type="button" disabled={page<=1} onClick={()=>setPage(p=>p-1)}>Предишна</button>
          <span>Страница {page}</span>
          <button className="shark-action-secondary" type="button" disabled={!report.hasMore} onClick={()=>setPage(p=>p+1)}>Следваща</button>
        </nav>}
        </details>}
        <h3>Комисиони от инвестиции</h3>
        {report.currencies.length===0 ? <p>Няма отчетени комисиони за периода.</p> : <>
          <p>Начислените суми са по последния ден на периода за търговия. Постъпленията и сторниранията са по датата на брокерския запис в София.</p>
          {report.currencies.map(row=><section key={row.currency} aria-label={'Комисиони в '+row.currency}>
            <h4>{row.currency}</h4><dl className="shark-admin-fee-metrics">
              <div><dt>Начислени за периода</dt><dd>{displayMinor(row.earned_minor,row.currency)}</dd></div>
              <div><dt>Остават за получаване</dt><dd>{displayMinor(row.accrued_minor,row.currency)}</dd></div>
              <div><dt>Получени по сметката</dt><dd>{displayMinor(row.credited_minor,row.currency)}</dd></div>
              <div><dt>Сторнирани постъпления</dt><dd>{displayMinor(row.reversed_minor,row.currency)}</dd></div>
              <div><dt>Нетно получени</dt><dd>{displayMinor(row.net_received_minor,row.currency)}</dd></div>
            </dl>
          </section>)}
        </>}
      </>}
  </div>;
}
