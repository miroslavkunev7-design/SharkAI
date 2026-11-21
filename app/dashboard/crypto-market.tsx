'use client';

import {useEffect,useId,useState} from 'react';
import {cryptoRanges,cryptoUnit,type CryptoCatalog,type CryptoChart,type CryptoRange} from '@/lib/markets/crypto';
import './crypto-market.css';

const clock=new Intl.DateTimeFormat('bg-BG',{hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'Europe/Sofia'});
const dateTime=new Intl.DateTimeFormat('bg-BG',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Sofia'});
const count=new Intl.NumberFormat('bg-BG');
const modes:Record<string,string>={post_only:'Само пасивни поръчки',cancel_only:'Само отмяна',limit_only:'Само лимитирани поръчки',reduce_only:'Само намаляване на позиции',maintenance:'Поддръжка'};
function mode(status:string){return status==='online'?'':modes[status]??status;}
function percent(n:number|null|undefined){
  return n==null?'—':new Intl.NumberFormat('bg-BG',{signDisplay:'exceptZero',maximumFractionDigits:2}).format(n)+'%';
}

export function useMarket<T extends {status:'available'}>(url:string) {
  const [result,setResult]=useState<{url:string;data:T|null}|null>(null);
  useEffect(()=>{
    const controller=new AbortController();
    let running=false;
    async function load(){
      if(running || document.visibilityState==='hidden')return;
      running=true;
      try{
        const r=await fetch(url,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]),credentials:'omit',referrerPolicy:'no-referrer'});
        if(!r.ok)throw Error('Market unavailable');
        const data:T=await r.json();
        if(data.status!=='available')throw Error('Market unavailable');
        if(!controller.signal.aborted)setResult({url,data});
      }catch{if(!controller.signal.aborted)setResult({url,data:null});}
      finally{running=false;}
    }
    void load();
    const timer=setInterval(load,45000);
    document.addEventListener('visibilitychange',load);
    return ()=>{controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',load);};
  },[url]);
  return result?.url===url?result.data:undefined;
}

export function PriceChart({data}:{data:CryptoChart}) {
  const [index,setIndex]=useState<number|null>(null);
  const title=useId(),id=useId(),rows=data.candles,step=data.interval_minutes*60;
  if(!rows.length)return <p className="crypto-status">За този период няма потвърдени завършени интервали със сделки.</p>;
  const w=720,h=204,left=14,right=88,top=16,bottom=21,first=rows[0].start,last=rows[rows.length-1].start;
  const low=Math.min(...rows.map(r=>r.close)),high=Math.max(...rows.map(r=>r.close));
  const y=(v:number)=>low===high?(top+h-bottom)/2:top+(high-v)*(h-bottom-top)/(high-low);
  const x=(v:number)=>last===first?(w-right+left)/2:left+(v-first)*(w-right-left)/(last-first);
  const path=rows.map((r,i)=>((i===0 || r.start-rows[i-1].start!==step)?'M':'L')+x(r.start).toFixed(2)+' '+y(r.close).toFixed(2)).join(' ');
  const selected=index===null?rows.length-1:Math.min(index,rows.length-1),point=rows[selected];
  const latestDate=dateTime.format(new Date((last+step)*1000));
  return <figure className="crypto-figure">
    <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-labelledby={title}>
      <title id={title}>Цена на затваряне за {data.pair.base}/{data.pair.quote}, {cryptoRanges[data.range].label}</title>
      {(high===low?[low]:[high,(high+low)/2,low]).map(v=><g key={v}><line x1={left} x2={w-right} y1={y(v)} y2={y(v)} className="crypto-gridline"/><text x={w-right+8} y={y(v)+4}>{cryptoUnit(v)}</text></g>)}
      <path d={path} fill="none" className="crypto-line" vectorEffect="non-scaling-stroke"/>
      {rows.map((r,i)=>(i===0 || r.start-rows[i-1].start!==step) && (i+1===rows.length || rows[i+1].start-r.start!==step)?
        <circle key={r.start} cx={x(r.start)} cy={y(r.close)} r={2.5} className="crypto-point"/>:null)}
      <line x1={x(point.start)} x2={x(point.start)} y1={top} y2={h-bottom} className="crypto-marker"/>
      <circle cx={x(point.start)} cy={y(point.close)} r="4" className="crypto-point"/>
    </svg>
    <div className="crypto-axis"><span>{dateTime.format(new Date((first+step)*1000))}</span><span>{latestDate}</span></div>
    <label htmlFor={id} className="crypto-scrub-label">Избран интервал <strong>{dateTime.format(new Date((point.start+step)*1000))} · {cryptoUnit(point.close)} {data.pair.quote}</strong></label>
    <input id={id} type="range" min={0} max={rows.length-1} value={selected} disabled={rows.length===1}
      aria-valuetext={dateTime.format(new Date((point.start+step)*1000))+' · '+cryptoUnit(point.close)+' '+data.pair.quote}
      onChange={event=>setIndex(Number(event.target.value))}/>
    <figcaption>{data.interval_minutes} мин. на интервал · {count.format(rows.length)} интервала със сделки · Часове за София</figcaption>
  </figure>;
}

export function CryptoMarketPanel(){
  const heading=useId();
  const [term,setTerm]=useState(''),[query,setQuery]=useState(''),[page,setPage]=useState(1);
  const [selected,setSelected]=useState({id:'XXBTZUSD',base:'BTC',quote:'USD'});
  const [range,setRange]=useState<CryptoRange>('1d');
  useEffect(()=>{const t=setTimeout(()=>{setQuery(term.trim());setPage(1);},260);return ()=>clearTimeout(t);},[term]);
  const catalog=useMarket<CryptoCatalog>('/api/markets/crypto?'+new URLSearchParams({q:query,page:String(page)}));
  const chart=useMarket<CryptoChart>('/api/markets/crypto/chart?'+new URLSearchParams({pair:selected.id,range}));
  const ticker=chart?.ticker;
  return <section className="crypto-market" aria-labelledby={heading}>
    <header><h2 id={heading}>Криптопазар</h2><p>Спот пазари на Kraken · Обновяване на 45 секунди</p></header>
    <section className="crypto-detail" aria-label="Избран пазар">
      <div className="crypto-title"><h3>{selected.base}<span> / {selected.quote}</span></h3>
        <div className="crypto-ranges" role="group" aria-label="Период на графиката">
          {(Object.keys(cryptoRanges) as CryptoRange[]).map(r=><button type="button" key={r} aria-pressed={range===r} onClick={()=>setRange(r)}>{cryptoRanges[r].label}</button>)}
        </div></div>
      {chart===undefined?<p role="status" className="crypto-status">Зареждане на пазара…</p>:!chart?<p role="status" className="crypto-status">Данните за избрания пазар временно са недостъпни.</p>:<>
        {mode(chart.pair.market_status)&&<p className="crypto-status">Режим на пазара: {mode(chart.pair.market_status)}</p>}
        {ticker?.trades_24h===0&&<p className="crypto-status">Няма сделки през последните 24 часа.</p>}
        <dl className="crypto-metrics">
          <div><dt>Последна сделка</dt><dd>{ticker?cryptoUnit(Number(ticker.price))+' '+selected.quote:'Няма актуална котировка'}</dd></div>
          <div><dt>Промяна от 00:00 UTC</dt><dd>{percent(ticker?.day_change_pct)}</dd></div>
          <div><dt>Обем за 24 ч.</dt><dd>{ticker?cryptoUnit(Number(ticker.volume_24h))+' '+selected.base:'—'}</dd></div>
        </dl>
        <PriceChart key={selected.id+range} data={chart}/>
        <p className="crypto-at">История проверена в {clock.format(new Date(chart.checked_at))}{chart.ticker_at?' · Котировка проверена в '+clock.format(new Date(chart.ticker_at)):''} · София</p>
      </>}
    </section>
    <div className="crypto-search"><label>Търси пазар<input type="search" placeholder="Например BTC, ETH/EUR или Bitcoin" value={term} maxLength={60}
      onChange={event=>setTerm(event.target.value)}/></label>
      {catalog&&<span>{count.format(catalog.matched)} от {count.format(catalog.total)} двойки · По брой сделки за 24 ч.</span>}</div>
    {catalog===undefined?<p role="status" className="crypto-status">Зареждане на пазарите…</p>:!catalog?<p role="status" className="crypto-status">Каталогът на Kraken временно е недостъпен.</p>
      : !catalog.rows.length?<p role="status">Няма пазар, който съответства на търсенето.</p>:<>
        {!catalog.checked_at&&<p role="status">Каталогът е наличен. Актуалните котировки временно са недостъпни.</p>}
        <div className="crypto-table-scroll"><table><caption>Котировки на Kraken{catalog.checked_at?' · Проверени в '+clock.format(new Date(catalog.checked_at))+' ч. за София':''}</caption>
          <thead><tr><th scope="col">Пазар</th><th scope="col">Последна цена</th><th scope="col">От 00:00 UTC</th><th scope="col">Обем за 24 ч.</th></tr></thead>
          <tbody>{catalog.rows.map(row=><tr key={row.id} data-selected={row.id===selected.id}><th scope="row">
            <button type="button" aria-pressed={row.id===selected.id} onClick={()=>setSelected(row)}>{row.base}/{row.quote}</button>
            {mode(row.market_status)&&<small className="crypto-mode">{mode(row.market_status)}</small>}
          </th><td>{row.ticker?cryptoUnit(Number(row.ticker.price))+' '+row.quote:'—'}</td><td>{percent(row.ticker?.day_change_pct)}</td>
          <td>{row.ticker?cryptoUnit(Number(row.ticker.volume_24h))+' '+row.base:'—'}</td></tr>)}</tbody>
        </table></div>
        {catalog.pages>1&&<div className="crypto-pagination" aria-label="Страници на каталога">
          <button type="button" disabled={catalog.page<=1} onClick={()=>setPage(catalog.page-1)}>Назад</button>
          <span>{catalog.page} / {catalog.pages}</span>
          <button type="button" disabled={catalog.page>=catalog.pages} onClick={()=>setPage(catalog.page+1)}>Напред</button>
        </div>}
      </>}
    <small><a href="https://docs.kraken.com/api-reference/market-data/get-ticker-information" target="_blank" rel="noreferrer">Източник на котировките: Kraken</a></small>
  </section>;
}
