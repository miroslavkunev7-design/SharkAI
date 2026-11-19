import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readInvestmentResearch} from '../../lib/research/research.server';

type Query=(sql:string,values?:unknown[])=>Promise<{rows:Record<string,any>[]}>;
export async function checkResearchCohort(q:Query) {
  await q(await readFile(new URL('../../n8n/sql/research-investment-cohorts.sql',import.meta.url),'utf8'));
  const user='research-fixture-owner';
  for(const id of ['low','high']) await q(`INSERT INTO sharkai_forecast.binding VALUES($1,'collector',$2,'ibkr',$1,'USD','TEST',$1,
    now()-interval '2 years',now()-interval '2 years',now()-interval '2 years',current_date-800,now()+interval '1 month',NULL)`,[id,user]);
  const versions=JSON.stringify({low:'a'.repeat(64),high:'b'.repeat(64)});
  const register=async(mapping:string)=>(await q('SELECT sharkai_research.register_investment_cohort($1,$2,$3::jsonb) AS ok',[user,'USD',mapping])).rows[0].ok;
  assert.equal(await register('{}'),false);
  assert.equal(await register(versions),true);
  assert.equal(await register(versions),false);
  // Set the clock of the isolated fixture only. Production registration always takes DB wall time.
  await q("UPDATE sharkai_research.investment_cohort SET registered_at=now()-interval '4 months' WHERE user_id=$1",[user]);
  const now=new Date(),start=new Date(now);start.setUTCHours(0,0,0,0);start.setUTCDate(start.getUTCDate()-91);
  for(const id of ['low','high']) {
    let nav=1_000_000_000;
    const closes:{date:string;units:string;kind:string}[]=[];
    for(let i=0;i<91;i++) {
      const day=new Date(+start+i*86_400_000),date=day.toISOString().slice(0,10);
      const closed=[0,6].includes(day.getUTCDay());
      if(!closed) nav=Math.round(nav*(id==='high'?1.015:1.004));
      closes.push({date,units:String(nav),kind:closed?'confirmed_market_closed':'valued'});
      const observed=new Date(+day+86_400_000).toISOString();
      const payload={source:'ibkr_portfolio_analyst_net_strategy',basis:'cash_flow_adjusted_after_fees',coverage:'complete_daily_calendar',
        valuation_basis:'unitized_strategy_nav',fee_coverage:{execution:'included',ongoing:'included',financing:'not_applicable',currencyConversion:'included'},
        strategy_version_sha256:(id==='high'?'b':'a').repeat(64),applicable_capital_minor:{min:'1',max:'100000'},closes};
      await q(`INSERT INTO sharkai_forecast.snapshot VALUES($1,$2,'history',$3,$3,repeat('a',64),'fixture',repeat('b',64),$4::jsonb)`,
        [id,'fixture-'+i,observed,JSON.stringify(payload)]);
    }
  }
  const read=async(owner:string,currency:string|null,horizon:number)=>(await q(
    'SELECT sharkai_research.investment_candidates($1,$2,$3) AS data',[owner,currency,horizon])).rows[0].data;
  const result=await readInvestmentResearch(user,{horizonDays:1,currency:'USD'},read,now);
  assert.equal(result.status,'ranked');assert.equal(result.candidates.length,2);
  assert.equal(result.candidates.find(s=>s.id===result.leader_id)?.label,'high');
  assert.equal((await readInvestmentResearch('other-owner',{horizonDays:1,currency:'USD'},read,now)).candidates.length,0);
  // Later restatement conflicts with the prospectively archived mark.
  await q(`UPDATE sharkai_forecast.snapshot SET payload=jsonb_set(payload,'{closes,17,units}','"12345"')
    WHERE binding_id='high' AND snapshot_id='fixture-90'`);
  assert.equal((await readInvestmentResearch(user,{horizonDays:1},read,now)).leader_id,null);
  await q("UPDATE sharkai_forecast.binding SET revoked_at=now() WHERE id='low'");
  assert.equal((await read(user,'USD',1)).cohort_complete,false);
  assert.equal((await q("SELECT has_schema_privilege('broker_untrusted','sharkai_research','USAGE') AS ok")).rows[0].ok,false);
  console.log('PostgreSQL research cohort passed: fixed roster, daily first-seen evidence, verified comparisons, restatement rejection, revocation and owner isolation.');
}
