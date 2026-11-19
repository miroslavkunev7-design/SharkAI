-- Apply after commerce-dropshipping.sql and commerce-resale-settlement.sql.
BEGIN;
ALTER TABLE sharkai_commerce.store ALTER COLUMN printful_store DROP NOT NULL,
 ALTER COLUMN supplier_manual_confirm_only DROP NOT NULL, ALTER COLUMN exclusive_draft_confirmation DROP NOT NULL,
 ALTER COLUMN external_ref_prefix SET DEFAULT '';
ALTER TABLE sharkai_commerce.store ADD CHECK(printful_store IS NULL OR (supplier_manual_confirm_only IS TRUE AND exclusive_draft_confirmation IS TRUE));
CREATE TABLE sharkai_commerce.stock_supplier (
 id uuid PRIMARY KEY,store_id uuid NOT NULL REFERENCES sharkai_commerce.store(id),region text NOT NULL CHECK(region IN ('eu','us')),
 organization_id text NOT NULL,vendor_id text NOT NULL,warehouse_id text NOT NULL,supplier_name text NOT NULL CHECK(length(supplier_name) BETWEEN 1 AND 120),
 receiving_collector text NOT NULL,vendor_email_hash text NOT NULL CHECK(vendor_email_hash~'^[a-f0-9]{64}$'),contract_digest text NOT NULL UNIQUE CHECK(contract_digest ~ '^[a-f0-9]{64}$'),
 issued_po_accepted_by_supplier boolean NOT NULL CHECK(issued_po_accepted_by_supplier),
 fixed_landed_cost_no_overdraft boolean NOT NULL CHECK(fixed_landed_cost_no_overdraft), exclusive_issuance boolean NOT NULL CHECK(exclusive_issuance),
 approved_at timestamptz NOT NULL,expires_at timestamptz NOT NULL CHECK(expires_at>approved_at),revoked_at timestamptz,
 UNIQUE(store_id,organization_id,vendor_id)
);
CREATE TABLE sharkai_commerce.stock_offer (
 id uuid PRIMARY KEY,supplier_id uuid NOT NULL REFERENCES sharkai_commerce.stock_supplier(id),store_id uuid NOT NULL REFERENCES sharkai_commerce.store(id),
 po_id text NOT NULL CHECK(po_id ~ '^[1-9][0-9]{0,19}$'),product_id text NOT NULL,product_name text NOT NULL,
 provider_item text NOT NULL CHECK(provider_item ~ '^[1-9][0-9]{0,19}$'),units integer NOT NULL CHECK(units BETWEEN 1 AND 100000),
 max_cost_minor bigint NOT NULL CHECK(max_cost_minor BETWEEN 1 AND 999999999999),expires_at timestamptz NOT NULL,
 supplier_quote_digest text NOT NULL CHECK(supplier_quote_digest ~ '^[a-f0-9]{64}$'),UNIQUE(store_id,po_id)
);
CREATE TABLE sharkai_commerce.stock_purchase (
 offer_id uuid PRIMARY KEY REFERENCES sharkai_commerce.stock_offer(id),review_id uuid NOT NULL UNIQUE,revision integer NOT NULL,fingerprint text NOT NULL,
 max_cost_minor bigint NOT NULL,expires_at timestamptz NOT NULL,state text NOT NULL CHECK(state IN ('reviewed','submitting','issued','uncertain')),
 claimed_at timestamptz,settled_cost_minor bigint CHECK(settled_cost_minor BETWEEN 1 AND max_cost_minor),settled_at timestamptz,
 gross_units_sold integer,units_on_hand integer,settled_revenue_minor bigint,refunded_minor bigint,selling_cost_minor bigint,stock_as_of timestamptz
);
CREATE TABLE sharkai_commerce.stock_proof (
 offer_id uuid NOT NULL REFERENCES sharkai_commerce.stock_offer(id),kind text NOT NULL,ref text NOT NULL,digest text NOT NULL,
 observed_at timestamptz NOT NULL,units_received integer,store_id uuid NOT NULL,PRIMARY KEY(store_id,kind,ref)
);
CREATE TABLE sharkai_commerce.stock_mandate (
 id uuid PRIMARY KEY,store_id uuid NOT NULL REFERENCES sharkai_commerce.store(id),supplier_id uuid NOT NULL REFERENCES sharkai_commerce.stock_supplier(id),
 product_id text NOT NULL,contract_digest text NOT NULL,store_contract text NOT NULL,revision integer NOT NULL,
 max_per_po bigint NOT NULL CHECK(max_per_po>0),total_cap bigint NOT NULL CHECK(total_cap>=max_per_po),expires_at timestamptz NOT NULL,
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),revoked_at timestamptz
);
ALTER TABLE sharkai_commerce.stock_purchase ADD COLUMN automation_id uuid REFERENCES sharkai_commerce.stock_mandate(id);
CREATE UNIQUE INDEX stock_one_active_mandate ON sharkai_commerce.stock_mandate(store_id,supplier_id,product_id) WHERE revoked_at IS NULL;
CREATE FUNCTION sharkai_commerce.procurement_binding(p_user text,p_offer uuid,p_receipt boolean DEFAULT false) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT jsonb_build_object('store',s.id,'shop',s.shop,'currency',s.currency,'supplier',v.id,'region',v.region,'org',v.organization_id,
  'vendor',v.vendor_id,'warehouse',v.warehouse_id,'contract',v.contract_digest,'item',o.provider_item,'product',o.product_id,'po',o.po_id,'units',o.units,
  'cap',o.max_cost_minor::text,'quote',o.supplier_quote_digest,'vendor_email_hash',v.vendor_email_hash) FROM sharkai_commerce.stock_offer o JOIN sharkai_commerce.stock_supplier v ON v.id=o.supplier_id
 JOIN sharkai_commerce.store s ON s.id=o.store_id AND s.id=v.store_id WHERE o.id=p_offer AND (p_user IS NULL OR s.user_id=p_user)
 AND s.revoked_at IS NULL AND v.revoked_at IS NULL AND greatest(s.approved_at,v.approved_at)<=clock_timestamp()
 AND s.expires_at>clock_timestamp() AND (least(o.expires_at,v.expires_at)>clock_timestamp() OR (p_receipt AND EXISTS(
  SELECT FROM sharkai_commerce.stock_purchase p WHERE p.offer_id=o.id AND p.claimed_at IS NOT NULL)))
 AND v.receiving_collector NOT IN (s.cash_collector,s.catalog_collector,s.ledger_collector)
$f$;
CREATE OR REPLACE FUNCTION sharkai_commerce.capital(p_user text,p_currency text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 WITH account AS (SELECT * FROM sharkai_commerce.store WHERE user_id=p_user AND currency=p_currency AND revoked_at IS NULL AND approved_at<=clock_timestamp() AND expires_at>clock_timestamp()),
 prefs AS (SELECT * FROM sharkai_commerce.owner_settings WHERE user_id=p_user),
 cash AS (SELECT (e.packet->>'cash_minor')::numeric amount,e.observed_at FROM sharkai_commerce.evidence e JOIN account a ON a.id=e.store_id
  WHERE e.kind='cash' AND e.packet->>'contract_digest'=a.contract_digest AND e.observed_at BETWEEN clock_timestamp()-interval '10 minutes' AND clock_timestamp() ORDER BY observed_at DESC LIMIT 1),
 obligations AS (SELECT f.max_cost_minor AS held,0::bigint AS spent FROM sharkai_commerce.fulfillment f JOIN account a ON a.id=f.store_id WHERE f.current_state IN ('submitting','accepted','uncertain')
 UNION ALL SELECT 0,f.posted_cost_minor FROM sharkai_commerce.fulfillment f JOIN account a ON a.id=f.store_id WHERE f.current_state='reconciled'
 UNION ALL SELECT CASE WHEN p.settled_cost_minor IS NULL THEN p.max_cost_minor ELSE 0 END,coalesce(p.settled_cost_minor,0) FROM sharkai_commerce.stock_purchase p
 JOIN sharkai_commerce.stock_offer o ON o.id=p.offer_id JOIN account a ON a.id=o.store_id WHERE p.claimed_at IS NOT NULL),
 balance AS (SELECT coalesce(sum(held),0) h,coalesce(sum(spent),0) s FROM obligations),
 limits AS (SELECT coalesce((SELECT cap FROM prefs WHERE currency=p_currency),0)::numeric cap,sharkai_commerce.resale_funding(p_user,p_currency) funding)
 SELECT jsonb_build_object('limit_minor',cap::text,'cash_minor',(SELECT amount::text FROM cash),'held_minor',h::text,
  'available_minor',CASE WHEN cap<=0 OR NOT coalesce((funding->>'funding_verified')::boolean,false)
     OR NOT (funding ?& ARRAY['confirmed_capital_minor','reinvested_minor','reserved_minor','recovered_cost_minor'])
     OR NOT EXISTS(SELECT FROM cash) THEN '0'
     ELSE greatest(0,least((SELECT amount FROM cash)-coalesce((funding->>'reserved_minor')::numeric,9223372036854775807)-h,
      least(cap,(funding->>'confirmed_capital_minor')::numeric)+least(s,(funding->>'recovered_cost_minor')::numeric)+(funding->>'reinvested_minor')::numeric-s-h))::text END,
  'observed_at',(SELECT observed_at FROM cash),'agent_read_allowed',coalesce((SELECT agent_read_allowed FROM prefs),false)) FROM balance,limits
$f$;
CREATE FUNCTION sharkai_commerce.stock_authorize(p_user text,p_offer uuid,p_review uuid,p_action text,p_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE s sharkai_commerce.store; o sharkai_commerce.stock_offer;p sharkai_commerce.stock_purchase; rev integer; until_time timestamptz:=clock_timestamp()+interval '2 minutes';
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('commerce:'||p_user,0));
 SELECT * INTO s FROM sharkai_commerce.store WHERE user_id=p_user FOR UPDATE;
 IF NOT FOUND OR p_fingerprint IS NULL OR p_fingerprint!~'^[a-f0-9]{64}$' OR sharkai_commerce.procurement_binding(p_user,p_offer) IS NULL THEN RETURN '{"status":"blocked"}'; END IF;
 SELECT * INTO o FROM sharkai_commerce.stock_offer WHERE id=p_offer AND store_id=s.id FOR SHARE;
 SELECT revision INTO rev FROM sharkai_commerce.owner_settings WHERE user_id=p_user AND currency=s.currency FOR UPDATE;
 IF NOT FOUND OR (sharkai_commerce.capital(p_user,s.currency)->>'available_minor')::numeric<o.max_cost_minor THEN RETURN '{"status":"blocked"}'; END IF;
 IF p_action='review' THEN
   INSERT INTO sharkai_commerce.stock_purchase AS old(offer_id,review_id,revision,fingerprint,max_cost_minor,expires_at,state)
    VALUES(o.id,p_review,rev,p_fingerprint,o.max_cost_minor,least(until_time,o.expires_at),'reviewed') ON CONFLICT(offer_id)
    DO UPDATE SET review_id=excluded.review_id,revision=excluded.revision,fingerprint=excluded.fingerprint,max_cost_minor=excluded.max_cost_minor,
      expires_at=excluded.expires_at WHERE old.state='reviewed' RETURNING * INTO p;
   IF NOT FOUND THEN RETURN '{"status":"blocked"}'; END IF;
   RETURN jsonb_build_object('status','reviewed','review_id',p_review,'currency',s.currency,'max_cost_minor',p.max_cost_minor::text,'expires_at',p.expires_at);
 END IF;
 IF p_action<>'confirm' THEN RETURN '{"status":"blocked"}'; END IF;
 UPDATE sharkai_commerce.stock_purchase SET state='submitting',claimed_at=clock_timestamp()
   WHERE offer_id=p_offer AND review_id=p_review AND state='reviewed' AND expires_at>clock_timestamp() AND fingerprint=p_fingerprint
     AND revision=rev AND max_cost_minor=o.max_cost_minor;
 IF NOT FOUND THEN RETURN '{"status":"blocked"}'; END IF;
 UPDATE sharkai_commerce.store SET allocation_revision=allocation_revision+1 WHERE id=s.id;
 RETURN '{"status":"claimed"}';
END $f$;
CREATE FUNCTION sharkai_commerce.stock_finish(p_user text,p_offer uuid,p_review uuid,p_ok boolean) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $f$
 WITH changed AS (UPDATE sharkai_commerce.stock_purchase p SET state=CASE WHEN p_ok THEN 'issued' ELSE 'uncertain' END
 FROM sharkai_commerce.stock_offer o,sharkai_commerce.store s WHERE p.offer_id=o.id AND o.store_id=s.id AND s.user_id=p_user
  AND o.id=p_offer AND p.review_id=p_review AND p.state='submitting' RETURNING 1) SELECT EXISTS(SELECT FROM changed)
$f$;
CREATE FUNCTION sharkai_commerce.set_stock_mandate(p_user text,p_offer uuid,p_id uuid,p_each bigint,p_total bigint,p_until timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE s sharkai_commerce.store; o sharkai_commerce.stock_offer;v sharkai_commerce.stock_supplier;p sharkai_commerce.owner_settings;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('commerce:'||p_user,0));
 SELECT * INTO s FROM sharkai_commerce.store WHERE user_id=p_user FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF p_offer IS NULL THEN
  UPDATE sharkai_commerce.stock_mandate SET revoked_at=clock_timestamp() WHERE id=p_id AND store_id=s.id AND revoked_at IS NULL; RETURN FOUND;
 END IF;
 SELECT * INTO o FROM sharkai_commerce.stock_offer WHERE id=p_offer AND store_id=s.id;
 IF NOT FOUND OR sharkai_commerce.procurement_binding(p_user,p_offer) IS NULL THEN RETURN false; END IF;
 SELECT * INTO v FROM sharkai_commerce.stock_supplier WHERE id=o.supplier_id;
 SELECT * INTO p FROM sharkai_commerce.owner_settings WHERE user_id=p_user AND currency=s.currency;
 IF NOT FOUND OR p_each IS NULL OR p_total IS NULL OR p_until IS NULL OR p_each<=0 OR p_total<p_each OR p_total>p.cap
  OR p_until<=clock_timestamp() OR p_until>least(s.expires_at,v.expires_at) THEN RETURN false; END IF;
 UPDATE sharkai_commerce.stock_mandate SET revoked_at=clock_timestamp() WHERE store_id=s.id AND supplier_id=v.id AND product_id=o.product_id AND revoked_at IS NULL;
 INSERT INTO sharkai_commerce.stock_mandate(id,store_id,supplier_id,product_id,contract_digest,store_contract,revision,max_per_po,total_cap,expires_at)
  VALUES(p_id,s.id,v.id,o.product_id,v.contract_digest,s.contract_digest,p.revision,p_each,p_total,p_until);
 RETURN true;
END $f$;
CREATE FUNCTION sharkai_commerce.stock_automatic(p_user text,p_offer uuid,p_review uuid,p_mandate uuid,p_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE s sharkai_commerce.store; o sharkai_commerce.stock_offer;m sharkai_commerce.stock_mandate;spent numeric;reply jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('commerce:'||p_user,0));
 SELECT * INTO s FROM sharkai_commerce.store WHERE user_id=p_user FOR UPDATE;
 SELECT * INTO o FROM sharkai_commerce.stock_offer WHERE id=p_offer AND store_id=s.id;
 IF NOT FOUND OR EXISTS(SELECT FROM sharkai_commerce.stock_purchase WHERE offer_id=p_offer) THEN RETURN '{"status":"blocked"}'; END IF;
 SELECT a.* INTO m FROM sharkai_commerce.stock_mandate a JOIN sharkai_commerce.stock_supplier v ON v.id=a.supplier_id
  JOIN sharkai_commerce.owner_settings p ON p.user_id=s.user_id AND p.currency=s.currency WHERE a.id=p_mandate AND a.store_id=s.id AND a.product_id=o.product_id
  AND a.supplier_id=o.supplier_id AND a.contract_digest=v.contract_digest AND a.store_contract=s.contract_digest AND a.revision=p.revision
  AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp() AND a.max_per_po>=o.max_cost_minor FOR UPDATE OF a;
 IF NOT FOUND THEN RETURN '{"status":"blocked"}'; END IF;
 SELECT coalesce(sum(coalesce(settled_cost_minor,max_cost_minor)),0) INTO spent FROM sharkai_commerce.stock_purchase WHERE automation_id=m.id;
 IF spent+o.max_cost_minor>m.total_cap THEN RETURN '{"status":"blocked"}'; END IF;
 reply:=sharkai_commerce.stock_authorize(p_user,p_offer,p_review,'review',p_fingerprint);
 IF reply->>'status'<>'reviewed' THEN RETURN '{"status":"blocked"}'; END IF;
 reply:=sharkai_commerce.stock_authorize(p_user,p_offer,p_review,'confirm',p_fingerprint);
 IF reply->>'status'='claimed' THEN UPDATE sharkai_commerce.stock_purchase SET automation_id=m.id WHERE offer_id=p_offer; END IF;
 RETURN reply;
END $f$;
CREATE FUNCTION sharkai_commerce.stock_due() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT coalesce(jsonb_agg(to_jsonb(ready)),'[]'::jsonb) FROM (SELECT s.user_id,o.id AS offer_id,m.id AS mandate_id
  FROM sharkai_commerce.stock_mandate m JOIN sharkai_commerce.store s ON s.id=m.store_id JOIN sharkai_commerce.stock_offer o
    ON o.store_id=s.id AND o.supplier_id=m.supplier_id AND o.product_id=m.product_id
    JOIN sharkai_commerce.stock_supplier v ON v.id=m.supplier_id AND v.contract_digest=m.contract_digest
    JOIN sharkai_commerce.owner_settings p ON p.user_id=s.user_id AND p.currency=s.currency
  WHERE m.revoked_at IS NULL AND m.expires_at>clock_timestamp() AND m.store_contract=s.contract_digest AND m.revision=p.revision AND m.max_per_po>=o.max_cost_minor
    AND o.max_cost_minor+(SELECT coalesce(sum(coalesce(sp.settled_cost_minor,sp.max_cost_minor)),0) FROM sharkai_commerce.stock_purchase sp WHERE sp.automation_id=m.id)<=m.total_cap
    AND sharkai_commerce.procurement_binding(s.user_id,o.id) IS NOT NULL AND NOT EXISTS(SELECT FROM sharkai_commerce.stock_purchase sp WHERE sp.offer_id=o.id)
    AND (sharkai_commerce.capital(s.user_id,s.currency)->>'available_minor')::numeric>=o.max_cost_minor
  ORDER BY o.expires_at,o.id LIMIT 3) ready
$f$;

CREATE FUNCTION sharkai_commerce.record_stock_proof(p_signer text,p jsonb,p_digest text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE o sharkai_commerce.stock_offer;v sharkai_commerce.stock_supplier;s sharkai_commerce.store;cur sharkai_commerce.stock_purchase;
 k text:=p->>'kind';observed timestamptz:=(p->>'observed_at')::timestamptz;proof_ref text:=p->>'report_ref';old_digest text;counted integer;
BEGIN
 SELECT * INTO o FROM sharkai_commerce.stock_offer WHERE id=(p->>'offer_id')::uuid;
 IF NOT FOUND THEN RETURN 'forbidden'; END IF;
 SELECT * INTO s FROM sharkai_commerce.store WHERE id=o.store_id FOR UPDATE;
 SELECT * INTO v FROM sharkai_commerce.stock_supplier WHERE id=o.supplier_id AND store_id=s.id;
 IF NOT FOUND OR p_signer IS NULL OR p_signer IS DISTINCT FROM (CASE k WHEN 'stock_receipt' THEN v.receiving_collector WHEN 'stock_payment' THEN s.cash_collector WHEN 'stock_sales' THEN s.ledger_collector END)
  OR v.receiving_collector IN (s.cash_collector,s.catalog_collector,s.ledger_collector) OR p->>'contract_digest' IS DISTINCT FROM v.contract_digest
  OR p->>'currency' IS DISTINCT FROM s.currency OR p->>'po_id' IS DISTINCT FROM o.po_id OR p->>'product_id' IS DISTINCT FROM o.product_id
  THEN RETURN 'forbidden'; END IF;
 SELECT * INTO cur FROM sharkai_commerce.stock_purchase WHERE offer_id=o.id AND claimed_at IS NOT NULL FOR UPDATE;
 IF NOT FOUND OR observed IS NULL OR observed<date_trunc('second',cur.claimed_at) OR observed>clock_timestamp() OR proof_ref IS NULL OR length(proof_ref) NOT BETWEEN 1 AND 100
  OR p_digest IS NULL OR p_digest!~'^[a-f0-9]{64}$' THEN RETURN 'invalid'; END IF;
 SELECT digest INTO old_digest FROM sharkai_commerce.stock_proof WHERE store_id=s.id AND kind=k AND stock_proof.ref=proof_ref;
 IF FOUND THEN RETURN CASE WHEN old_digest=p_digest THEN 'replayed' ELSE 'conflict' END; END IF;
 SELECT coalesce(sum(units_received),0)::integer INTO counted FROM sharkai_commerce.stock_proof WHERE offer_id=o.id AND kind='stock_receipt';
 IF k='stock_receipt' THEN
  IF p->>'basis' IS DISTINCT FROM 'posted_zoho_owned_warehouse_receipt' OR p->>'warehouse_id' IS DISTINCT FROM v.warehouse_id
   OR p->>'vendor_id' IS DISTINCT FROM v.vendor_id OR (p->>'units_received')::integer NOT BETWEEN 1 AND o.units-counted THEN RETURN 'invalid'; END IF;
 ELSIF k='stock_payment' THEN
  IF p->>'basis' IS DISTINCT FROM 'final_cleared_all_in_business_purchase' OR cur.settled_cost_minor IS NOT NULL
   OR (p->>'cost_minor')::bigint NOT BETWEEN 1 AND cur.max_cost_minor OR NOT EXISTS(SELECT FROM sharkai_commerce.evidence e
    WHERE e.store_id=s.id AND e.kind='cash' AND e.report_ref=p->>'cash_report_ref' AND e.observed_at>=observed AND e.packet->>'contract_digest'=s.contract_digest)
   THEN RETURN 'invalid'; END IF;
  UPDATE sharkai_commerce.stock_purchase SET settled_cost_minor=(p->>'cost_minor')::bigint,settled_at=observed WHERE offer_id=o.id;
 ELSIF k='stock_sales' THEN
  IF p->>'basis' IS DISTINCT FROM 'cumulative_settled_merchant_resales_net_of_discounts_ex_tax' OR cur.settled_cost_minor IS NULL OR counted=0
   OR observed<=coalesce(cur.stock_as_of,'-infinity') OR (p->>'units_sold')::integer NOT BETWEEN coalesce(cur.gross_units_sold,0) AND counted
   OR (p->>'units_on_hand')::integer NOT BETWEEN 0 AND counted-(p->>'units_sold')::integer
   OR (p->>'settled_revenue_minor')::bigint<coalesce(cur.settled_revenue_minor,0) OR (p->>'refunded_minor')::bigint<coalesce(cur.refunded_minor,0)
   OR (p->>'selling_cost_minor')::bigint<coalesce(cur.selling_cost_minor,0) OR ((p->>'units_sold')::integer=0 AND (p->>'settled_revenue_minor')::bigint<>0)
   THEN RETURN 'invalid'; END IF;
  UPDATE sharkai_commerce.stock_purchase SET gross_units_sold=(p->>'units_sold')::integer,units_on_hand=(p->>'units_on_hand')::integer,
    settled_revenue_minor=(p->>'settled_revenue_minor')::bigint,refunded_minor=(p->>'refunded_minor')::bigint,
    selling_cost_minor=(p->>'selling_cost_minor')::bigint,stock_as_of=observed WHERE offer_id=o.id;
 ELSE RETURN 'invalid'; END IF;
 INSERT INTO sharkai_commerce.stock_proof VALUES(o.id,k,proof_ref,p_digest,observed,(p->>'units_received')::integer,s.id);
 UPDATE sharkai_commerce.store SET allocation_revision=allocation_revision+1 WHERE id=s.id;
 RETURN 'recorded';
EXCEPTION WHEN unique_violation THEN RETURN 'conflict'; WHEN invalid_text_representation OR numeric_value_out_of_range OR check_violation THEN RETURN 'invalid';
END $f$;
ALTER FUNCTION sharkai_commerce.resale_cleared_purchase(uuid,text,text) RENAME TO resale_cleared_fulfillment;
CREATE FUNCTION sharkai_commerce.resale_cleared_purchase(p_store uuid,p_kind text,p_ref text) RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT CASE WHEN p_kind='procurement' THEN coalesce((SELECT trunc(p.settled_cost_minor::numeric*coalesce(p.gross_units_sold,0)/o.units)
   FROM sharkai_commerce.stock_offer o JOIN sharkai_commerce.stock_purchase p ON p.offer_id=o.id WHERE o.store_id=p_store AND o.po_id=p_ref AND p.settled_at IS NOT NULL),0)
 ELSE sharkai_commerce.resale_cleared_fulfillment(p_store,p_kind,p_ref) END
$f$;
CREATE FUNCTION sharkai_commerce.stock_dashboard(p_user text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 WITH account AS (SELECT * FROM sharkai_commerce.store WHERE user_id=p_user),
 items AS (SELECT o.id AS offer_id,o.product_name,v.supplier_name,o.units,s.currency,o.max_cost_minor::text AS max_cost_minor,
  CASE WHEN coalesce(r.n,0)>0 THEN 'received' ELSE coalesce(p.state,'offered') END AS state,coalesce(r.n,0)::int AS received_units,
  p.gross_units_sold AS sold_units,CASE WHEN p.stock_as_of BETWEEN clock_timestamp()-interval '24 hours' AND clock_timestamp() THEN p.units_on_hand END AS stock_units,
  CASE WHEN p.stock_as_of IS NOT NULL AND p.settled_at IS NOT NULL THEN (p.settled_revenue_minor::numeric-p.refunded_minor-p.selling_cost_minor-ceil(p.settled_cost_minor::numeric*p.gross_units_sold/o.units))::text END AS realized_margin_minor
  FROM account s JOIN sharkai_commerce.stock_offer o ON o.store_id=s.id JOIN sharkai_commerce.stock_supplier v ON v.id=o.supplier_id AND v.store_id=s.id
  LEFT JOIN sharkai_commerce.stock_purchase p ON p.offer_id=o.id LEFT JOIN LATERAL (SELECT sum(units_received) n FROM sharkai_commerce.stock_proof WHERE offer_id=o.id AND kind='stock_receipt') r ON true
  WHERE p.claimed_at IS NOT NULL OR sharkai_commerce.procurement_binding(p_user,o.id) IS NOT NULL ORDER BY o.expires_at DESC,o.id LIMIT 100)
 SELECT jsonb_build_object('status',CASE WHEN EXISTS(SELECT FROM account s JOIN sharkai_commerce.stock_supplier v ON v.store_id=s.id
  WHERE s.revoked_at IS NULL AND v.revoked_at IS NULL AND least(s.expires_at,v.expires_at)>clock_timestamp()) OR EXISTS(SELECT FROM items) THEN 'available' ELSE 'unavailable' END,
  'items',coalesce((SELECT jsonb_agg(to_jsonb(items)) FROM items),'[]'::jsonb),
  'mandates',coalesce((SELECT jsonb_agg(jsonb_build_object('mandate_id',m.id,'product_id',m.product_id,'supplier_name',v.supplier_name,'currency',s.currency,
    'max_per_po_minor',m.max_per_po::text,'total_minor',m.total_cap::text,'expires_at',m.expires_at)) FROM sharkai_commerce.stock_mandate m JOIN account s ON s.id=m.store_id
    JOIN sharkai_commerce.stock_supplier v ON v.id=m.supplier_id AND v.contract_digest=m.contract_digest
    JOIN sharkai_commerce.owner_settings p ON p.user_id=s.user_id AND p.currency=s.currency AND p.revision=m.revision
    WHERE m.revoked_at IS NULL AND s.revoked_at IS NULL AND v.revoked_at IS NULL AND m.store_contract=s.contract_digest
    AND greatest(s.approved_at,v.approved_at)<=clock_timestamp() AND least(m.expires_at,s.expires_at,v.expires_at)>clock_timestamp()),'[]'::jsonb))
$f$;
CREATE OR REPLACE FUNCTION sharkai_commerce.dashboard(p_user text,p_from date,p_to date,p_currency text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
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
 'shop',jsonb_build_object('connected',EXISTS(SELECT FROM store),'supplier_connected',EXISTS(SELECT FROM store WHERE printful_store IS NOT NULL)),
 'capital',sharkai_commerce.capital(p_user,p_currency),'source_observed_at',(SELECT max(observed_at) FROM day_reports),
 'orders',coalesce((SELECT jsonb_agg(to_jsonb(orders) ORDER BY ordered_at DESC,order_ref) FROM orders),'[]'::jsonb),
 'period_complete',p_to>=p_from AND (SELECT count(*) FROM day_reports)=p_to-p_from+1,
 'daily',coalesce((SELECT jsonb_agg((to_jsonb(totals)-'report_day')||jsonb_build_object('date',report_day) ORDER BY report_day) FROM totals),'[]'::jsonb))
$f$;
CREATE FUNCTION sharkai_commerce.fixed_stock_contract() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
BEGIN
 IF TG_TABLE_NAME='stock_offer' OR (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at')
   OR OLD.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'Use a separately verified purchase offer and supplier contract'; END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER fixed_stock_offer BEFORE UPDATE ON sharkai_commerce.stock_offer FOR EACH ROW EXECUTE FUNCTION sharkai_commerce.fixed_stock_contract();
CREATE TRIGGER fixed_stock_supplier BEFORE UPDATE ON sharkai_commerce.stock_supplier FOR EACH ROW EXECUTE FUNCTION sharkai_commerce.fixed_stock_contract();
ALTER TABLE sharkai_commerce.stock_supplier ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_commerce.stock_offer ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_commerce.stock_purchase ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_commerce.stock_proof ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_commerce.stock_mandate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA sharkai_commerce FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sharkai_commerce FROM PUBLIC;
DO $priv$ DECLARE role_name text;BEGIN
 FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA sharkai_commerce FROM %I',role_name);
  EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sharkai_commerce FROM %I',role_name);
 END LOOP;
END $priv$;
COMMIT;
