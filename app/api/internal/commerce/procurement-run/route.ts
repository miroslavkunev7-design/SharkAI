import {createHash,timingSafeEqual} from 'node:crypto';
import {runApprovedProcurement} from '@/lib/commerce/procurement.server';
export const runtime='nodejs';
export const maxDuration=60;
export async function POST(req:Request){
 const key=process.env.SHARKAI_COMMERCE_PROCUREMENT_CRON_SECRET;
 const hash=(v:string)=>createHash('sha256').update(v).digest();
 if(!key||key.length<32||!timingSafeEqual(hash(req.headers.get('authorization')??''),hash('Bearer '+key)))return Response.json({status:'forbidden'},{status:403});
 try{return Response.json(await runApprovedProcurement(),{headers:{'cache-control':'no-store'}});}catch{return Response.json({status:'unavailable'},{status:503});}
}
