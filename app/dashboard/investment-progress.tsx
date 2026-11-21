'use client';
import {useEffect,useId,useState} from 'react';
import type {InvestmentProgressReport} from '@/lib/investments/investment-progress.server';
import type {OpportunitiesReport} from '@/lib/investments/investment-progress-opportunities.server';
import {currencyMinorDigits,displayMinor} from '@/lib/wallet-investments-contract';
import './investment-progress.css';

const moment=(s:string)=>new Intl.DateTimeFormat('bg-BG',{dateStyle:'short',timeStyle:'medium',timeZone:'UTC'}).format(new Date(s));
const shortDate=(s:string)=>new Intl.DateTimeFormat('bg-BG',{dateStyle:'medium',timeZone:'UTC'}).format(new Date(s));
const percentage=(n:number|string)=>new Intl.NumberFormat('bg-BG',{maximumFractionDigits:2}).format(Number(n))+'%';
const stageNames={active:'Действащ мандат',stopped:'Спряна търговия',revoked:'Оттеглен мандат',expired:'Изтекъл мандат',scheduled:'Предстоящ период'};
function useReport<T>(url:string,interval:number){
  const [result,setResult]=useState<{url:string;data:T|null;error:boolean}|null>(null),[revision,refresh]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    let pending=false;
    async function load(){
      if(pending||document.hidden)return;
      pending=true;
      try{
        const response=await fetch(url,{cache:'no-store',signal:controller.signal});
        if(!response.ok)throw Error('Unavailable');
        const data:T=await response.json();
        if(!controller.signal.aborted)setResult({url,data,error:false});
      }catch{if(!controller.signal.aborted)setResult(previous=>({url,data:previous?.url===url?previous.data:null,error:true}));}
      finally{pending=false;}
    }
    void load();
    const timer=window.setInterval(()=>void load(),interval);
    const onVisible=()=>{if(!document.hidden)void load();};
    document.addEventListener('visibilitychange',onVisible);
    return ()=>{controller.abort();window.clearInterval(timer);document.removeEventListener('visibilitychange',onVisible);};
  },[url,interval,revision]);
  return {data:result?.url===url?result.data:null,error:result?.url===url&&result.error,refresh:()=>refresh(n=>n+1)};
}
function ProgressChart({data}:{data:InvestmentProgressReport}){
  const label=useId(),[position,setPosition]=useState<number|null>(null);
  const points=data.points,isGoal=data.goal_minor!==null;
  if(!points.length)return null;
  const index=Math.min(position??points.length-1,points.length-1),chosen=points[index];
  const digits=data.currency?currencyMinorDigits(data.currency)??2:2;
  const values=points.map(p=>isGoal?Number(p.percent):Number(p.net_minor)/10**digits);
  const bottom=Math.min(0,...values),top=Math.max(isGoal?100:0,...values),span=top-bottom||1;
  const times=points.map(p=>Date.parse(p.observed_at)),from=times[0],to=times[times.length-1];
  const x=(i:number)=>64+(to===from?0.5:(times[i]-from)/(to-from))*624;
  const y=(v:number)=>top===bottom?92:15+(top-v)/span*155;
  const axis=(v:number)=>isGoal?percentage(v):new Intl.NumberFormat('bg-BG',{notation:'compact',maximumFractionDigits:2}).format(v);
  const tickValues=isGoal?[top,100,0,bottom]:[top,0,bottom];
  return <figure className="investment-progress-chart" aria-labelledby={label}>
    <figcaption id={label}>{isGoal?'Изпълнение на целта по потвърдени отчети':'Отчетен нетен резултат по време · '+data.currency}</figcaption>
    <svg viewBox="0 0 700 190" role="img" aria-label="Отчетен резултат спрямо времето. Данните за всеки показан отчет са достъпни под графиката.">
      {[...new Set(tickValues)].map(v=><g key={v}><line x1="64" x2="688" y1={y(v)} y2={y(v)} className={isGoal&&v===100?'target':'grid'}/><text x="56" y={y(v)+4} textAnchor="end">{axis(v)}</text></g>)}
      {points.length>1&&<polyline points={values.map((v,i)=>x(i)+','+y(v)).join(' ')} fill="none" className="observed"/>}
      {points.map((p,i)=><circle key={p.observed_at} cx={x(i)} cy={y(values[i])} r={i===index?5:2} className="point"
        onMouseEnter={()=>setPosition(i)}><title>{moment(p.observed_at)} UTC · {isGoal?percentage(values[i]):displayMinor(p.net_minor,data.currency)}</title></circle>)}
    </svg>
    <div className="investment-chart-times"><time>{moment(points[0].observed_at)} UTC</time><time>{moment(points[points.length-1].observed_at)} UTC</time></div>
    {points.length>1&&<label>Избери отчет <input type="range" min="0" max={points.length-1} value={index} onChange={e=>setPosition(Number(e.target.value))}/></label>}
    <p>{moment(chosen.observed_at)} UTC · {chosen.percent!==null&&<><strong>{percentage(chosen.percent)}</strong> · </>}{displayMinor(chosen.net_minor,data.currency)}</p>
    {data.reports>points.length&&<small>{data.reports} потвърдени отчета. Графиката пази първата, последната и крайните наблюдавани стойности във всеки времеви интервал.</small>}
  </figure>;
}
export function InvestmentProgress(){
  const [start,setStart]=useState('');
  const {data,error,refresh}=useReport<InvestmentProgressReport>('/api/wallet-investments/progress'+(start?'?start='+encodeURIComponent(start):''),30000);
  const last=data?.points.at(-1);
  return <section className="ice-section module-panel module-wallet-panel investment-progress" data-scene="targets" data-scene-tone="light">
    <div className="investment-progress-heading"><h2>Изпълнение на инвестиционната цел</h2>
      <button type="button" className="shark-action-secondary" onClick={refresh}>Обнови отчетите</button></div>
    {error&&<p role="status">Справката не успя да се обнови.</p>}
    {!data&&!error&&<p role="status">Зареждане на брокерските отчети…</p>}
    {data?.status==='unavailable'&&<p>Отчетите за целта са временно недостъпни.</p>}
    {data?.status==='no_mandate'&&<p>Все още няма подписан инвестиционен мандат за този профил.</p>}
    {data?.stage&&<>
      <p>{stageNames[data.stage]} · {data.provider==='IBKR'?'Interactive Brokers':'Saxo'} · {data.currency}</p>
      {data.windows.length>1&&<label>Отчетен период <select value={start} onChange={e=>setStart(e.target.value)}>
        <option value="">Последен период</option>{data.windows.slice(1).map(d=><option key={d} value={d}>От {shortDate(d)}</option>)}</select></label>}
      <p>От {shortDate(data.start!)} до {shortDate(data.end!)} (крайна дата без включване, UTC).</p>
      <dl className="module-wallet-metrics"><div><dt>Цел за периода</dt><dd>{data.goal_minor?displayMinor(data.goal_minor,data.currency):'Без парична цел'}</dd></div>
        <div><dt>Отчетен резултат при закриване</dt><dd>{last?displayMinor(last.net_minor,data.currency):'Няма отчет'}</dd></div>
        <div><dt>Изпълнение на целта</dt><dd>{last?.percent!=null?percentage(last.percent):'Няма изчислен процент'}</dd></div></dl>
      {data.status==='no_observations'?<p>Периодът още няма съвпадащи брокерски и независими отчети.</p>:<>
        {data.target_reached===true&&<p>Целта е достигната в поне един потвърден отчет през периода.</p>}
        <ProgressChart key={data.start} data={data}/>
        <p>{data.fresh&&!error?'Последно потвърждение':'Последен наличен отчет'} · {data.as_of&&moment(data.as_of)} UTC.
          {' '}Резултатът включва текущата оценка на позициите и отчетените разходи. Графиката не приспада допълнително такса на Shark AI. Депозити и тегления не участват в печалбата.</p>
        {data.realized_account_minor!==null&&<p>Натрупан уреден реализиран резултат по отделната брокерска сметка към същата дата · {displayMinor(data.realized_account_minor,data.currency)}.</p>}
      </>}
    </>}
  </section>;
}
export function InvestmentOpportunities({currency,publicOnly=false}:{currency?:string|null;publicOnly?:boolean}){
  const [days,setDays]=useState(7);
  const query=new URLSearchParams({days:String(days),...(currency&&!publicOnly?{currency}:{})});
  const path=publicOnly?'/api/market/opportunities':'/api/wallet-investments/progress/opportunities';
  const {data,error,refresh}=useReport<Partial<Pick<OpportunitiesReport,'currency'|'strategies'>>&Pick<OpportunitiesReport,'briefs'|'unavailable_sources'>>(path+'?'+query,300000);
  return <section className="ice-section module-panel module-wallet-panel investment-opportunities" data-scene="analytics" data-scene-tone="light">
    <div className="investment-progress-heading"><h2>Инвестиционни възможности за анализ</h2>
      <button type="button" className="shark-action-secondary" onClick={refresh}>Обнови анализа</button></div>
    <label>Период за сравнение <select value={days} onChange={e=>setDays(Number(e.target.value))}>{[1,7,14,21,28].map(n=><option key={n} value={n}>{n} {n===1?'ден':'дни'}</option>)}</select></label>
    {error&&<p role="status">Справката не успя да се обнови.</p>}
    {!data&&!error&&<p role="status">Зареждане на наблюденията…</p>}
    {data&&<>
      {data.briefs.map(b=><article key={b.category} className="investment-idea" data-scene={b.category === 'housing' ? 'holdings' : 'capital'} data-scene-tone="light"><h3>{b.title}</h3><strong>{b.metric} · {b.value}</strong>
        <p>{b.assessment}</p><p>{b.risk}</p><p>{b.source} · {b.period} · {shortDate(b.as_of)}. <a href={b.evidence_url} target="_blank" rel="noreferrer">Данни от източника</a></p></article>)}
      {(data.strategies??[]).map(s=><article key={s.id} className="investment-idea" data-scene="strategy" data-scene-tone="light"><h3>{s.rank!==null?s.rank+'. ':''}{s.label}</h3>
        <small>{s.category==='ETF'?'Борсово търгуван фонд':s.category==='STOCK'?'Акция':'Брокерска стратегия'} · {s.instrument} · {data.currency}</small>
        <p>{s.assessment}</p><dl className="module-wallet-metrics"><div><dt>Медиана след разходите</dt><dd>{percentage(s.median_bps/100)}</dd></div>
          <div><dt>Медиана при проверка</dt><dd>{percentage(s.holdout_bps/100)}</dd></div><div><dt>Най-слаб период</dt><dd>{percentage(s.worst_bps/100)}</dd></div>
          <div><dt>Максимален спад от връх</dt><dd>{percentage(s.drawdown_bps/100)}</dd></div></dl>
        <p>{s.risk}</p>{s.qualifications.map(q=><p key={q}>{q}</p>)}
        <p>{s.samples} периода · {shortDate(s.start)} – {shortDate(s.end)} · {s.source}. <a href={s.source_url} target="_blank" rel="noreferrer">Брокерска справка</a></p></article>)}
      {!publicOnly&&!data.strategies?.length&&<p>За този профил още няма брокерска стратегия с достатъчно съпоставими наблюдения.</p>}
      {data.unavailable_sources.map(s=><p key={s}>{s} · липсват актуални потвърдени данни.</p>)}
    </>}
  </section>;
}
