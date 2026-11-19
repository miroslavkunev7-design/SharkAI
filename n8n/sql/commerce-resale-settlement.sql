-- Apply after commerce-dropshipping.sql. All amounts are in the store's single currency.
BEGIN;

CREATE TABLE sharkai_commerce.resale_target (
  store_id uuid NOT NULL REFERENCES sharkai_commerce.store(id),
  week_start date NOT NULL CHECK (extract(isodow FROM week_start)=1),
  target_minor bigint NOT NULL CHECK(target_minor BETWEEN 0 AND 999999999999),
  PRIMARY KEY(store_id,week_start)
);
CREATE TABLE sharkai_commerce.resale_week (
  store_id uuid NOT NULL REFERENCES sharkai_commerce.store(id),
  week_start date NOT NULL CHECK(extract(isodow FROM week_start)=1),
  report_ref text NOT NULL, digest text NOT NULL, evidence_hash text NOT NULL,
  observed_at timestamptz NOT NULL, net bigint NOT NULL, cumulative bigint NOT NULL,
  high_water bigint NOT NULL CHECK(high_water>=0),
  allocable bigint NOT NULL CHECK(allocable>=0), target bigint,
  reinvested bigint CHECK(reinvested BETWEEN 0 AND allocable), allocated_at timestamptz,
  CHECK ((reinvested IS NULL)=(allocated_at IS NULL)),
  PRIMARY KEY(store_id,week_start), UNIQUE(store_id,report_ref), UNIQUE(store_id,evidence_hash)
);
CREATE TABLE sharkai_commerce.resale_cost_recovery (
  store_id uuid NOT NULL, week_start date NOT NULL, kind text NOT NULL, purchase_ref text NOT NULL,
  amount bigint NOT NULL CHECK(amount>0), PRIMARY KEY(store_id,kind,purchase_ref,week_start),
  FOREIGN KEY(store_id,week_start) REFERENCES sharkai_commerce.resale_week(store_id,week_start)
);
CREATE TABLE sharkai_commerce.resale_payout_destination (
  store_id uuid PRIMARY KEY REFERENCES sharkai_commerce.store(id),
  beneficiary_digest text NOT NULL CHECK(beneficiary_digest ~ '^[a-f0-9]{64}$'),
  provider text NOT NULL CHECK(provider='wise-business'),
  contract_digest text NOT NULL CHECK(contract_digest ~ '^[a-f0-9]{64}$')
);
CREATE TABLE sharkai_commerce.resale_payout (
  store_id uuid NOT NULL REFERENCES sharkai_commerce.store(id),report_ref text NOT NULL,digest text NOT NULL,
  evidence_hash text NOT NULL,amount bigint NOT NULL CHECK(amount>0),observed_at timestamptz NOT NULL,
  debit_ref text NOT NULL UNIQUE,credit_ref text NOT NULL UNIQUE,PRIMARY KEY(store_id,report_ref),
  UNIQUE(store_id,evidence_hash)
);
ALTER TABLE sharkai_commerce.resale_target ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_commerce.resale_week ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_commerce.resale_cost_recovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_commerce.resale_payout_destination ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_commerce.resale_payout ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION sharkai_commerce.set_resale_target(p_user text,p_currency text,p_target bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE s uuid; monday date:=date_trunc('week',clock_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
 IF p_target IS NULL OR p_target NOT BETWEEN 0 AND 999999999999 THEN RETURN false; END IF;
 SELECT id INTO s FROM sharkai_commerce.store WHERE user_id=p_user AND currency=p_currency
   AND revoked_at IS NULL AND approved_at<=now() AND expires_at>now() FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 INSERT INTO sharkai_commerce.resale_target VALUES(s,monday,p_target)
 ON CONFLICT(store_id,week_start) DO UPDATE SET target_minor=excluded.target_minor;
 RETURN true;
END $f$;

CREATE FUNCTION sharkai_commerce.resale_cleared_purchase(p_store uuid,p_kind text,p_ref text)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT posted_cost_minor::numeric FROM sharkai_commerce.fulfillment
 WHERE p_kind='fulfillment' AND store_id=p_store AND order_ref=p_ref AND current_state='reconciled'
$f$;

CREATE FUNCTION sharkai_commerce.record_resale_week(p_signer text,p jsonb,p_digest text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE s sharkai_commerce.store; prev sharkai_commerce.resale_week; duplicate text;
 first_day date:=(p->>'week_start')::date; observed timestamptz:=(p->>'observed_at')::timestamptz;
 closing bigint:=(p->>'closing_cumulative_net_minor')::bigint; net bigint:=(p->>'net_minor')::bigint;
 target bigint; recovered numeric:=0; item jsonb; claimed numeric; cleared numeric; prior numeric;
BEGIN
 SELECT * INTO s FROM sharkai_commerce.store WHERE id=(p->>'store_id')::uuid AND shop=p->>'shop'
  AND currency=p->>'currency' AND custody_ref=p->>'custody_ref' AND contract_digest=p->>'contract_digest'
  AND approved_at<=now() AND expires_at>now() AND revoked_at IS NULL FOR UPDATE;
 IF NOT FOUND OR p_signer IS DISTINCT FROM s.ledger_collector THEN RETURN 'forbidden'; END IF;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT (p ?& ARRAY['kind','basis','observed_at','report_ref','evidence_sha256',
   'week_start','week_end','previous_report_ref','opening_cumulative_net_minor','closing_cumulative_net_minor','net_minor',
   'settled_receipts_minor','refunds_minor','goods_minor','fulfillment_minor','advertising_minor','fees_minor','taxes_minor',
   'other_costs_minor','recovered_purchase_cost_minor','recovered_purchases'])
   OR coalesce(p->>'kind','')<>'resale_week' OR coalesce(p->>'basis','')<>'settled_resale_after_all_costs_excluding_external_flows'
   OR coalesce(p_digest,'')!~'^[a-f0-9]{64}$' OR coalesce(p->>'evidence_sha256','')!~'^[a-f0-9]{64}$'
   OR coalesce(p->>'report_ref','')!~'^[A-Za-z0-9_.:-]{1,100}$'
   OR EXISTS(SELECT 1 FROM unnest(ARRAY['settled_receipts_minor','refunds_minor','goods_minor','fulfillment_minor','advertising_minor',
      'fees_minor','taxes_minor','other_costs_minor','recovered_purchase_cost_minor']) k WHERE coalesce(p->>k,'')!~'^(0|[1-9][0-9]{0,11})$')
   OR EXISTS(SELECT 1 FROM unnest(ARRAY['opening_cumulative_net_minor','closing_cumulative_net_minor','net_minor']) k
      WHERE coalesce(p->>k,'')!~'^(0|-?[1-9][0-9]{0,11})$')
   OR observed IS NULL OR observed>clock_timestamp() OR first_day IS NULL OR extract(isodow FROM first_day)<>1
   OR (p->>'week_end')::date IS DISTINCT FROM first_day+6 OR (observed AT TIME ZONE 'UTC')::date<first_day+7
   OR jsonb_typeof(p->'recovered_purchases') IS DISTINCT FROM 'array' THEN RETURN 'invalid'; END IF;
 IF net IS DISTINCT FROM (p->>'settled_receipts_minor')::bigint-(p->>'refunds_minor')::bigint-(p->>'goods_minor')::bigint
   -(p->>'fulfillment_minor')::bigint-(p->>'advertising_minor')::bigint-(p->>'fees_minor')::bigint-(p->>'taxes_minor')::bigint
   -(p->>'other_costs_minor')::bigint OR closing IS DISTINCT FROM (p->>'opening_cumulative_net_minor')::bigint+net THEN RETURN 'invalid'; END IF;
 SELECT digest INTO duplicate FROM sharkai_commerce.resale_week WHERE store_id=s.id AND report_ref=p->>'report_ref';
 IF FOUND THEN RETURN CASE WHEN duplicate=p_digest THEN 'replayed' ELSE 'conflict' END; END IF;
 SELECT * INTO prev FROM sharkai_commerce.resale_week WHERE store_id=s.id ORDER BY week_start DESC LIMIT 1;
 IF first_day IS DISTINCT FROM coalesce(prev.week_start+7,date_trunc('week',s.approved_at AT TIME ZONE 'UTC')::date)
   OR (p->>'previous_report_ref') IS DISTINCT FROM prev.report_ref
   OR (p->>'opening_cumulative_net_minor')::bigint IS DISTINCT FROM coalesce(prev.cumulative,0)
   OR observed<prev.observed_at THEN RETURN 'conflict'; END IF;
 IF jsonb_array_length(p->'recovered_purchases')>1000 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'recovered_purchases') r
    GROUP BY r->>'kind',r->>'ref' HAVING count(*)>1) THEN RETURN 'invalid'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p->'recovered_purchases') LOOP
   IF coalesce(item->>'kind','') NOT IN ('fulfillment','procurement') OR coalesce(item->>'ref','')!~'^[A-Za-z0-9_.:-]{1,100}$'
     OR coalesce(item->>'amount_minor','')!~'^[1-9][0-9]{0,11}$' THEN RETURN 'invalid'; END IF;
   claimed:=(item->>'amount_minor')::numeric;
   cleared:=sharkai_commerce.resale_cleared_purchase(s.id,item->>'kind',item->>'ref');
   SELECT coalesce(sum(amount),0) INTO prior FROM sharkai_commerce.resale_cost_recovery
    WHERE store_id=s.id AND kind=item->>'kind' AND purchase_ref=item->>'ref';
   IF cleared IS NULL OR claimed+prior>cleared THEN RETURN 'invalid'; END IF;
   recovered:=recovered+claimed;
 END LOOP;
 IF recovered IS DISTINCT FROM (p->>'recovered_purchase_cost_minor')::numeric OR recovered>
   least((p->>'goods_minor')::numeric+(p->>'fulfillment_minor')::numeric,
   greatest(0,net+(p->>'goods_minor')::numeric+(p->>'fulfillment_minor')::numeric)) THEN RETURN 'invalid'; END IF;
 SELECT target_minor INTO target FROM sharkai_commerce.resale_target WHERE store_id=s.id AND week_start<=first_day ORDER BY week_start DESC LIMIT 1;
 INSERT INTO sharkai_commerce.resale_week VALUES(s.id,first_day,p->>'report_ref',p_digest,p->>'evidence_sha256',
    observed,net,closing,greatest(coalesce(prev.high_water,0),closing),greatest(0,closing-coalesce(prev.high_water,0)),target,NULL);
 INSERT INTO sharkai_commerce.resale_cost_recovery SELECT s.id,first_day,r->>'kind',r->>'ref',(r->>'amount_minor')::bigint
  FROM jsonb_array_elements(p->'recovered_purchases') r;
 RETURN 'recorded';
EXCEPTION WHEN unique_violation THEN RETURN 'conflict';
 WHEN data_exception OR check_violation OR not_null_violation THEN RETURN 'invalid';
END $f$;

CREATE FUNCTION sharkai_commerce.allocate_resale_profit(p_user text,p_currency text,p_week date,p_reinvest bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE s uuid; w sharkai_commerce.resale_week;
BEGIN
 IF p_reinvest IS NULL OR p_reinvest<0 THEN RETURN false; END IF;
 SELECT id INTO s FROM sharkai_commerce.store WHERE user_id=p_user AND currency=p_currency
   AND revoked_at IS NULL AND approved_at<=now() AND expires_at>now() FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO w FROM sharkai_commerce.resale_week WHERE store_id=s AND week_start=p_week;
 IF NOT FOUND OR w.allocable<=0 OR p_reinvest>w.allocable THEN RETURN false; END IF;
 IF w.reinvested IS NOT NULL THEN RETURN w.reinvested=p_reinvest; END IF;
 UPDATE sharkai_commerce.resale_week SET reinvested=p_reinvest,allocated_at=clock_timestamp() WHERE store_id=s AND week_start=p_week;
 RETURN true;
END $f$;

CREATE FUNCTION sharkai_commerce.record_resale_owner_payout(p_signer text,p jsonb,p_digest text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE s sharkai_commerce.store; available numeric; duplicate text; amount bigint; observed timestamptz;
BEGIN
 SELECT a.* INTO s FROM sharkai_commerce.store a JOIN sharkai_commerce.resale_payout_destination d ON d.store_id=a.id
  WHERE a.id=(p->>'store_id')::uuid AND a.shop=p->>'shop' AND a.custody_ref=p->>'custody_ref' AND a.currency=p->>'currency'
   AND a.contract_digest=p->>'contract_digest' AND d.contract_digest=a.contract_digest AND d.beneficiary_digest=p->>'beneficiary_digest'
   AND a.revoked_at IS NULL AND now() BETWEEN a.approved_at AND a.expires_at FOR UPDATE OF a;
 IF NOT FOUND OR p_signer IS DISTINCT FROM s.cash_collector THEN RETURN 'forbidden'; END IF;
 IF coalesce(p->>'basis','')<>'settled_same_currency_owner_profit_payout' OR coalesce(p->>'kind','')<>'resale_owner_payout'
   OR coalesce(p_digest,'')!~'^[a-f0-9]{64}$' OR coalesce(p->>'evidence_sha256','')!~'^[a-f0-9]{64}$'
   OR coalesce(p->>'amount_minor','')!~'^[1-9][0-9]{0,11}$' OR (p->>'debit_ref') IS NOT DISTINCT FROM (p->>'credit_ref')
   OR EXISTS(SELECT 1 FROM unnest(ARRAY['debit_ref','credit_ref','report_ref']) k WHERE coalesce(p->>k,'')!~'^[A-Za-z0-9_.:-]{1,100}$')
   THEN RETURN 'invalid'; END IF;
 amount:=(p->>'amount_minor')::bigint; observed:=(p->>'observed_at')::timestamptz;
 IF observed IS NULL OR observed NOT BETWEEN s.approved_at AND clock_timestamp() THEN RETURN 'invalid'; END IF;
 SELECT digest INTO duplicate FROM sharkai_commerce.resale_payout WHERE store_id=s.id AND report_ref=p->>'report_ref';
 IF FOUND THEN RETURN CASE WHEN duplicate=p_digest THEN 'replayed' ELSE 'conflict' END; END IF;
 SELECT coalesce(sum(allocable-reinvested),0)-(SELECT coalesce(sum(r.amount),0) FROM sharkai_commerce.resale_payout r WHERE r.store_id=s.id)
   INTO available FROM sharkai_commerce.resale_week WHERE store_id=s.id AND reinvested IS NOT NULL AND allocated_at<=observed;
 IF amount>available THEN RETURN 'invalid'; END IF;
 INSERT INTO sharkai_commerce.resale_payout VALUES(s.id,p->>'report_ref',p_digest,p->>'evidence_sha256',amount,observed,p->>'debit_ref',p->>'credit_ref');
 RETURN 'recorded';
EXCEPTION WHEN unique_violation THEN RETURN 'conflict';
 WHEN data_exception OR not_null_violation THEN RETURN 'invalid';
END $f$;

CREATE FUNCTION sharkai_commerce.resale_funding(p_user text,p_currency text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 WITH store AS (SELECT * FROM sharkai_commerce.store WHERE user_id=p_user AND currency=p_currency
     AND revoked_at IS NULL AND approved_at<=now() AND expires_at>now()),
   cash AS (SELECT e.packet FROM sharkai_commerce.evidence e JOIN store s ON s.id=e.store_id
     WHERE e.kind='cash' AND e.packet->>'contract_digest'=s.contract_digest AND e.observed_at BETWEEN now()-interval '10 minutes' AND now()
       AND NOT EXISTS(SELECT 1 FROM sharkai_commerce.resale_payout p WHERE p.store_id=s.id AND p.observed_at>e.observed_at)
     ORDER BY e.observed_at DESC LIMIT 1),
 contributions AS (SELECT CASE WHEN packet->>'resale_basis'='reconciled_net_owner_contributions_excluding_all_sales_and_earnings'
     AND packet->>'resale_contributed_minor'~'^(0|[1-9][0-9]{0,11})$' THEN (packet->>'resale_contributed_minor')::numeric END AS amount FROM cash),
 latest AS (SELECT w.* FROM sharkai_commerce.resale_week w JOIN store s ON s.id=w.store_id ORDER BY week_start DESC LIMIT 1),
 balance AS (SELECT coalesce(sum(w.reinvested),0) AS reinvested,coalesce(sum(w.allocable-coalesce(w.reinvested,0)),0) AS reserved
     FROM sharkai_commerce.resale_week w JOIN store s ON s.id=w.store_id),
 paid AS (SELECT coalesce(sum(p.amount),0) AS total FROM sharkai_commerce.resale_payout p JOIN store s ON s.id=p.store_id),
 costs AS (SELECT coalesce(sum(r.amount),0) AS recovered FROM sharkai_commerce.resale_cost_recovery r JOIN store s ON s.id=r.store_id)
 SELECT jsonb_build_object('funding_verified',(SELECT amount FROM contributions) IS NOT NULL AND EXISTS(SELECT 1 FROM store s
     WHERE coalesce((SELECT week_start+7 FROM latest),date_trunc('week',s.approved_at AT TIME ZONE 'UTC')::date)=date_trunc('week',now() AT TIME ZONE 'UTC')::date),
   'confirmed_capital_minor',greatest(0,coalesce((SELECT amount FROM contributions),0)-coalesce((SELECT high_water-cumulative FROM latest),0))::text,
   'recovered_cost_minor',recovered::text,'reinvested_minor',reinvested::text,'reserved_minor',greatest(0,reserved-total)::text)
 FROM balance,costs,paid
$f$;

CREATE FUNCTION sharkai_commerce.resale_settlement(p_user text,p_currency text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 WITH store AS (SELECT * FROM sharkai_commerce.store WHERE user_id=p_user AND currency=p_currency AND revoked_at IS NULL
     AND approved_at<=now() AND expires_at>now()),
 monday AS (SELECT date_trunc('week',now() AT TIME ZONE 'UTC')::date AS d),
 eligible_days AS (SELECT e.report_day,e.packet FROM sharkai_commerce.evidence e JOIN store s ON s.id=e.store_id CROSS JOIN monday
   WHERE e.kind='day' AND e.packet->>'contract_digest'=s.contract_digest AND e.report_day>=d AND e.report_day<(now() AT TIME ZONE 'UTC')::date),
 day_profit AS (SELECT coalesce(sum((item->>'revenue_minor')::numeric-(item->>'refunds_minor')::numeric-(item->>'goods_minor')::numeric
    -(item->>'fulfillment_minor')::numeric-(item->>'advertising_minor')::numeric-(item->>'fees_minor')::numeric-(item->>'other_costs_minor')::numeric),0) AS net
    FROM eligible_days CROSS JOIN LATERAL jsonb_array_elements(packet->'products') item),
 weeks AS (SELECT w.* FROM sharkai_commerce.resale_week w JOIN store s ON s.id=w.store_id),
 last_weeks AS (SELECT * FROM weeks ORDER BY (allocable>0 AND reinvested IS NULL) DESC,week_start DESC LIMIT 104),
 paid AS (SELECT coalesce(sum(x.amount),0) AS amount FROM sharkai_commerce.resale_payout x JOIN store s ON s.id=x.store_id)
 SELECT jsonb_build_object('status',CASE WHEN EXISTS(SELECT 1 FROM store) THEN 'available' ELSE 'unavailable' END,'currency',p_currency,
   'period',(SELECT jsonb_build_object('start_date',d,'end_date',d+6,'verified_days',(SELECT count(*) FROM eligible_days),'verified_profit_minor',
      CASE WHEN EXISTS(SELECT 1 FROM eligible_days) THEN (SELECT net::text FROM day_profit) END,'target_minor',
      (SELECT t.target_minor::text FROM sharkai_commerce.resale_target t WHERE t.store_id=s.id AND t.week_start<=d ORDER BY t.week_start DESC LIMIT 1)) FROM store s,monday),
   'closed',coalesce((SELECT jsonb_agg(jsonb_build_object('start_date',week_start,'end_date',week_start+6,'profit_minor',net::text,'target_minor',target::text,
      'allocable_minor',allocable::text,'reinvested_minor',reinvested::text,'owner_minor',(allocable-reinvested)::text,'status',
      CASE WHEN allocable=0 THEN 'no_profit' WHEN reinvested IS NULL THEN 'awaiting_allocation' ELSE 'allocated' END) ORDER BY week_start DESC) FROM last_weeks),'[]'::jsonb),
   'reinvested_total_minor',(SELECT coalesce(sum(reinvested),0)::text FROM weeks),'owner_reserved_minor',
     greatest(0,(SELECT coalesce(sum(allocable-reinvested),0) FROM weeks)-paid.amount)::text,'owner_paid_minor',paid.amount::text,
   'owner_payout_url',(SELECT 'https://wise.com/home/' FROM sharkai_commerce.resale_payout_destination d JOIN store s ON s.id=d.store_id AND d.contract_digest=s.contract_digest))
 FROM paid
$f$;
REVOKE ALL ON ALL TABLES IN SCHEMA sharkai_commerce FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sharkai_commerce FROM PUBLIC;
COMMIT;
