import {z} from 'zod';
import {prisma} from '../db';
import {emptyResearch,rankInvestments,rankProducts} from './ranking';
import type {ResearchReport} from './ranking';
export type {ResearchCandidate,ResearchDomain,ResearchReport} from './ranking';

const safeLabel=z.string().min(1).max(200).refine(v=>v.trim()===v&&!/[\u0000-\u001f\u007f]/.test(v));
const safeId=z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const currency=z.string().regex(/^[A-Z]{3}$/);
const money=z.string().regex(/^(0|[1-9]\d{0,24})$/);
const instant=z.string().datetime({offset:true});
const count=z.number().int().min(0).max(2_147_483_647);
const unique=(ids:string[])=>new Set(ids).size===ids.length;
const investment=z.object({
  currency:currency.nullable(),cohort_complete:z.boolean(),
  candidates:z.array(z.object({id:safeId,label:safeLabel,instrument_code:safeLabel,
    source:z.enum(['ibkr_portfolio_analyst_net_strategy','saxo_account_history_net_strategy']).nullable(),observed_at:instant.nullable(),
    closes:z.array(z.object({date:z.string().date(),units:money,kind:z.enum(['valued','confirmed_market_closed']),forward:z.boolean()}).strict()).max(32941),
  }).strict()).max(32),
}).strict().refine(x=>unique(x.candidates.map(s=>s.id)));
const commerce=z.object({status:z.enum(['verified','unverified']),currency:currency.nullable(),observed_at:instant.nullable(),
  catalog_complete:z.boolean(),independent_sources_verified:z.boolean(),products:z.array(z.object({
    product_id:safeId,name:safeLabel,inventory_units:count,inventory_observed_at:instant,days:z.array(z.object({
      date:z.string().date(),orders:count,units:count,customer_count:count,revenue_minor:money,refunds_minor:money,goods_minor:money,
      fulfillment_minor:money,advertising_minor:money,fees_minor:money,other_costs_minor:money,largest_customer_revenue_minor:money,
    }).strict()).max(366).refine(days=>days.every((v,i)=>!i||days[i-1].date<v.date)),
  }).strict()).max(200),
}).strict().refine(x=>unique(x.products.map(p=>p.product_id)));
type Reader=(owner:string,currency:string|null,days:number)=>Promise<unknown>;
const investmentRead:Reader=async(owner,code,days)=>{
  const rows=await prisma.$queryRaw<{data:unknown}[]>`SELECT sharkai_research.investment_candidates(${owner},${code}::text,${days}::integer) AS data`;
  return rows[0]?.data;
};
const productRead:Reader=async(owner)=>{
  const rows=await prisma.$queryRaw<{data:unknown}[]>`SELECT sharkai_commerce.product_candidates(${owner}) AS data`;
  return rows[0]?.data;
};
export async function readInvestmentResearch(owner:string,options:{currency?:string;horizonDays?:number}={},read:Reader=investmentRead,now=new Date()):Promise<ResearchReport> {
  const code=options.currency??null,horizon=options.horizonDays??7;
  const empty=emptyResearch('investments',code,now,'unavailable');
  if(!safeId.safeParse(owner).success||(code!==null&&!currency.safeParse(code).success)||!Number.isInteger(horizon)||horizon<1||horizon>366) return empty;
  try {
    const evidence=investment.safeParse(await read(owner,code,horizon));
    if(!evidence.success||(code!==null&&evidence.data.currency!==null&&evidence.data.currency!==code)) return empty;
    if(evidence.data.currency===null && evidence.data.candidates.length) return empty;
    return rankInvestments(evidence.data,horizon,now);
  } catch {return empty;}
}
export async function readProductResearch(owner:string,options:{currency?:string}={},read:Reader=productRead,now=new Date()):Promise<ResearchReport> {
  const code=options.currency??null;
  const empty=emptyResearch('dropshipping',code,now,'unavailable');
  if(!safeId.safeParse(owner).success||(code!==null&&!currency.safeParse(code).success)) return empty;
  try {
    const evidence=commerce.safeParse(await read(owner,code,0));
    if(!evidence.success||(evidence.data.status==='verified'&&evidence.data.currency===null)) return empty;
    if(code!==null&&evidence.data.currency!==code) return emptyResearch('dropshipping',code,now);
    return rankProducts(evidence.data,now);
  } catch {return empty;}
}
