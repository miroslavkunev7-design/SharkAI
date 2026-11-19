import {isCryptoRange} from '@/lib/markets/crypto';
import {readCryptoChart} from '@/lib/markets/crypto.server';
export const runtime='nodejs';
export async function GET(request:Request){
  const params=new URL(request.url).searchParams,pair=params.get('pair')??'',range=params.get('range')??'1d';
  if([...params.keys()].some(k=>!['pair','range'].includes(k)||params.getAll(k).length>1) || !/^[A-Za-z0-9_.-]{2,40}$/.test(pair) || !isCryptoRange(range))return Response.json({status:'invalid_request'},{status:400});
  try{
    const data=await readCryptoChart(pair,range);
    return data?Response.json(data,{headers:{'Cache-Control':'public, s-maxage=30'}}):Response.json({status:'unknown_pair'},{status:404});
  }catch{return Response.json({status:'unavailable',source:'Kraken Spot'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
