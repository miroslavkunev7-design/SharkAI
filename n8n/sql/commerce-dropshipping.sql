-- Independently funded commerce. Requires the original application public."User" table.
BEGIN;
CREATE SCHEMA sharkai_commerce;
REVOKE ALL ON SCHEMA sharkai_commerce FROM PUBLIC;
CREATE TABLE sharkai_commerce.store (
  id uuid PRIMARY KEY,user_id text UNIQUE NOT NULL REFERENCES public."User"(id),shop text NOT NULL UNIQUE CHECK(shop ~ '^[a-z0-9][a-z0-9-]{0,61}[.]myshopify[.]com$'),
  printful_store text UNIQUE NOT NULL CHECK(printful_store ~ '^[1-9][0-9]{0,15}$'),currency text NOT NULL CHECK(currency IN ('EUR','USD','GBP','BGN')),
  external_ref_prefix text NOT NULL CHECK(external_ref_prefix IN ('','shopify-')),
  custody_ref text UNIQUE NOT NULL,contract_digest text NOT NULL CHECK(contract_digest ~ '^[a-f0-9]{64}$'),
  cash_collector text NOT NULL,catalog_collector text NOT NULL,ledger_collector text NOT NULL,
  CHECK(cash_collector<>catalog_collector AND cash_collector<>ledger_collector AND catalog_collector<>ledger_collector),
  hard_charge_cap_minor bigint NOT NULL CHECK(hard_charge_cap_minor>0), dedicated_nonrecourse boolean NOT NULL CHECK(dedicated_nonrecourse),
  external_charge_cap_verified boolean NOT NULL CHECK(external_charge_cap_verified), supplier_manual_confirm_only boolean NOT NULL CHECK(supplier_manual_confirm_only),
  approved_at timestamptz NOT NULL,expires_at timestamptz NOT NULL CHECK(expires_at>approved_at),revoked_at timestamptz,
  exclusive_draft_confirmation boolean NOT NULL CHECK(exclusive_draft_confirmation),allocation_revision bigint NOT NULL DEFAULT 0
);
CREATE TABLE sharkai_commerce.owner_settings (
  user_id text PRIMARY KEY REFERENCES public."User"(id),currency text NOT NULL,cap bigint NOT NULL CHECK(cap>=0),
  agent_read_allowed boolean NOT NULL DEFAULT false,revision integer NOT NULL DEFAULT 1
);
CREATE FUNCTION sharkai_commerce.keep_store_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
BEGIN
 IF ROW(NEW.id,NEW.user_id,NEW.shop,NEW.printful_store,NEW.currency,NEW.custody_ref)
    IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.shop,OLD.printful_store,OLD.currency,OLD.custody_ref)
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
  OR (ROW(NEW.hard_charge_cap_minor,NEW.cash_collector,NEW.catalog_collector,NEW.ledger_collector,NEW.external_ref_prefix,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.hard_charge_cap_minor,OLD.cash_collector,OLD.catalog_collector,OLD.ledger_collector,OLD.external_ref_prefix,OLD.expires_at)
    AND NEW.contract_digest=OLD.contract_digest) THEN RAISE EXCEPTION 'A new reviewed commerce contract is required'; END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER keep_store_identity BEFORE UPDATE ON sharkai_commerce.store FOR EACH ROW EXECUTE FUNCTION sharkai_commerce.keep_store_identity();
CREATE TABLE sharkai_commerce.order_state (
  store_id uuid NOT NULL REFERENCES sharkai_commerce.store(id),order_ref text NOT NULL CHECK(order_ref ~ '^[1-9][0-9]{0,19}$'),
  status text NOT NULL CHECK(status IN ('paid','pending','partial_refund','refunded','cancelled')),total_minor bigint NOT NULL CHECK(total_minor>=0),
  refunded_minor bigint NOT NULL CHECK(refunded_minor>=0),ordered_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
  read_at timestamptz NOT NULL,digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),PRIMARY KEY(store_id,order_ref)
);
CREATE TABLE sharkai_commerce.shopify_event (
  store_id uuid NOT NULL REFERENCES sharkai_commerce.store(id),delivery uuid NOT NULL,digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(store_id,delivery)
);
CREATE TABLE sharkai_commerce.evidence (
  store_id uuid NOT NULL REFERENCES sharkai_commerce.store(id),kind text NOT NULL CHECK(kind IN ('cash','catalog','day')),
  report_ref text NOT NULL,digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),observed_at timestamptz NOT NULL,report_day date,
  packet jsonb NOT NULL,PRIMARY KEY(store_id,kind,report_ref), UNIQUE(store_id,kind,observed_at,report_day)
);
CREATE INDEX commerce_current_evidence ON sharkai_commerce.evidence(store_id,kind,observed_at DESC);
CREATE UNIQUE INDEX commerce_daily_close ON sharkai_commerce.evidence(store_id,report_day) WHERE kind='day';
CREATE TABLE sharkai_commerce.fulfillment (
  store_id uuid NOT NULL,order_ref text NOT NULL,review_id uuid NOT NULL UNIQUE,revision integer NOT NULL,
  supplier_id text NOT NULL,quote_digest text NOT NULL,order_digest text NOT NULL,max_cost_minor bigint NOT NULL CHECK(max_cost_minor>0),
  current_state text NOT NULL CHECK(current_state IN ('reviewed','submitting','accepted','uncertain','reconciled')),
  expires_at timestamptz NOT NULL,claimed_at timestamptz,posted_cost_minor bigint CHECK(posted_cost_minor BETWEEN 0 AND max_cost_minor),
  supplier_observed_at timestamptz,supplier_status text,
  PRIMARY KEY(store_id,order_ref),UNIQUE(store_id,supplier_id),FOREIGN KEY(store_id,order_ref) REFERENCES sharkai_commerce.order_state(store_id,order_ref)
);
CREATE FUNCTION sharkai_commerce.current_store(p_user text,p_shop text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT jsonb_build_object('id',id,'shop',shop,'printful_store',printful_store,'external_ref_prefix',external_ref_prefix,'currency',currency,'hard_cap',hard_charge_cap_minor::text,'contract',contract_digest)
 FROM sharkai_commerce.store WHERE (p_user IS NOT NULL OR p_shop IS NOT NULL) AND (p_user IS NULL OR user_id=p_user) AND (p_shop IS NULL OR shop=p_shop)
 AND approved_at<=clock_timestamp() AND expires_at>clock_timestamp() AND revoked_at IS NULL
$f$;
CREATE FUNCTION sharkai_commerce.set_cap(p_user text,p_currency text,p_cap bigint,p_read boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF p_cap IS NULL OR p_cap<0 OR p_cap>999999999999 OR p_currency NOT IN ('EUR','USD','GBP','BGN') THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('commerce:'||p_user,0));
 IF p_cap>0 AND NOT EXISTS(SELECT 1 FROM sharkai_commerce.store WHERE user_id=p_user AND currency=p_currency AND revoked_at IS NULL
   AND approved_at<=clock_timestamp() AND expires_at>clock_timestamp()) THEN RETURN false; END IF;
 INSERT INTO sharkai_commerce.owner_settings AS s VALUES(p_user,p_currency,p_cap,coalesce(p_read,false),1)
   ON CONFLICT(user_id) DO UPDATE SET currency=EXCLUDED.currency,cap=EXCLUDED.cap,agent_read_allowed=coalesce(p_read,s.agent_read_allowed),revision=s.revision+1;
 RETURN true;
END $f$;
CREATE FUNCTION sharkai_commerce.agent_access(p_user text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT coalesce((SELECT jsonb_build_object('enabled',agent_read_allowed,'revision',revision) FROM sharkai_commerce.owner_settings WHERE user_id=p_user),jsonb_build_object('enabled',false,'revision',0))
$f$;
CREATE FUNCTION sharkai_commerce.record_order(p_store uuid,p_delivery uuid,p_raw_digest text,p jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE prev text;
BEGIN
 PERFORM 1 FROM sharkai_commerce.store WHERE id=p_store AND currency=p->>'currency' AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RETURN 'forbidden'; END IF;
 IF p_delivery IS NOT NULL THEN
  INSERT INTO sharkai_commerce.shopify_event(store_id,delivery,digest) VALUES(p_store,p_delivery,p_raw_digest) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN SELECT digest INTO prev FROM sharkai_commerce.shopify_event WHERE store_id=p_store AND delivery=p_delivery;
    IF prev<>p_raw_digest THEN RETURN 'conflict'; END IF; END IF;
 END IF;
 INSERT INTO sharkai_commerce.order_state AS o SELECT p_store,p->>'order_ref',p->>'status',(p->>'total_minor')::bigint,
   (p->>'refunded_minor')::bigint,(p->>'ordered_at')::timestamptz,(p->>'updated_at')::timestamptz,clock_timestamp(),p->>'digest'
 ON CONFLICT(store_id,order_ref) DO UPDATE SET status=excluded.status,total_minor=excluded.total_minor,refunded_minor=excluded.refunded_minor,
   updated_at=excluded.updated_at,read_at=excluded.read_at,digest=excluded.digest
   WHERE excluded.updated_at>=o.updated_at AND excluded.refunded_minor>=o.refunded_minor
     AND (o.status<>'cancelled' OR excluded.status='cancelled')
     AND (excluded.updated_at>o.updated_at OR excluded.digest=o.digest OR excluded.status IN ('cancelled','refunded','partial_refund'));
 RETURN 'recorded';
END $f$;
CREATE FUNCTION sharkai_commerce.accept_evidence(p_signer text,p jsonb,p_digest text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE s sharkai_commerce.store; k text:=p->>'kind'; observed timestamptz:=(p->>'observed_at')::timestamptz; d date:=(p->>'date')::date;
 previous text;line jsonb;
BEGIN
 SELECT * INTO s FROM sharkai_commerce.store WHERE id=(p->>'store_id')::uuid AND currency=p->>'currency' AND contract_digest=p->>'contract_digest'
  AND approved_at<=clock_timestamp() AND expires_at>clock_timestamp() AND revoked_at IS NULL FOR UPDATE;
 IF NOT FOUND OR p_signer IS NULL OR p_signer IS DISTINCT FROM (CASE k WHEN 'catalog' THEN s.catalog_collector WHEN 'cash' THEN s.cash_collector WHEN 'day' THEN s.ledger_collector END)
    THEN RETURN 'forbidden'; END IF;
 IF observed IS NULL OR observed>clock_timestamp() OR (k='cash' AND observed<clock_timestamp()-interval '10 minutes') OR p_digest!~'^[a-f0-9]{64}$'
   OR p->>'report_ref' IS NULL OR length(p->>'report_ref') NOT BETWEEN 1 AND 128 OR
   (k='day' AND (d IS NULL OR d>=(observed AT TIME ZONE 'UTC')::date)) THEN RETURN 'invalid'; END IF;
 SELECT digest INTO previous FROM sharkai_commerce.evidence WHERE store_id=s.id AND kind=k AND report_ref=p->>'report_ref';
 IF FOUND THEN RETURN CASE WHEN previous=p_digest THEN 'replayed' ELSE 'conflict' END; END IF;
 IF k='day' AND EXISTS(SELECT 1 FROM sharkai_commerce.evidence WHERE store_id=s.id AND kind='day' AND report_day=d) THEN RETURN 'conflict'; END IF;
 IF k='cash' THEN
   IF p->>'basis' IS DISTINCT FROM 'settled_dedicated_commerce_no_recourse' OR (p->>'cash_minor')::bigint<0
     OR (p->>'hard_charge_cap_minor')::bigint IS DISTINCT FROM s.hard_charge_cap_minor OR jsonb_typeof(p->'settled_orders') IS DISTINCT FROM 'array'
     OR EXISTS(SELECT 1 FROM sharkai_commerce.evidence WHERE store_id=s.id AND kind='cash' AND observed_at>=observed) THEN RETURN 'invalid'; END IF;
   FOR line IN SELECT * FROM jsonb_array_elements(p->'settled_orders') LOOP
     UPDATE sharkai_commerce.fulfillment SET current_state='reconciled',posted_cost_minor=(line->>'cost_minor')::bigint
       WHERE store_id=s.id AND order_ref=line->>'order_ref' AND supplier_id=line->>'supplier_id'
       AND claimed_at<=observed AND (line->>'cost_minor')::bigint BETWEEN 0 AND max_cost_minor
       AND (current_state IN ('accepted','uncertain','submitting') OR (current_state='reconciled' AND posted_cost_minor=(line->>'cost_minor')::bigint));
     IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0410',MESSAGE='Unmatched fulfillment'; END IF;
   END LOOP;
 ELSIF k='catalog' THEN
   IF p->>'basis' IS DISTINCT FROM 'complete_approved_supplier_catalog' OR jsonb_typeof(p->'products') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p->'products')<>(p->>'product_count')::integer THEN RETURN 'invalid'; END IF;
 ELSIF k='day' THEN
   IF p->>'basis' IS DISTINCT FROM 'complete_utc_settled_after_discounts_including_shipping_before_refunds_ex_tax'
     OR jsonb_typeof(p->'products') IS DISTINCT FROM 'array' THEN RETURN 'invalid'; END IF;
   IF NOT EXISTS (SELECT 1 FROM sharkai_commerce.evidence c WHERE c.store_id=s.id AND c.kind='catalog' AND c.report_ref=p->>'catalog_ref' AND c.packet->>'contract_digest'=s.contract_digest
      AND (SELECT array_agg(z->>'product_id' ORDER BY z->>'product_id') FROM jsonb_array_elements(c.packet->'products') z)
      IS NOT DISTINCT FROM (SELECT array_agg(z->>'product_id' ORDER BY z->>'product_id') FROM jsonb_array_elements(p->'products') z))
      THEN RETURN 'invalid'; END IF;
 ELSE RETURN 'invalid'; END IF;
 INSERT INTO sharkai_commerce.evidence VALUES(s.id,k,p->>'report_ref',p_digest,observed,d,p);
 IF k='cash' THEN UPDATE sharkai_commerce.store SET allocation_revision=allocation_revision+1 WHERE id=s.id; END IF;
 RETURN 'recorded';
EXCEPTION WHEN SQLSTATE 'P0410' OR numeric_value_out_of_range OR invalid_text_representation OR check_violation OR not_null_violation THEN RETURN 'invalid';
END $f$;
CREATE FUNCTION sharkai_commerce.capital(p_user text,p_currency text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 WITH account AS (SELECT * FROM sharkai_commerce.store WHERE user_id=p_user AND currency=p_currency AND revoked_at IS NULL AND approved_at<=clock_timestamp() AND expires_at>clock_timestamp()),
 settings AS (SELECT * FROM sharkai_commerce.owner_settings WHERE user_id=p_user),
 cash AS (SELECT (e.packet->>'cash_minor')::numeric AS amount,e.observed_at FROM sharkai_commerce.evidence e JOIN account a ON a.id=e.store_id
     WHERE kind='cash' AND e.packet->>'contract_digest'=a.contract_digest AND e.observed_at BETWEEN clock_timestamp()-interval '10 minutes' AND clock_timestamp() ORDER BY observed_at DESC LIMIT 1),
 obligations AS (SELECT coalesce(sum(max_cost_minor) FILTER(WHERE current_state IN ('submitting','accepted','uncertain')),0) AS held,
     coalesce(sum(posted_cost_minor) FILTER(WHERE current_state='reconciled'),0) AS spent FROM sharkai_commerce.fulfillment f JOIN account a ON f.store_id=a.id)
 SELECT jsonb_build_object('limit_minor',coalesce((SELECT cap FROM settings WHERE currency=p_currency),0)::text,'cash_minor',(SELECT amount::text FROM cash),
   'held_minor',held::text,'available_minor',greatest(0,least(coalesce((SELECT amount FROM cash),0)-held,
        coalesce((SELECT cap FROM settings WHERE currency=p_currency),0)-spent-held))::text,'observed_at',(SELECT observed_at FROM cash),
   'agent_read_allowed',coalesce((SELECT agent_read_allowed FROM settings),false)) FROM obligations
$f$;
CREATE FUNCTION sharkai_commerce.approved_mapping(p_store uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT e.packet->'products' FROM sharkai_commerce.evidence e JOIN sharkai_commerce.store s ON s.id=e.store_id
 WHERE s.id=p_store AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND e.kind='catalog' AND e.packet->>'contract_digest'=s.contract_digest AND e.observed_at>clock_timestamp()-interval '24 hours'
 ORDER BY e.observed_at DESC LIMIT 1
$f$;
CREATE FUNCTION sharkai_commerce.authorize_fulfillment(p_user text,p_action text,p_order text,p_review uuid,p_supplier text,p_quote text,p_order_digest text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE s sharkai_commerce.store; o sharkai_commerce.order_state; f sharkai_commerce.fulfillment; rev integer; until_time timestamptz:=clock_timestamp()+interval '2 minutes';
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('commerce:'||p_user,0));
 SELECT * INTO s FROM sharkai_commerce.store WHERE user_id=p_user AND revoked_at IS NULL AND approved_at<=clock_timestamp() AND expires_at>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RETURN '{"status":"blocked"}'; END IF;
 SELECT * INTO o FROM sharkai_commerce.order_state WHERE store_id=s.id AND order_ref=p_order FOR UPDATE;
 IF NOT FOUND OR o.status<>'paid' OR o.refunded_minor<>0 OR o.digest IS DISTINCT FROM p_order_digest OR o.read_at<clock_timestamp()-interval '30 seconds' THEN RETURN '{"status":"blocked"}'; END IF;
 SELECT revision INTO rev FROM sharkai_commerce.owner_settings WHERE user_id=p_user AND currency=s.currency FOR UPDATE;
 IF NOT FOUND OR (sharkai_commerce.capital(p_user,s.currency)->>'available_minor')::numeric<s.hard_charge_cap_minor THEN RETURN '{"status":"blocked"}'; END IF;
 IF p_action='review' THEN
   INSERT INTO sharkai_commerce.fulfillment AS old(store_id,order_ref,review_id,revision,supplier_id,quote_digest,order_digest,max_cost_minor,current_state,expires_at)
    VALUES(s.id,p_order,p_review,rev,p_supplier,p_quote,p_order_digest,s.hard_charge_cap_minor,'reviewed',least(until_time,s.expires_at))
    ON CONFLICT(store_id,order_ref) DO UPDATE SET review_id=excluded.review_id,revision=excluded.revision,supplier_id=excluded.supplier_id,quote_digest=excluded.quote_digest,
      order_digest=excluded.order_digest,max_cost_minor=excluded.max_cost_minor,expires_at=excluded.expires_at WHERE old.current_state='reviewed'
    RETURNING * INTO f;
   IF NOT FOUND THEN RETURN '{"status":"blocked"}'; END IF;
   RETURN jsonb_build_object('status','reviewed','review_id',p_review,'currency',s.currency,'max_cost_minor',f.max_cost_minor::text,'expires_at',f.expires_at);
 END IF;
 IF p_action<>'confirm' THEN RETURN '{"status":"blocked"}'; END IF;
 UPDATE sharkai_commerce.fulfillment SET current_state='submitting',claimed_at=clock_timestamp() WHERE store_id=s.id AND order_ref=p_order AND current_state='reviewed'
   AND review_id=p_review AND revision=rev AND supplier_id=p_supplier AND quote_digest=p_quote AND order_digest=p_order_digest
   AND max_cost_minor=s.hard_charge_cap_minor AND expires_at>clock_timestamp();
 IF NOT FOUND THEN RETURN '{"status":"blocked"}'; END IF;
 UPDATE sharkai_commerce.owner_settings SET cap=cap WHERE user_id=p_user;
 UPDATE sharkai_commerce.store SET allocation_revision=allocation_revision+1 WHERE id=s.id;
 RETURN '{"status":"claimed"}';
END $f$;
CREATE FUNCTION sharkai_commerce.finish_fulfillment(p_user text,p_review uuid,p_supplier text,p_ok boolean) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $f$
 WITH changed AS (UPDATE sharkai_commerce.fulfillment f SET current_state=CASE WHEN p_ok THEN 'accepted' ELSE 'uncertain' END
  FROM sharkai_commerce.store s WHERE s.id=f.store_id AND s.user_id=p_user AND f.review_id=p_review AND f.supplier_id=p_supplier
  AND f.current_state='submitting' RETURNING 1) SELECT EXISTS(SELECT 1 FROM changed)
$f$;
CREATE FUNCTION sharkai_commerce.supplier_observation(p_shop text,p_supplier_store text,p_supplier text,p_external text,p_state text,p_at timestamptz)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE f sharkai_commerce.fulfillment;
BEGIN
 SELECT x.* INTO f FROM sharkai_commerce.fulfillment x JOIN sharkai_commerce.store s ON s.id=x.store_id WHERE s.shop=p_shop AND s.printful_store=p_supplier_store
  AND x.supplier_id=p_supplier AND s.external_ref_prefix||x.order_ref=p_external AND x.claimed_at IS NOT NULL FOR UPDATE OF x;
 IF NOT FOUND THEN RETURN 'unmatched'; END IF;
 IF p_state NOT IN ('inreview','pending','inprocess','fulfilled','partial','failed','canceled','onhold') OR p_at IS NULL
   OR p_at<date_trunc('second',f.claimed_at) OR p_at>clock_timestamp() THEN RETURN 'invalid'; END IF;
 IF f.supplier_observed_at IS NOT NULL AND p_at<=f.supplier_observed_at THEN
   RETURN CASE WHEN p_at<f.supplier_observed_at OR f.supplier_status=p_state THEN 'replayed' ELSE 'conflict' END;
 END IF;
 UPDATE sharkai_commerce.fulfillment SET supplier_observed_at=p_at,supplier_status=p_state,current_state=CASE
   WHEN current_state='reconciled' THEN current_state WHEN p_state IN ('failed','canceled','onhold') THEN 'uncertain' ELSE 'accepted' END
 WHERE store_id=f.store_id AND order_ref=f.order_ref;
 RETURN 'recorded';
END $f$;
CREATE FUNCTION sharkai_commerce.product_candidates(p_user text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 WITH store AS (SELECT * FROM sharkai_commerce.store WHERE user_id=p_user AND approved_at<=clock_timestamp() AND expires_at>clock_timestamp() AND revoked_at IS NULL),
 cat AS (SELECT e.* FROM sharkai_commerce.evidence e JOIN store s ON s.id=e.store_id WHERE e.kind='catalog'
   AND e.packet->>'contract_digest'=s.contract_digest AND e.observed_at>=clock_timestamp()-interval '24 hours' ORDER BY e.observed_at DESC LIMIT 1),
 days AS (SELECT e.report_day,e.observed_at,z.* FROM sharkai_commerce.evidence e JOIN store s ON s.id=e.store_id
   CROSS JOIN LATERAL jsonb_array_elements(e.packet->'products') z WHERE e.kind='day' AND e.report_day>=(clock_timestamp() AT TIME ZONE 'UTC')::date-180)
 SELECT jsonb_build_object('status',CASE WHEN EXISTS(SELECT FROM cat) THEN 'verified' ELSE 'unverified' END,'currency',(SELECT currency FROM store),
   'observed_at',(SELECT observed_at FROM cat),'catalog_complete',EXISTS(SELECT FROM cat),
   'independent_sources_verified',EXISTS(SELECT FROM cat) AND EXISTS(SELECT FROM days),'products',coalesce((SELECT jsonb_agg(jsonb_build_object(
    'product_id',p->>'product_id','name',p->>'name','inventory_units',(p->>'inventory_units')::integer,'inventory_observed_at',cat.observed_at,
    'days',coalesce((SELECT jsonb_agg((d.value-'product_id')||jsonb_build_object('date',d.report_day) ORDER BY d.report_day)
      FROM days d WHERE d.value->>'product_id'=p->>'product_id'),'[]'::jsonb)) ORDER BY p->>'product_id')
    FROM cat CROSS JOIN LATERAL jsonb_array_elements(cat.packet->'products') p),'[]'::jsonb))
$f$;
CREATE FUNCTION sharkai_commerce.dashboard(p_user text,p_from date,p_to date,p_currency text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 WITH store AS (SELECT * FROM sharkai_commerce.store WHERE user_id=p_user AND currency=p_currency AND approved_at<=clock_timestamp() AND expires_at>clock_timestamp() AND revoked_at IS NULL),
 day_reports AS (SELECT report_day,observed_at,packet FROM sharkai_commerce.evidence e JOIN store s ON s.id=e.store_id WHERE kind='day' AND report_day BETWEEN p_from AND p_to),
 totals AS (SELECT d.report_day,max((d.packet->>'distinct_orders')::integer) AS orders,coalesce(sum((p->>'units')::int),0) AS units,
   coalesce(sum((p->>'revenue_minor')::bigint),0)::text AS revenue_minor,coalesce(sum((p->>'refunds_minor')::bigint),0)::text AS refunds_minor,
   coalesce(sum((p->>'goods_minor')::bigint),0)::text AS goods_minor,coalesce(sum((p->>'fulfillment_minor')::bigint),0)::text AS fulfillment_minor,
   coalesce(sum((p->>'advertising_minor')::bigint),0)::text AS advertising_minor,coalesce(sum((p->>'fees_minor')::bigint),0)::text AS fees_minor,
   coalesce(sum((p->>'other_costs_minor')::bigint),0)::text AS other_costs_minor FROM day_reports d LEFT JOIN LATERAL jsonb_array_elements(d.packet->'products') p ON true GROUP BY d.report_day),
 orders AS (SELECT o.order_ref,CASE WHEN o.status='partial_refund' THEN 'partially_refunded' ELSE o.status END AS status,o.total_minor::text,o.refunded_minor::text,o.ordered_at,
   o.read_at AS source_observed_at,CASE WHEN f.current_state='reconciled' THEN 'accepted' ELSE coalesce(f.current_state,'none') END AS fulfillment
   FROM sharkai_commerce.order_state o JOIN store s ON s.id=o.store_id LEFT JOIN sharkai_commerce.fulfillment f USING(store_id,order_ref)
   WHERE (o.ordered_at AT TIME ZONE 'UTC')::date BETWEEN p_from AND p_to ORDER BY o.ordered_at DESC,o.order_ref LIMIT 100)
 SELECT jsonb_build_object('status',CASE WHEN EXISTS(SELECT FROM store) THEN 'available' ELSE 'unavailable' END,'currency',p_currency,'from',p_from,'to',p_to,
 'shop',jsonb_build_object('connected',EXISTS(SELECT FROM store),'supplier_connected',EXISTS(SELECT FROM store)),
 'capital',sharkai_commerce.capital(p_user,p_currency),'source_observed_at',(SELECT max(observed_at) FROM day_reports),
 'orders',coalesce((SELECT jsonb_agg(to_jsonb(orders) ORDER BY ordered_at DESC,order_ref) FROM orders),'[]'::jsonb),
 'period_complete',p_to>=p_from AND (SELECT count(*) FROM day_reports)=p_to-p_from+1,
 'daily',coalesce((SELECT jsonb_agg((to_jsonb(totals)-'report_day')||jsonb_build_object('date',report_day) ORDER BY report_day) FROM totals),'[]'::jsonb))
$f$;
DO $access$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['store','owner_settings','order_state','shopify_event','evidence','fulfillment'] LOOP
   EXECUTE format('ALTER TABLE sharkai_commerce.%I ENABLE ROW LEVEL SECURITY',n);
 END LOOP;
 REVOKE ALL ON ALL TABLES IN SCHEMA sharkai_commerce FROM PUBLIC;
 REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sharkai_commerce FROM PUBLIC;
 FOR n IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
   EXECUTE format('REVOKE ALL ON SCHEMA sharkai_commerce FROM %I',n);
   EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA sharkai_commerce FROM %I',n);
   EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sharkai_commerce FROM %I',n);
 END LOOP;
END $access$;
COMMIT;
