'use client';

import Link from 'next/link';
import {useEffect, useState} from 'react';
import {Bitcoin, ChevronRight, Coins, Search} from 'lucide-react';
import {cryptoRanges,cryptoUnit,type CryptoCatalog,type CryptoChart,type CryptoRange} from '@/lib/markets/crypto';
import {PriceChart,useMarket} from '../dashboard/crypto-market';
import {dateLabel} from './wallet-data';

export {EquityMarkets} from './equity-markets';
function PortfolioQuote({symbol,name}:{symbol:string;name:string}) {
  const quote=useMarket<CryptoCatalog>('/api/markets/crypto?'+new URLSearchParams({q:symbol+'/EUR',page:'1'}));
  const row=quote?.rows.find(p=>p.base===symbol&&p.quote==='EUR');
  const Icon=symbol==='BTC'?Bitcoin:Coins;
  const contents=<><span className="row-icon"><Icon size={22}/></span><span className="row-label"><strong>{name}</strong>
    <small>{symbol} · {row?.ticker&&quote?.checked_at?'Kraken Spot · '+dateLabel(quote.checked_at,true):quote===undefined?'Зареждане…':'Няма потвърдена котировка'}</small></span>
    <span className="row-end">{row?.ticker&&quote?.checked_at?cryptoUnit(Number(row.ticker.price))+' EUR':'—'}</span></>;
  return row?<Link className="item-row clickable" href={'/wallet?tab=asset&pair='+encodeURIComponent(row.id)}>{contents}</Link>:<div className="item-row">{contents}</div>;
}
export function PublicMarkets({compact=false}:{compact?:boolean}) {
  if(!compact)return <MarketSearch/>;
  return <div className="panel" data-scene="crypto" data-scene-tone="light"><h2 className="section-title">Криптовалути</h2><div className="list">
    <PortfolioQuote symbol="BTC" name="Bitcoin"/><PortfolioQuote symbol="ETH" name="Ethereum"/><PortfolioQuote symbol="SOL" name="Solana"/>
  </div></div>;
}
function MarketSearch() {
  const [term,setTerm]=useState(''),[query,setQuery]=useState(''),[page,setPage]=useState(1);
  useEffect(()=>{const delay=setTimeout(()=>{setQuery(term.trim());setPage(1);},250);return ()=>clearTimeout(delay);},[term]);
  const catalog=useMarket<CryptoCatalog>('/api/markets/crypto?'+new URLSearchParams({q:query,page:String(page)}));
  const rows=catalog?.rows;
  return <div className="panel" data-scene="search" data-scene-tone="light"><h2 className="section-title">Криптовалути</h2>
    <label className="field"><span><Search size={15}/> Търсене на пазари</span><input type="search" maxLength={60}
      value={term} onChange={e=>setTerm(e.target.value)} placeholder="Име, символ или валутна двойка"/></label>
    <div className="list">{rows?.map(row=><Link className="item-row clickable" key={row.id}
      href={'/wallet?tab=asset&pair='+encodeURIComponent(row.id)}>
      <span className="row-icon"><Bitcoin size={21}/></span><span className="row-label"><strong>{row.name}</strong>
        <small>{row.base}/{row.quote} · Kraken Spot</small></span><span className="row-end">{row.ticker&&catalog?.checked_at?
          cryptoUnit(Number(row.ticker.price))+' '+row.quote:'—'}</span><ChevronRight size={16}/></Link>)}</div>
    {!rows?.length&&<p role="status">{catalog===undefined?'Зареждане на пазара…':catalog===null?'Котировките са временно недостъпни.':'Няма намерени пазари.'}</p>}
    {catalog?.checked_at&&<p className="micro">Kraken Spot · {dateLabel(catalog.checked_at,true)} (София)</p>}
    {catalog&&catalog.pages>1&&<div className="row">
      <button className="button secondary" disabled={catalog.page<=1} onClick={()=>setPage(n=>n-1)}>Назад</button>
      <span>{catalog.page} / {catalog.pages}</span><button className="button secondary" disabled={catalog.page>=catalog.pages}
        onClick={()=>setPage(n=>n+1)}>Напред</button></div>}</div>;
}
export function PublicAsset({pair}:{pair:string|null}) {
  const [range,setRange]=useState<CryptoRange>('1d');
  return pair?<AssetChart pair={pair} range={range} change={setRange}/>:<PublicMarkets/>;
}
function AssetChart({pair,range,change}:{pair:string;range:CryptoRange;change:(range:CryptoRange)=>void}) {
  const result=useMarket<CryptoChart>('/api/markets/crypto/chart?'+new URLSearchParams({pair,range}));
  const data=result?.pair.id===pair&&result.range===range?result:null;
  return <div className="panel" data-scene="performance" data-scene-tone="light"><div className="row"><h2>{data?data.pair.base+' / '+data.pair.quote:pair}</h2><span className="badge">Kraken Spot</span></div>
    <p className="amount">{data?.ticker&&data.ticker_at?cryptoUnit(Number(data.ticker.price))+' '+data.pair.quote:'—'}</p>
    {data?.ticker_at&&<p className="micro">Котировка към {dateLabel(data.ticker_at,true)} (София)</p>}
    <div className="chips">{(Object.keys(cryptoRanges) as CryptoRange[]).map(k=><button key={k} type="button"
      className={'chip'+(k===range?' active':'')} aria-pressed={k===range} onClick={()=>change(k)}>{cryptoRanges[k].label}</button>)}</div>
    {data?<><PriceChart data={data}/><p className="micro">История от Kraken Spot · {dateLabel(data.checked_at,true)} (София)</p></>:
      <p role="status">{result===undefined?'Зареждане…':'Няма потвърдени пазарни данни за тази двойка.'}</p>}</div>;
}
