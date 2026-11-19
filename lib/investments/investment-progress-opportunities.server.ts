import {prisma} from '../db';
import {readInvestmentResearch} from '../research/research.server';
import {readEuroReference} from './ecb-euro-reference';
import {readHousing,readPublicOpportunities,type MarketBrief} from './market-opportunities.public';
export {housingBrief,readHousing} from './market-opportunities.public';
export type {MarketBrief} from './market-opportunities.public';

export type InvestmentIdea={id:string;label:string;instrument:string;category:'STOCK'|'ETF'|'strategy';rank:number|null;leader:boolean;
  source:string;source_url:string;observed_at:string;start:string;end:string;samples:number;median_bps:number;drawdown_bps:number;
  worst_bps:number;holdout_bps:number;assessment:string;risk:string;qualifications:string[]};
export type OpportunitiesReport={currency:string|null;days:number;as_of:string;ranked:boolean;strategies:InvestmentIdea[];
  briefs:MarketBrief[];unavailable_sources:string[]};
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
  const [research,market,kinds]=await Promise.all([read.research(user,{currency,horizonDays:days},undefined,now),
    readPublicOpportunities(days,now,read),read.categories(user)]);
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
  return {currency:research.currency,days,as_of:market.as_of,ranked:research.status==='ranked',strategies,briefs:market.briefs,unavailable_sources:market.unavailable_sources};
}
