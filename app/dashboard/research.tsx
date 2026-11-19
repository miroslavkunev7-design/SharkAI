'use client';

import { useEffect, useState } from 'react';
import { displayMinor } from '@/lib/wallet-investments-contract';

type Domain = 'investments'|'products';
type Metric = number|string|null;
type Candidate = {
  id:string; label:string; rank:number|null; status:string; metrics:Record<string,Metric>; reasons:string[];
};
type Ranking = {domain:'investments'|'dropshipping';status:'ranked'|'insufficient_data'|'unavailable';as_of:string;
  currency:string|null;criteria:string[];candidates:Candidate[];leader_id:string|null};
const metricNames:Record<string,string>={
  sample_count:'Исторически периоди',holdout_samples:'Периоди за независима проверка',horizon_days:'Продължителност на период (дни)',
  median_net_bps:'Медианна нетна доходност',holdout_median_net_bps:'Медиана при независимата проверка',
  holdout_lower_quartile_bps:'Долен квартил при проверката',max_drawdown_bps:'Максимален спад от връх',
  worst_period_bps:'Най-слаб период',positive_periods_bps:'Дял на положителните периоди',orders:'Платени поръчки',
  net_contribution_minor:'Нетен принос след разходите',margin_bps:'Реализиран марж',recent_margin_bps:'Марж в последния период',
  orders_growth_bps:'Промяна в поръчките',refund_rate_bps:'Дял на възстановяванията',
  customer_concentration_upper_bps:'Горна оценка за концентрацията на клиентите',inventory_units:'Налични бройки',
};
const moment=(value:string|number|null|undefined)=>value && Number.isFinite(Date.parse(String(value)))
  ? new Intl.DateTimeFormat('bg-BG',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Sofia'}).format(new Date(value)) : 'Непотвърдено';
const date=(value:Metric|undefined)=>typeof value==='string' && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat('bg-BG',{dateStyle:'medium',timeZone:'UTC'}).format(new Date(value)) : 'Непотвърден';
function metricValue(name:string,value:Metric,currency:string|null) {
  if(value===null) return 'Недостъпно';
  if(name.endsWith('_minor')) return displayMinor(String(value),currency);
  if(name.endsWith('_bps')) return (Number(value)/100).toLocaleString('bg-BG',{maximumFractionDigits:2})+'%';
  return typeof value==='number'?value.toLocaleString('bg-BG'):value;
}
export function ResearchPanel({domain,currency,horizonDays}:{domain:Domain;currency:string|null;horizonDays?:number|null}) {
  const [revision,setRevision]=useState(0);
  const [horizonOverride,setHorizonOverride]=useState<number|null>(null);
  const horizon=horizonOverride??horizonDays??7;
  const [result,setResult]=useState<{key:string;report:Ranking|null}|null>(null);
  const query=new URLSearchParams();
  if(currency)query.set('currency',currency);
  if(domain==='investments')query.set('horizonDays',String(horizon));
  const url='/api/research/'+domain+'?'+query;
  useEffect(()=>{
    const controller=new AbortController();
    void fetch(url,{cache:'no-store',signal:controller.signal}).then(async response=>{
      if(!response.ok)throw Error();
      const body=await response.json() as Ranking;
      if(body.domain!==(domain==='investments'?'investments':'dropshipping')||!Array.isArray(body.candidates)||!Array.isArray(body.criteria))throw Error();
      if(!controller.signal.aborted)setResult({key:url,report:body});
    }).catch(()=>{if(!controller.signal.aborted)setResult({key:url,report:null});});
    return ()=>controller.abort();
  },[domain,url,revision]);
  const active=result?.key===url ? result : null;
  const report=active?.report;
  const investment=domain==='investments';
  const leader=report?.candidates.find(candidate=>candidate.id===report.leader_id);
  return <section className="ice-section module-panel module-wallet-panel" data-ice-art="markets">
    <h2>{investment?'Сравнение на инвестиционни стратегии':'Продукти с потенциал'}</h2>
    {investment && <label className="commerce-day">Хоризонт за сравнение <select value={horizon}
      onChange={e=>setHorizonOverride(Number(e.target.value))}>
      {[...new Set([1,7,30,horizonDays??7,horizon])].sort((a,b)=>a-b).map(days=>
        <option key={days} value={days}>{days} {days===1?'ден':'дни'}</option>)}
    </select></label>}
    {!active ? <p role="status">Зареждане на сравнението…</p> : !report || report.status==='unavailable'
      ? <p role="status">Проверените данни за сравнението са недостъпни.</p>
      : <>
        <p>{leader ? 'Водещ кандидат по проверените показатели · '+leader.label
          : 'Проверените резултати още не определят водещ кандидат.'} Справка към {moment(report.as_of)} (София).</p>
        {report.criteria.length>0 && <details><summary>Критерии за класиране</summary><ul>{report.criteria.map(c=><li key={c}>{c}</li>)}</ul></details>}
        {report.candidates.map(candidate=><details key={candidate.id} className="commerce-candidate">
          <summary>{candidate.rank!==null ? candidate.rank+'. ' : ''}{candidate.label} · {candidate.status==='eligible'?'С достатъчни данни':
            candidate.status==='validation_candidate'?'За проверка с поръчки':'Недостатъчно данни'}</summary>
          <p>Период на данните · {date(candidate.metrics.window_start)} – {date(candidate.metrics.window_end)} (UTC).
            {' '}Данни от източника към {moment(candidate.metrics.source_observed_at)} (София).</p>
          <dl className="module-wallet-metrics">{Object.entries(metricNames).filter(([key])=>key in candidate.metrics).map(([key,title])=>
            <div key={key}><dt>{title}</dt><dd>{metricValue(key,candidate.metrics[key],report.currency)}</dd></div>)}</dl>
          {candidate.reasons.length>0 && <ul>{candidate.reasons.map(reason=><li key={reason}>{reason}</li>)}</ul>}
        </details>)}
      </>}
    <button type="button" className="shark-action-secondary" onClick={()=>setRevision(n=>n+1)}>Обнови сравнението</button>
  </section>;
}
