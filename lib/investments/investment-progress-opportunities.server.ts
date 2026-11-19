import {z} from 'zod';
import {prisma} from '../db';
import {readInvestmentResearch} from '../research/research.server';
import {readEuroReference} from './ecb-euro-reference';
import {boundedBytes} from '../commerce/providers.server';

const eurostat='https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hpi_q?lang=en&geo=BG&purchase=TOTAL&unit=RCH_A&lastTimePeriod=5';
const housingUrl='https://ec.europa.eu/eurostat/databrowser/view/prc_hpi_q/default/table?lang=en';
export type MarketBrief={category:'housing'|'euro_cash';title:string;metric:string;value:string;period:string;source:string;url:string;
  evidence_url:string;as_of:string;assessment:string;risk:string};
export type InvestmentIdea={id:string;label:string;instrument:string;category:'STOCK'|'ETF'|'strategy';rank:number|null;leader:boolean;
  source:string;source_url:string;observed_at:string;start:string;end:string;samples:number;median_bps:number;drawdown_bps:number;
  worst_bps:number;holdout_bps:number;assessment:string;risk:string;qualifications:string[]};
export type OpportunitiesReport={currency:string|null;days:number;as_of:string;ranked:boolean;strategies:InvestmentIdea[];
  briefs:MarketBrief[];unavailable_sources:string[]};
const format=(value:number)=>new Intl.NumberFormat('bg-BG',{maximumFractionDigits:4}).format(value)+'%';
const index=z.object({category:z.object({index:z.record(z.string(),z.number().int().nonnegative())})});
const eurostatSeries=z.object({source:z.literal('ESTAT'),updated:z.string().datetime({offset:true}),id:z.array(z.string()),
  size:z.array(z.number().int()),dimension:z.object({freq:index,purchase:index,unit:index,geo:index,time:index}),
  value:z.record(z.string(),z.number().finite()),status:z.record(z.string(),z.string()).optional()});
export function housingBrief(raw:unknown,now=new Date()):MarketBrief|null{
  const checked=eurostatSeries.safeParse(raw);
  if(!checked.success)return null;
  const d=checked.data,t=now.valueOf();
  if(d.id.join(',')!=='freq,purchase,unit,geo,time'||d.size.join(',')!=='1,1,1,1,5'||
    !([[d.dimension.freq,'Q'],[d.dimension.purchase,'TOTAL'],[d.dimension.unit,'RCH_A'],[d.dimension.geo,'BG']] as const)
      .every(([dimension,key])=>Object.keys(dimension.category.index).length===1&&dimension.category.index[key]===0))return null;
  const updated=Date.parse(d.updated);
  if(updated>t||t-updated>185*86400000)return null;
  const series=Object.entries(d.dimension.time.category.index).sort((a,b)=>a[1]-b[1]);
  if(series.length!==5||series.some(([date,i],index)=>!/^\d{4}-Q[1-4]$/.test(date)||i!==index||!Number.isFinite(d.value[String(i)])))return null;
  const quarters=series.map(([date,i])=>{
    const year=Number(date.slice(0,4)),q=Number(date.slice(-1));
    return {date,sequence:year*4+q-1,end:Date.UTC(year,3*q,1),value:d.value[String(i)],flag:d.status?.[String(i)]};
  });
  const latest=quarters[4],previous=quarters[3];
  if(quarters.some((v,i)=>i>0&&v.sequence!==quarters[i-1].sequence+1)||latest.end>updated||t-latest.end>190*86400000||
    quarters.some(v=>v.flag&&!['p','e','ep','pe'].includes(v.flag)))return null;
  const qualification=latest.flag?' Евростат отбелязва последната стойност като предварителна или оценена.':'';
  return {category:'housing',title:'Жилищни имоти в България',metric:'Годишна промяна на цените',value:format(latest.value),period:latest.date,
    source:'Евростат · индекс на цените на жилищата',url:housingUrl,evidence_url:eurostat,as_of:d.updated,
    assessment:'Годишната промяна през предходното тримесечие е '+format(previous.value)+'. За конкретен имот сравни покупната цена, наема и разходите по придобиване.'+qualification,
    risk:'Националният индекс обобщава сключени сделки. Доходът от наем, ликвидността и разходите за конкретния имот изискват местни данни.'};
}
export async function readHousing(now:Date){
  try{
    const response=await fetch(eurostat,{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(5500),next:{revalidate:21600}});
    if(!response.ok)return null;
    return housingBrief(JSON.parse((await boundedBytes(response,131072)).toString('utf8')),now);
  }catch{return null;}
}
async function categories(user:string){
  try{
    return await prisma.$queryRaw<{id:string;kind:'STOCK'|'ETF'}[]>`
      SELECT encode(sha256(convert_to(f.id,'UTF8')),'hex') id,i.kind
      FROM sharkai_forecast.binding f JOIN sharkai_broker.account a ON a.user_id=f.user_id AND a.provider_key=f.account_key AND lower(a.provider)=f.provider AND a.currency=f.currency
      JOIN sharkai_broker.profit_protection_policy p ON p.account_id=a.id AND p.user_id=a.user_id AND p.revoked_at IS NULL AND p.approved_at<=now() AND p.expires_at>now()
      JOIN sharkai_broker.profit_protected_instrument i ON i.policy_id=p.id AND i.asset_id=f.instrument_code AND i.currency=f.currency
      JOIN sharkai_broker.asset a2 ON a2.account_id=a.id AND a2.id=i.asset_id AND a2.broker_instrument_id=i.provider_instrument_id
      WHERE f.user_id=${user} AND f.revoked_at IS NULL AND f.expires_at>now() AND a.revoked_at IS NULL LIMIT 100`;
  }catch{return [];}
}
const opportunitySources={research:readInvestmentResearch,housing:readHousing,cash:readEuroReference,categories};
export async function readOpportunities(user:string,currency:string|undefined,days:number,now=new Date(),read=opportunitySources):Promise<OpportunitiesReport>{
  const period=({1:'day',7:'week_1',14:'week_2',21:'week_3',28:'week_4'} as const)[days as 1|7|14|21|28];
  const [research,housing,cash,kinds]=await Promise.all([read.research(user,{currency,horizonDays:days},undefined,now),read.housing(now),
    period?read.cash(period):Promise.resolve(null),read.categories(user)]);
  const privateData='/api/research/investments?'+new URLSearchParams({horizonDays:String(days),...(research.currency?{currency:research.currency}:{})});
  const strategies=research.candidates.flatMap((c):InvestmentIdea[]=>{
    const m=c.metrics;
    if(c.status!=='eligible'||typeof m.median_net_bps!=='number'||typeof m.max_drawdown_bps!=='number'||typeof m.worst_period_bps!=='number'||
      typeof m.holdout_median_net_bps!=='number'||typeof m.instrument_code!=='string'||typeof m.source_observed_at!=='string'||
      typeof m.window_start!=='string'||typeof m.window_end!=='string'||typeof m.sample_count!=='number'||
      !['ibkr_portfolio_analyst_net_strategy','saxo_account_history_net_strategy'].includes(String(m.source)))return [];
    const kind=kinds.find(k=>k.id===c.id),leader=c.id===research.leader_id;
    const positive=m.holdout_median_net_bps>0,decline=m.median_net_bps>0&&!positive;
    return [{id:c.id,label:c.label,instrument:m.instrument_code,category:kind?.kind??'strategy',rank:c.rank,leader,
      source:m.source==='ibkr_portfolio_analyst_net_strategy'?'Interactive Brokers · PortfolioAnalyst':'Saxo · история на сметката',
      source_url:privateData,observed_at:m.source_observed_at,start:m.window_start,end:m.window_end,samples:m.sample_count,median_bps:m.median_net_bps,
      drawdown_bps:m.max_drawdown_bps,worst_bps:m.worst_period_bps,holdout_bps:m.holdout_median_net_bps,
      assessment:leader?'Кандидат за допълнителен анализ. Запазва преднината във всяка от четирите проверочни групи при съпоставим спад.':
        decline?'Положителната обща медиана не се повтаря в проверочния период. Изследвай кои периоди обясняват промяната.':
        positive?'Медианата през отделния проверочен период е положителна. Сравни максималния спад и най-слабия период с другите кандидати.':
        'В отделния проверочен период медианата е нулева или отрицателна. Прегледай размера и продължителността на спадовете.',
      risk:'Показателите включват отчетените брокерски разходи преди евентуалната такса на Shark AI. Бъдещият спад може да надхвърли наблюдавания.',
      qualifications:c.reasons}];
  });
  const briefs:MarketBrief[]=[],unavailable_sources:string[]=[];
  if(housing)briefs.push(housing);else unavailable_sources.push('Евростат · жилищни имоти');
  if(cash?.status==='available'){
    const percent=(s:string)=>format(Number(s)/1000000);
    briefs.push({category:'euro_cash',title:'Краткосрочни средства в евро',metric:'Медианна промяна на индекса €STR',value:percent(cash.median_pct_micros),
      period:String(days)+' дни',source:'Европейска централна банка',url:cash.source_url,evidence_url:'/api/market/euro-reference?period='+period,as_of:cash.as_of,
      assessment:'За '+cash.samples+' наблюдавани интервала от '+cash.from+' крайностите са '+percent(cash.lower_pct_micros)+' и '+percent(cash.upper_pct_micros)+'. Сравни конкретна оферта за евро с този ориентир при същия срок.',
      risk:'Индексът отразява междубанковия пазар. Условията по депозит, данъците и разходите се определят отделно.'});
  }else if(period)unavailable_sources.push('ЕЦБ · €STR');
  return {currency:research.currency,days,as_of:now.toISOString(),ranked:research.status==='ranked',strategies,briefs,unavailable_sources};
}
