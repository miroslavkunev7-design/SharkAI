import {prisma} from '../db';
import {readCommerceDashboard} from './commerce.server';
import {commerceRange} from './owner-input';
import {readResaleSettlement} from './resale-settlement.server';

export async function commerceAgentOverview(userId:string) {
  const current=await prisma.$queryRaw<{currency:string|null}[]>`SELECT sharkai_commerce.current_store(${userId},NULL::text)->>'currency' AS currency`;
  const currency=current[0]?.currency;
  const range=currency?commerceRange(new URLSearchParams({currency})):null;
  if(!range) return {status:'unavailable',source:'shark-ai-commerce',reason:'verified_store_required'};
  const [dashboard,settlement,inventory]=await Promise.all([readCommerceDashboard(userId,range),readResaleSettlement(userId,range.currency),
    prisma.$queryRaw<{stock:{status:string;items:{state:string;received_units:number;sold_units:number|null}[]}}[]>
      `SELECT sharkai_commerce.stock_dashboard(${userId}) stock`]);
  const stock=inventory[0]?.stock;
  const totals={orders:0,units:0,revenue:BigInt(0),refunds:BigInt(0),costs:BigInt(0)};
  for(const day of dashboard.daily) {
    totals.orders+=day.orders;totals.units+=day.units;
    totals.revenue+=BigInt(day.revenue_minor);totals.refunds+=BigInt(day.refunds_minor);
    for(const cost of [day.goods_minor,day.fulfillment_minor,day.advertising_minor,day.fees_minor,day.other_costs_minor]) totals.costs+=BigInt(cost);
  }
  return {status:dashboard.status,source:'shark-ai-commerce',currency,from:range.from,to:range.to,
    observed_at:dashboard.source_observed_at,period_complete:dashboard.period_complete,verified_days:dashboard.daily.length,
    reported:dashboard.daily.length?{orders:totals.orders,units:totals.units,revenue_minor:String(totals.revenue),
      refunds_minor:String(totals.refunds),cost_minor:String(totals.costs),net_margin_minor:String(totals.revenue-totals.refunds-totals.costs)}:null,
    weekly:{period:settlement.period,last_closed:settlement.closed[0]??null,
      owner_reserved_minor:settlement.owner_reserved_minor,owner_paid_minor:settlement.owner_paid_minor},
    recent_procurement:stock?.status==='available'?{offers_shown:stock.items.length,limit:100,
      issued:stock.items.filter(row=>row.state==='issued').length,received_units:stock.items.reduce((total,row)=>total+row.received_units,0),
      confirmed_sold_units:stock.items.some(row=>row.sold_units!==null)?stock.items.reduce((total,row)=>total+(row.sold_units??0),0):null}:null,
    capital:{available_minor:dashboard.capital.available_minor,held_minor:dashboard.capital.held_minor,observed_at:dashboard.capital.observed_at}};
}
