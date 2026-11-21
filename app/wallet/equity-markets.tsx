'use client';

import Link from 'next/link';
import {useState} from 'react';
import {TrendingUp} from 'lucide-react';
import {equityListings,equityPeriods,equityWindow,type EquityCatalog,type EquityClose,type EquityListing,type EquitySeries} from '@/lib/markets/equities';
import {useMarket} from '../dashboard/crypto-market';
import {dateLabel} from './wallet-data';
import {TradingViewChart} from './tradingview-chart';

const dayFormat = new Intl.DateTimeFormat('bg-BG',{dateStyle:'medium',timeZone:'UTC'});
const dayLabel = (day:string)=>dayFormat.format(new Date(day+'T00:00:00Z'));
const price = (value:number,currency:string)=>new Intl.NumberFormat('bg-BG',{style:'currency',currency,maximumFractionDigits:4}).format(value);

function CloseChart({points,listing}:{points:EquityClose[];listing:EquityListing}) {
  const [days,setDays]=useState<typeof equityPeriods[number]>(30);
  const rows=equityWindow(points,days);
  const first=rows[0], last=rows[rows.length-1];
  const start=Date.parse(first.day), span=Date.parse(last.day)-start;
  const low=Math.min(...rows.map(row=>row.close)), high=Math.max(...rows.map(row=>row.close));
  const coords=rows.map(row=>{
    const x=span?12+596*(Date.parse(row.day)-start)/span:310;
    const y=high>low?126-105*(row.close-low)/(high-low):72;
    return {x,y};
  });
  return <>
    <div className="chips" aria-label="Период на графиката">{equityPeriods.map(n=><button type="button" key={n} className={'chip'+(n===days?' active':'')} aria-pressed={n===days} onClick={()=>setDays(n)}>{n} дни</button>)}</div>
    <figure className="crypto-figure">
      <svg viewBox="0 0 720 150" role="img" aria-label={'Дневни цени на затваряне на '+listing.symbol+' от '+dayLabel(first.day)+' до '+dayLabel(last.day)}>
        <line x1="12" y1="21" x2="610" y2="21" className="crypto-gridline"/>
        <line x1="12" y1="126" x2="610" y2="126" className="crypto-gridline"/>
        {high>low?<><text x="620" y="25">{price(high,listing.currency)}</text><text x="620" y="130">{price(low,listing.currency)}</text></>:<text x="620" y="76">{price(low,listing.currency)}</text>}
        <polyline points={coords.map(({x,y})=>x.toFixed(2)+','+y.toFixed(2)).join(' ')} fill="none" className="crypto-line" vectorEffect="non-scaling-stroke"/>
        {coords.map(({x,y},i)=><circle cx={x} cy={y} r={rows.length<10?3:1.8} key={rows[i].day} className="crypto-point"><title>{dayLabel(rows[i].day)+' · '+price(rows[i].close,listing.currency)}</title></circle>)}
      </svg>
      <figcaption className="crypto-axis"><span>{dayLabel(first.day)}</span><span>{dayLabel(last.day)}</span></figcaption>
    </figure>
  </>;
}

function confirmed(series:EquitySeries|undefined): series is Extract<EquitySeries,{points:EquityClose[]}> {
  return !!series && 'points' in series && series.points.length>0;
}

export function EquityMarkets({searchable=false,symbol=null}:{searchable?:boolean;symbol?:string|null}) {
  const [term,setTerm]=useState('');
  const catalog=useMarket<EquityCatalog>('/api/markets/equities');
  const rows=equityListings.filter(row=>(!symbol || row.symbol===symbol.toUpperCase()) && (row.name+' '+row.symbol).toLowerCase().includes(term.trim().toLowerCase()));
  const selected=symbol?rows[0]:null;
  const series=selected?catalog?.series[selected.symbol]:undefined;
  const hasData=rows.some(row=>confirmed(catalog?.series[row.symbol]));
  return <div className="panel" data-scene="investments" data-scene-tone="light"><h2 className="section-title">Акции и ETF</h2>
    {searchable&&<label className="field"><span>Търси инструмент</span><input type="search" value={term} maxLength={60} onChange={e=>setTerm(e.target.value)}/></label>}
    <div className="list">{rows.map(listing=>{
      const result=catalog?.series[listing.symbol];
      const closing=confirmed(result)?result.points.at(-1):undefined;
      const contents=<><span className="row-icon"><TrendingUp size={22}/></span><span className="row-label"><strong>{listing.name}</strong><small>{listing.symbol} · {listing.venue} · {listing.currency}</small>
        <small>{closing?(result?.state==='historical'?'Архивна цена · ':'Затваряне · ')+dayLabel(closing.day):catalog===undefined?'Зареждане…':'Пазарна графика от TradingView'}</small></span>
        <span className="row-end">{closing?price(closing.close,listing.currency):'—'}</span></>;
      return selected?<div key={listing.symbol} className="item-row">{contents}</div>:<Link key={listing.symbol} className="item-row clickable" href={'/wallet?tab=asset&kind=invest&pair='+listing.symbol}>{contents}</Link>;
    })}</div>
    {selected&&confirmed(series)&&<><CloseChart key={selected.symbol} listing={selected} points={series.points}/>
      <p className="micro">Дневни цени за приключили борсови дни до вчера, местно време за {selected.venue}. Проверени на {dateLabel(series.checkedAt,true)} (София).</p></>}
    {selected&&catalog!==undefined&&!confirmed(series)&&<TradingViewChart listing={selected}/>}
    {selected&&<a className="button secondary" href={selected.historyUrl} target="_blank" rel="noopener noreferrer">Виж историята на {selected.symbol} в Twelve Data</a>}
    {hasData&&<small>Данни от <a href="https://twelvedata.com/" target="_blank" rel="noopener">Twelve Data</a></small>}
    {!rows.length&&<p>Няма намерени инструменти.</p>}
  </div>;
}
