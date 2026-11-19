const DAY=86_400_000;
const ZERO=BigInt(0);
export type ResearchDomain='investments'|'dropshipping';
export type ResearchCandidate={
  id:string; label:string; rank:number|null; status:'eligible'|'insufficient_data'|'validation_candidate';
  metrics:Record<string,number|string|null>; reasons:string[];
};
export type ResearchReport={
  domain:ResearchDomain; status:'ranked'|'insufficient_data'|'unavailable'; as_of:string; currency:string|null;
  criteria:string[]; candidates:ResearchCandidate[]; leader_id:string|null;
};
export const investmentCriteria=[
  'Сравнението използва една валута и еднакви календарни периоди. Нужни са 60 неприпокриващи се периода с реална оценка.',
  'Медианната доходност е след отчетените брокерски разходи и преди личната такса за резултат. Максималният спад се измерва от предходен връх по дневни оценки.',
  'Първите 40 периода определят реда по медианна доходност. Последните 20 служат за отделна проверка. Лидер се показва само при предварително фиксиран състав, своевременно записани данни и преднина във всяка от четирите проверочни групи при съпоставим спад.',
  'Резултатите са исторически. Дори неприпокриващи се периоди могат да бъдат зависими. Справката не подава поръчки.',
];
export const productCriteria=[
  'Сравняват се последните два пълни периода от по 28 дни в една валута. Включват се и потвърдените дни без продажби.',
  'Приносът приспада възстановяванията, себестойността, доставките и връщанията, рекламата, таксите и другите отчетени разходи. Маржът е дял от приходите след възстановяванията.',
  'Редът използва по-ниския марж от двата периода. За лидер се изискват поне 30 поръчки, поне 10 във всеки период, положителен принос и превес по марж и в двата периода, актуална наличност и отделно потвърдени складови и финансови данни.',
  'Сумирането на най-големия клиентски приход за всеки ден дава горна граница на концентрацията. Над 50% или при спад в броя поръчки кандидатът не получава потвърждение за лидер.',
];
export function emptyResearch(domain:ResearchDomain,currency:string|null,now:Date,status:ResearchReport['status']='insufficient_data'):ResearchReport {
  return {domain,status,as_of:now.toISOString(),currency,criteria:[...(domain==='investments'?investmentCriteria:productCriteria)],candidates:[],leader_id:null};
}
export type Close={date:string; units:string; kind:'valued'|'confirmed_market_closed'; forward:boolean};
export type Strategy={id:string;label:string;instrument_code:string;source:string|null;observed_at:string|null;closes:Close[]};
export type InvestmentEvidence={currency:string|null;cohort_complete:boolean;candidates:Strategy[]};
export type CommerceDay={date:string;orders:number;units:number;customer_count:number;revenue_minor:string;refunds_minor:string;goods_minor:string;
  fulfillment_minor:string;advertising_minor:string;fees_minor:string;other_costs_minor:string;largest_customer_revenue_minor:string};
export type Product={product_id:string;name:string;inventory_units:number;inventory_observed_at:string;days:CommerceDay[]};
export type ProductEvidence={status:'verified'|'unverified';currency:string|null;observed_at:string|null;catalog_complete:boolean;independent_sources_verified:boolean;products:Product[]};

const dayOf=(date:string)=>Date.parse(date+'T00:00:00.000Z')/DAY;
const today=(now:Date)=>Math.floor(now.valueOf()/DAY);
function fresh(timestamp:string|null,now:Date,maximum:number) {
  const age=timestamp?now.valueOf()-Date.parse(timestamp):NaN;
  return Number.isFinite(age) && age>=0 && age<=maximum;
}
function bps(n:bigint,d:bigint) {
  if (d<=ZERO) return null;
  // The reporting resolution is one basis point. Negative fractions round down too.
  const scaled=n*BigInt(10000);
  const value=Number(scaled/d-(scaled<ZERO && scaled%d!==ZERO?BigInt(1):ZERO));
  return Number.isSafeInteger(value)?value:null;
}
function upperBps(n:bigint,d:bigint) {
  const lower=bps(-n,d);
  return lower===null?null:-lower || 0;
}
function quantile(values:number[],fraction:number) {
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.ceil(fraction*sorted.length)-1];
}
type Ranked={row:ResearchCandidate;score:number|null;train?:number[];test?:number[];dates?:string[];forward?:boolean;drawdown?:number;firstMargin?:number;lastMargin?:number;canLead?:boolean};
function sortCandidates(items:Ranked[]) {
  items.sort((a,b)=>(b.score??-Infinity)-(a.score??-Infinity)||a.row.id.localeCompare(b.row.id));
  let rank=0;
  for(let i=0;i<items.length;i++) {
    if(items[i].score===null) continue;
    if(i===0 || items[i].score!==items[i-1].score) rank=i+1;
    items[i].row.rank=rank;
  }
}
function strategyResult(s:Strategy,horizon:number,now:Date):Ranked {
  const metrics:ResearchCandidate['metrics']={instrument_code:s.instrument_code,source:s.source,source_observed_at:s.observed_at,horizon_days:horizon,sample_count:0};
  const row:ResearchCandidate={id:s.id,label:s.label,rank:null,status:'insufficient_data',metrics,reasons:[]};
  const reject=(reason:string):Ranked=>{row.reasons.push(reason);return {row,score:null};};
  const closes=s.closes;
  const last=closes.length-1;
  if(!fresh(s.observed_at,now,DAY*1.5)||last<1||dayOf(closes[last].date)!==today(now)-1) return reject('Липсва пълен и актуален отчет до последния завършен UTC ден.');
  const values=closes.map(c=>BigInt(c.units));
  for(let k=1;k<closes.length;k++) {
    if(dayOf(closes[k].date)!==dayOf(closes[k-1].date)+1 || (closes[k].kind==='confirmed_market_closed'&&values[k]!==values[k-1])
      || values[k-1]===ZERO) return reject('Дневната серия има празнина или несъвместима оценка.');
  }
  const periods:{start:number;end:number;ret:number}[]=[];
  for(let end=last;end>=horizon&&periods.length<60;end-=horizon) {
    const start=end-horizon;
    if(!closes.slice(start+1,end+1).some(c=>c.kind==='valued')) continue;
    const ret=bps(values[end]-values[start],values[start]);
    if(ret===null) return reject('Доходността не може да се изчисли надеждно за този период.');
    periods.push({start,end,ret});
  }
  metrics.sample_count=periods.length;
  if(periods.length<60) return reject('Налични са по-малко от 60 неприпокриващи се периода с реални оценки.');
  periods.reverse();
  const window=periods[0].start;
  let peak=values[window],drawdown=0;
  for(const value of values.slice(window)) {
    if(value>peak) peak=value;
    drawdown=Math.max(drawdown,upperBps(peak-value,peak)??10000);
  }
  const returns=periods.map(p=>p.ret),train=returns.slice(0,40),test=returns.slice(40),score=quantile(train,0.5);
  const forward=closes.slice(window).every(c=>c.forward);
  Object.assign(metrics,{window_start:closes[window].date,window_end:closes[last].date,holdout_start:closes[periods[40].start].date,holdout_samples:20,
    median_net_bps:quantile(returns,0.5),training_median_net_bps:score,holdout_median_net_bps:quantile(test,0.5),
    holdout_lower_quartile_bps:quantile(test,0.25),max_drawdown_bps:drawdown,worst_period_bps:Math.min(...returns),
    positive_periods_bps:Math.floor(returns.filter(v=>v>0).length*10000/returns.length),prospective_days:closes.slice(window).filter(c=>c.forward).length});
  row.status='eligible';
  if(!forward) row.reasons.push('Част от историята е ретроспективна. Липсва независимо записан навреме дневен отчет за целия проверочен прозорец.');
  return {row,score,train,test,dates:periods.map(p=>closes[p.end].date),forward,drawdown};
}

export function rankInvestments(evidence:InvestmentEvidence,horizon:number,now:Date):ResearchReport {
  const report=emptyResearch('investments',evidence.currency,now);
  if(!Number.isInteger(horizon)||horizon<1||horizon>366) return report;
  const items=evidence.candidates.map(s=>strategyResult(s,horizon,now));
  sortCandidates(items); report.candidates=items.map(x=>x.row);
  const [first,runner]=items;
  if(!first?.test||!runner?.test) return report;
  report.status='ranked';
  const allCompared=items.every(s=>s.test&&s.forward&&s.dates?.join()===first.dates?.join());
  if(!evidence.cohort_complete||!allCompared) {
    report.criteria.push('Сравнението е описателно. Пълният предварително определен списък и еднаквите своевременно наблюдавани периоди още не са потвърдени.');
    return report;
  }
  if(first.score===runner.score || first.score===null || first.score<=0 || quantile(first.test,0.25)<=0) {
    report.criteria.push('Липсва еднозначно положителен първи резултат или долният квартил в проверочния период е неположителен.');
    return report;
  }
  const ahead=items.slice(1).every(peer=>{
    if(first.drawdown!>peer.drawdown!) return false;
    for(let i=0;i<20;i+=5) {
      const margins=first.test!.slice(i,i+5).map((v,offset)=>v-peer.test![i+offset]);
      if(quantile(margins,0.5)<=0) return false;
    }
    return true;
  });
  if(ahead) report.leader_id=first.row.id;
  else report.criteria.push('Първоначалният лидер не превъзхожда всички останали в четирите проверочни групи при равен или по-малък спад.');
  return report;
}

function commerceTotals(days:CommerceDay[]) {
  let orders=0,gross=ZERO,refunds=ZERO,costs=ZERO,largest=ZERO;
  for(const d of days) {
    orders+=d.orders;
    gross+=BigInt(d.revenue_minor);refunds+=BigInt(d.refunds_minor);largest+=BigInt(d.largest_customer_revenue_minor);
    costs+=BigInt(d.goods_minor)+BigInt(d.fulfillment_minor)+BigInt(d.advertising_minor)+BigInt(d.fees_minor)+BigInt(d.other_costs_minor);
  }
  const receipts=gross-refunds,contribution=receipts-costs;
  return {orders,gross,refunds,largest,contribution,margin:bps(contribution,receipts)};
}
function productResult(p:Product,now:Date):Ranked {
  const metrics:ResearchCandidate['metrics']={inventory_units:p.inventory_units,source_observed_at:p.inventory_observed_at};
  const row:ResearchCandidate={id:p.product_id,label:p.name,rank:null,status:'insufficient_data',metrics,reasons:[]};
  const wait=(reason:string):Ranked=>{row.reasons.push(reason);return {row,score:null};};
  if(p.inventory_units<1 || !fresh(p.inventory_observed_at,now,DAY)) return wait('Липсва скорошно потвърждение за наличност.');
  row.status='validation_candidate';
  const days=p.days.slice(-56);
  if(days.length<56 || days.some((d,k)=>dayOf(d.date)!==today(now)-56+k)) return wait('Наличността е потвърдена. За проверка на търсенето и маржа са нужни два пълни периода от по 28 дни.');
  for(const d of days) {
    const gross=BigInt(d.revenue_minor),largest=BigInt(d.largest_customer_revenue_minor);
    if(d.customer_count>d.orders || d.units<d.orders || largest>gross || (d.orders===0&&(gross!==ZERO||d.customer_count!==0||d.units!==0))
       || (gross>ZERO && (d.customer_count===0||largest===ZERO||largest*BigInt(d.customer_count)<gross))) {
      row.status='insufficient_data';return wait('Има противоречие между броя клиенти, поръчките и приходите.');
    }
  }
  const a=commerceTotals(days.slice(0,28)),b=commerceTotals(days.slice(28)),sum=commerceTotals(days);
  const concentration=upperBps(sum.largest,sum.gross),growth=a.orders?bps(BigInt(b.orders-a.orders),BigInt(a.orders)):null;
  Object.assign(metrics,{window_start:days[0].date,window_end:days[55].date,orders:sum.orders,previous_orders:a.orders,recent_orders:b.orders,
    net_contribution_minor:sum.contribution.toString(),margin_bps:sum.margin,previous_margin_bps:a.margin,recent_margin_bps:b.margin,
    orders_growth_bps:growth,refund_rate_bps:bps(sum.refunds,sum.gross),customer_concentration_upper_bps:concentration});
  if(sum.orders<30||a.orders<10||b.orders<10) return wait('Извадката е малка: необходими са минимум 30 поръчки и поне 10 във всеки период.');
  if(a.margin===null||b.margin===null||sum.margin===null) return wait('Нетните приходи са недостатъчни за сравним марж.');
  const canLead=a.contribution>ZERO&&b.contribution>ZERO&&growth!==null&&growth>=0&&concentration!==null&&concentration<=5000;
  row.status='eligible';
  if(a.contribution<=ZERO||b.contribution<=ZERO) row.reasons.push('Поне един период е с нулев или отрицателен принос след всички отчетени разходи.');
  if(growth!==null&&growth<0) row.reasons.push('През последния период броят поръчки намалява.');
  if(concentration===null||concentration>5000) row.reasons.push('Не е потвърдена достатъчно широка клиентска база.');
  return {row,score:Math.min(a.margin,b.margin),firstMargin:a.margin,lastMargin:b.margin,canLead};
}
export function rankProducts(evidence:ProductEvidence,now:Date):ResearchReport {
  const report=emptyResearch('dropshipping',evidence.currency,now);
  if(evidence.status!=='verified'||!fresh(evidence.observed_at,now,DAY)) return report;
  const items=evidence.products.map(p=>productResult(p,now));sortCandidates(items);
  report.candidates=items.map(s=>s.row);
  const [first,runner]=items;
  if(first?.score==null||runner?.score==null) return report;
  report.status='ranked';
  if(evidence.catalog_complete&&evidence.independent_sources_verified&&first.canLead&&items.every(s=>s.firstMargin!==undefined)
    &&items.slice(1).every(s=>first.firstMargin!>s.firstMargin!&&first.lastMargin!>s.lastMargin!)) report.leader_id=first.row.id;
  else report.criteria.push('Няма потвърден лидер за целия каталог. Вижте обхвата на данните, сравнимостта на двата периода и причините при продуктите.');
  return report;
}
