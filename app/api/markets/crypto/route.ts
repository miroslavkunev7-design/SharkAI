import {readCryptoCatalog} from '@/lib/markets/crypto.server';
export const runtime='nodejs';
export async function GET(request:Request){
  const params=new URL(request.url).searchParams;
  const q=(params.get('q')??'').trim(),page=params.get('page')??'1';
  if([...params.keys()].some(k=>!['q','page'].includes(k)||params.getAll(k).length>1) || q.length>60 || !/^[1-9]\d{0,4}$/.test(page))return Response.json({status:'invalid_request'},{status:400});
  try{
    const data=await readCryptoCatalog(q,Number(page));
    return Response.json(data,{headers:{'Cache-Control':'public, s-maxage=20'}});
  }catch{return Response.json({status:'unavailable',source:'Kraken Spot'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
