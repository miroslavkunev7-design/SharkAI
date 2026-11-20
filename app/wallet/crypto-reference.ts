/** Read-only Kraken Spot market reference. Never a Wise quote or trade instruction. */
const listedCrypto=new Set(['BTC','ETH','USDT']);
const safeCode=/^[A-Z]{3,5}$/;

export function krakenPairRequest(base:string,quote:string):{pair:string;inverted:boolean}|null {
 if(!safeCode.test(base)||!safeCode.test(quote)||base===quote)return null;
 const baseCrypto=listedCrypto.has(base),quoteCrypto=listedCrypto.has(quote);
 if(!baseCrypto&&!quoteCrypto)return null;
 const pairBase=baseCrypto?base:quote;
 const pairQuote=baseCrypto?quote:base;
 return {pair:pairBase+'/'+pairQuote,inverted:!baseCrypto};
}

export type VerifiedKrakenReference={rate:number;date:string;source:'Kraken Spot'};

export function verifiedKrakenReference(base:string,quote:string,payload:unknown,now=Date.now()):VerifiedKrakenReference|null {
 const requested=krakenPairRequest(base,quote);
 if(!requested || !payload || typeof payload!=='object' || !Number.isFinite(now))return null;
 const response=payload as Record<string,unknown>;
 if(response.status!=='available'||response.source!=='Kraken Spot'||typeof response.checked_at!=='string'||!Array.isArray(response.rows))return null;
 const age=now-Date.parse(response.checked_at);
 if(!Number.isFinite(age)||age< -10000||age>180000)return null;
 const pairBase=requested.pair.split('/')[0],pairQuote=requested.pair.split('/')[1];
 const row=response.rows.find((candidate:unknown)=>{
  if(!candidate||typeof candidate!=='object')return false;
  const item=candidate as Record<string,unknown>;
  return item.base===pairBase&&item.quote===pairQuote&&item.market_status==='online';
 }) as Record<string,unknown>|undefined;
 if(!row||!row.ticker||typeof row.ticker!=='object')return null;
 const ticker=row.ticker as Record<string,unknown>;
 const priceRaw=ticker.price;
 if(typeof priceRaw!=='string'||!/^\d{1,18}(?:\.\d{1,18})?$/.test(priceRaw))return null;
 const price=Number(priceRaw),rate=requested.inverted?1/price:price;
 if(!Number.isFinite(price)||price<=0||!Number.isFinite(rate)||rate<=0)return null;
 return {rate,date:response.checked_at.slice(0,10),source:'Kraken Spot'};
}
