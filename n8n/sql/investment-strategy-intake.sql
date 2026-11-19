-- A strategy signal and independent broker quote must agree before an order enters the durable worker queue.
BEGIN;
CREATE TABLE sharkai_broker.strategy_source (
  id uuid PRIMARY KEY,
  account_id text NOT NULL,
  worker_id text NOT NULL,
  asset_id text NOT NULL,
  strategy_label text NOT NULL,
  signal_collector text NOT NULL,
  quote_collector text NOT NULL CHECK (quote_collector<>signal_collector),
  provider_instrument_id bigint NOT NULL CHECK(provider_instrument_id BETWEEN 1 AND 999999999999),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  minor_unit_digits integer NOT NULL CHECK(minor_unit_digits BETWEEN 0 AND 3),
  asset_kind text NOT NULL CHECK(asset_kind IN ('STOCK','ETF')),
  extended_assets_verified boolean NOT NULL DEFAULT false,
  min_units bigint NOT NULL CHECK(min_units>0),
  max_units bigint NOT NULL CHECK(max_units>=min_units AND max_units<=999999999999),
  quantity_step bigint NOT NULL CHECK(quantity_step>0),
  price_tick bigint NOT NULL CHECK(price_tick>0),
  approval_reference text NOT NULL CHECK(length(approval_reference) BETWEEN 1 AND 128),
  approved_at timestamptz NOT NULL,expires_at timestamptz NOT NULL CHECK(expires_at>approved_at),revoked_at timestamptz,
  FOREIGN KEY(worker_id,account_id) REFERENCES sharkai_broker.worker_binding(worker_id,account_id),
  FOREIGN KEY(account_id,asset_id) REFERENCES sharkai_broker.asset(account_id,id)
);
CREATE TABLE sharkai_broker.strategy_event (
  binding_id uuid NOT NULL REFERENCES sharkai_broker.strategy_source(id),
  signal_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('signal','quote')),
  packet jsonb NOT NULL,
  fingerprint text NOT NULL,
  received_at timestamptz NOT NULL,
  PRIMARY KEY(binding_id,signal_id,kind)
);
CREATE TABLE sharkai_broker.job_provenance (
  job_id uuid PRIMARY KEY REFERENCES sharkai_broker.worker_order(id),
  binding_id uuid NOT NULL REFERENCES sharkai_broker.strategy_source(id),
  binding_hash text NOT NULL
);
CREATE TABLE sharkai_broker.verified_account_snapshot (
  account_id text NOT NULL REFERENCES sharkai_broker.account(id),
  snapshot_id text NOT NULL,
  packet_digest text NOT NULL,
  report_ref text NOT NULL,
  evidence_sha256 text NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,snapshot_id)
);
CREATE FUNCTION sharkai_broker.job_sources_current(p_job uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
  SELECT EXISTS (SELECT 1 FROM sharkai_broker.job_provenance j JOIN sharkai_broker.strategy_source b ON b.id=j.binding_id
    WHERE j.job_id=p_job AND b.revoked_at IS NULL AND b.approved_at<=statement_timestamp() AND b.expires_at>statement_timestamp()
    AND j.binding_hash=encode(sha256(convert_to(to_jsonb(b)::text,'UTF8')),'hex'))
$$;

CREATE FUNCTION sharkai_broker.accept_strategy_evidence(p_kind text,p_collector text,p_packet jsonb,p_fingerprint text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE
  b sharkai_broker.strategy_source;
  a sharkai_broker.account;
  m sharkai_broker.owner_mandate;
  pinned text;
  ref uuid;
  sig jsonb;
  quote jsonb;
  terms jsonb;
  market_time timestamptz;
  expiry timestamptz;
  capture timestamptz;
  wall timestamptz:=clock_timestamp();
  j_units bigint;
  limit_price bigint;
  fee bigint;
  max_value bigint;
BEGIN
  IF p_collector IS NULL OR p_kind NOT IN ('quote','signal') OR p_fingerprint IS NULL OR p_fingerprint!~'^[a-f0-9]{64}$'
    OR jsonb_typeof(p_packet) IS DISTINCT FROM 'object' THEN RETURN 'invalid'; END IF;
  SELECT * INTO b FROM sharkai_broker.strategy_source WHERE id=(p_packet->>'binding_id')::uuid FOR SHARE;
  IF NOT FOUND OR b.revoked_at IS NOT NULL OR b.approved_at>wall OR b.expires_at<=wall
    OR p_collector IS DISTINCT FROM (CASE WHEN p_kind='signal' THEN b.signal_collector ELSE b.quote_collector END)
  THEN RETURN 'forbidden'; END IF;
  ref:=(p_packet->>'signal_id')::uuid;
  capture:=(p_packet->>'observed_at')::timestamptz;
  IF ref IS NULL OR capture IS NULL OR capture>wall OR capture<wall-interval '30 seconds'
    OR p_packet->>'evidence_sha256' IS NULL OR p_packet->>'evidence_sha256'!~'^[a-f0-9]{64}$'
    OR jsonb_typeof(p_packet->'terms') IS DISTINCT FROM 'object' THEN RETURN 'invalid'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sharkai_broker.signal:'||ref::text,0));
  SELECT fingerprint INTO pinned FROM sharkai_broker.strategy_event WHERE binding_id=b.id AND signal_id=ref AND kind=p_kind;
  IF FOUND AND pinned<>p_fingerprint THEN RETURN 'conflict'; END IF;
  IF EXISTS (SELECT 1 FROM sharkai_broker.job_provenance WHERE job_id=ref AND binding_id=b.id) THEN RETURN 'replayed'; END IF;
  SELECT * INTO a FROM sharkai_broker.account WHERE id=b.account_id;
  IF NOT FOUND OR a.revoked_at IS NOT NULL OR a.provider_key IS DISTINCT FROM p_packet->>'provider_account_key'
    OR a.provider IS DISTINCT FROM p_packet->>'provider' OR a.currency<>b.currency OR a.consent_version IS DISTINCT FROM p_packet#>>'{terms,consent_version}'
    OR a.snapshot_id IS DISTINCT FROM p_packet#>>'{terms,snapshot_id}' OR NOT a.live_enabled OR a.halted_at IS NOT NULL
    OR a.scope_verified_at IS NULL OR a.ownership_verified_at IS NULL
    OR p_packet#>>'{terms,asset_id}' IS DISTINCT FROM b.asset_id OR p_packet#>>'{terms,currency}' IS DISTINCT FROM b.currency
    OR (p_packet#>>'{terms,provider_instrument_id}')::bigint IS DISTINCT FROM b.provider_instrument_id THEN RETURN 'forbidden'; END IF;
  SELECT * INTO m FROM sharkai_broker.owner_mandate WHERE version::text=a.consent_version AND account_id=a.id AND user_id=a.user_id
    AND expires_at>wall AND revoked_at IS NULL AND loss_stopped_at IS NULL;
  IF NOT FOUND OR m.approved_terms->>'strategy' IS DISTINCT FROM b.strategy_label THEN RETURN 'forbidden'; END IF;

  INSERT INTO sharkai_broker.strategy_event VALUES(b.id,ref,p_kind,p_packet,p_fingerprint,wall) ON CONFLICT DO NOTHING;
  SELECT packet INTO sig FROM sharkai_broker.strategy_event WHERE binding_id=b.id AND signal_id=ref AND kind='signal';
  SELECT packet INTO quote FROM sharkai_broker.strategy_event WHERE binding_id=b.id AND signal_id=ref AND kind='quote';
  IF sig IS NULL OR quote IS NULL THEN RETURN 'awaiting_evidence'; END IF;
  IF sig->'terms' IS DISTINCT FROM quote->'terms' OR (sig->>'observed_at')::timestamptz<wall-interval '30 seconds'
    OR sig->>'provider' IS DISTINCT FROM quote->>'provider' OR sig->>'provider_account_key' IS DISTINCT FROM quote->>'provider_account_key'
    THEN RETURN 'conflict'; END IF;
  terms:=sig->'terms'; market_time:=(quote->>'observed_at')::timestamptz; expiry:=(quote->>'expires_at')::timestamptz;
  j_units:=(terms->>'units')::bigint; limit_price:=(terms->>'limit_price_minor')::bigint;
  max_value:=(quote->>'max_notional_minor')::bigint; fee:=(quote->>'max_fee_minor')::bigint;
  IF market_time<wall-interval '30 seconds' OR market_time>wall OR expiry IS NULL OR expiry<=wall+interval '1 second'
    OR expiry>market_time+interval '30 seconds' OR max_value IS NULL OR fee IS NULL OR fee<0 OR max_value<=0
    OR j_units IS NULL OR j_units NOT BETWEEN b.min_units AND b.max_units OR j_units%b.quantity_step<>0
    OR terms->>'side' IS NULL OR terms->>'side' NOT IN ('BUY','SELL') OR terms->>'kind' IS NULL OR terms->>'kind' NOT IN ('LIMIT','MARKET')
    OR (terms->>'kind'='LIMIT' AND (limit_price IS NULL OR limit_price<=0 OR limit_price%b.price_tick<>0))
    OR (terms->>'kind'='MARKET' AND (terms->>'side'<>'SELL' OR limit_price IS NOT NULL))
    OR (terms->>'side'='BUY' AND max_value::numeric<j_units::numeric*limit_price)
    OR (terms->>'side'='SELL' AND quote->>'provider_enforced_no_short' IS DISTINCT FROM 'true')
    OR NOT EXISTS(SELECT 1 FROM sharkai_broker.asset x WHERE x.account_id=a.id AND x.id=b.asset_id AND x.enabled
      AND x.broker_instrument_id=b.provider_instrument_id AND x.reconciled_snapshot_id=a.snapshot_id)
    THEN RETURN 'invalid'; END IF;
  INSERT INTO sharkai_broker.worker_order(id,worker_id,account_id,consent_version,snapshot_id,instrument_asset_id,
    instrument_provider_id,currency,minor_unit_digits,instrument_kind,saxo_extended_assets_verified,minimum_units,maximum_units,
    quantity_step,price_tick_minor,side,order_kind,units,limit_price_minor,provider_enforced_no_short,quote_provider,
    quote_evidence_sha256,max_notional_minor,max_fee_minor,quote_at,quote_expires_at)
    VALUES(ref,b.worker_id,a.id,a.consent_version,a.snapshot_id,b.asset_id,b.provider_instrument_id,b.currency,b.minor_unit_digits,
      b.asset_kind,b.extended_assets_verified,b.min_units,b.max_units,b.quantity_step,b.price_tick,terms->>'side',terms->>'kind',
      j_units,limit_price,(quote->>'provider_enforced_no_short')::boolean,a.provider,quote->>'evidence_sha256',max_value,fee,market_time,expiry)
    ON CONFLICT(id) DO NOTHING;
  IF NOT FOUND THEN RETURN 'conflict'; END IF;
  INSERT INTO sharkai_broker.job_provenance VALUES(ref,b.id,encode(sha256(convert_to(to_jsonb(b)::text,'UTF8')),'hex'));
  RETURN 'queued';
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR check_violation
   OR numeric_value_out_of_range THEN RETURN 'invalid';
END
$$;

-- All account data and period performance must come from the same approved broker evidence.
CREATE FUNCTION sharkai_broker.accept_account_snapshot(p_collector text,p_packet jsonb,p_digest text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  b sharkai_broker.strategy_source;
  a sharkai_broker.account;
  previous text;
  ver uuid;
  m sharkai_broker.owner_mandate;
  snapshot text:=p_packet->>'snapshot_id';
  captured timestamptz:=(p_packet->>'observed_at')::timestamptz;
  ids text[];
BEGIN
  IF p_collector IS NULL OR p_digest IS NULL OR p_digest!~'^[a-f0-9]{64}$' OR snapshot IS NULL OR snapshot!~'^[A-Za-z0-9_.:-]{1,128}$'
    OR captured IS NULL OR p_packet->>'report_ref' IS NULL OR p_packet->>'evidence_sha256' IS NULL
    OR p_packet->>'evidence_sha256'!~'^[a-f0-9]{64}$' OR jsonb_typeof(p_packet->'closed_jobs') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_packet->'held_units') IS DISTINCT FROM 'object' THEN RETURN 'invalid'; END IF;
  SELECT * INTO b FROM sharkai_broker.strategy_source WHERE id=(p_packet->>'binding_id')::uuid AND quote_collector=p_collector
    AND revoked_at IS NULL AND approved_at<=clock_timestamp() AND expires_at>clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RETURN 'forbidden'; END IF;
  SELECT * INTO a FROM sharkai_broker.account WHERE id=b.account_id AND provider=p_packet->>'provider'
    AND provider_key=p_packet->>'provider_account_key' AND currency=p_packet->>'currency'
    AND contractual_approval_at<=clock_timestamp() AND ownership_verified_at<=clock_timestamp() AND revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN 'forbidden'; END IF;
  SELECT packet_digest INTO previous FROM sharkai_broker.verified_account_snapshot WHERE account_id=a.id AND snapshot_id=snapshot;
  IF FOUND THEN RETURN CASE WHEN previous=p_digest THEN 'replayed' ELSE 'conflict' END; END IF;
  SELECT coalesce(array_agg('worker:'||id),'{}'::text[]) INTO ids FROM jsonb_array_elements_text(p_packet->'closed_jobs') AS x(id);
  IF NOT sharkai_broker.reconcile_snapshot(a.id,a.provider,a.provider_key,snapshot,captured,
    (p_packet->>'exposure_minor')::bigint,(p_packet->>'settled_cash_minor')::bigint,p_packet->'held_units',ids)
    THEN RETURN 'invalid'; END IF;
  SELECT * INTO m FROM sharkai_broker.owner_mandate WHERE account_id=a.id AND user_id=a.user_id
    AND version::text=a.consent_version AND revoked_at IS NULL AND expires_at>clock_timestamp();
  IF FOUND THEN
    ver:=(p_packet#>>'{performance,consent_version}')::uuid;
    IF ver IS DISTINCT FROM m.version OR NOT sharkai_broker.record_mandate_progress(a.id,a.provider,a.provider_key,ver,snapshot,captured,
      (p_packet#>>'{performance,lifetime_net_minor}')::bigint,(p_packet#>>'{performance,window_net_minor}')::bigint,
      (p_packet#>>'{performance,window_start}')::date,(p_packet#>>'{performance,window_end}')::date,
      p_packet->>'report_ref',p_packet->>'evidence_sha256')
    THEN RAISE EXCEPTION USING ERRCODE='P0201',MESSAGE='Invalid mandate performance'; END IF;
  ELSIF p_packet->'performance' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE='P0201',MESSAGE='No matching mandate';
  END IF;
  INSERT INTO sharkai_broker.verified_account_snapshot VALUES(a.id,snapshot,p_digest,p_packet->>'report_ref',p_packet->>'evidence_sha256',captured);
  RETURN 'recorded';
EXCEPTION WHEN SQLSTATE 'P0201' OR invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow
  OR numeric_value_out_of_range OR check_violation THEN RETURN 'invalid';
END
$$;
REVOKE ALL ON sharkai_broker.strategy_source,sharkai_broker.strategy_event,sharkai_broker.job_provenance FROM PUBLIC;
REVOKE ALL ON sharkai_broker.verified_account_snapshot FROM PUBLIC;
REVOKE ALL ON FUNCTION sharkai_broker.accept_account_snapshot(text,jsonb,text) FROM PUBLIC;
CREATE FUNCTION sharkai_broker.owner_worker_status(p_user text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM sharkai_broker.account a
    JOIN sharkai_broker.owner_mandate m ON m.account_id=a.id AND m.user_id=a.user_id AND m.version::text=a.consent_version
    JOIN sharkai_broker.owner_application x ON x.singleton
    JOIN sharkai_broker.mandate_risk_snapshot r ON r.version=m.version AND r.snapshot_id=a.snapshot_id
    JOIN sharkai_broker.strategy_source b ON b.account_id=a.id AND b.strategy_label=m.approved_terms->>'strategy'
    JOIN sharkai_broker.worker_binding w ON w.account_id=a.id AND w.worker_id=b.worker_id
    WHERE a.user_id=p_user AND a.live_enabled AND a.revoked_at IS NULL AND a.halted_at IS NULL AND a.operator_halted_at IS NULL
      AND a.consent_revoked_at IS NULL AND m.revoked_at IS NULL AND m.loss_stopped_at IS NULL AND m.expires_at>statement_timestamp()
      AND b.approved_at<=statement_timestamp() AND b.expires_at>statement_timestamp() AND b.revoked_at IS NULL
      AND w.revoked_at IS NULL AND w.approved_until>statement_timestamp() AND w.credential_expires_at>statement_timestamp()
      AND a.reconciled AND a.snapshot_at BETWEEN statement_timestamp()-interval '2 minutes' AND statement_timestamp()
      AND r.observed_at BETWEEN statement_timestamp()-interval '2 minutes' AND statement_timestamp()
      AND r.net_pnl_minor::numeric> -(m.approved_terms->>'max_loss_minor')::numeric
      AND (a.target_state='NONE' OR (a.target_state='PENDING'
        AND a.target_checked_at BETWEEN statement_timestamp()-interval '2 minutes' AND statement_timestamp()
        AND statement_timestamp()>=a.target_window_start AND statement_timestamp()<a.target_window_end))
      AND NOT EXISTS(SELECT 1 FROM sharkai_broker.order_ledger o WHERE o.account_id=a.id AND o.reconciliation_required
        AND o.state IN ('SUBMITTING','UNKNOWN','REVIEW_REQUIRED','FILLED','CANCELED','REJECTED'))
      AND sharkai_broker.mandate_terms(p_user,m.policy_id,x.settings_table)=m.approved_terms)
$$;
REVOKE ALL ON FUNCTION sharkai_broker.owner_worker_status(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sharkai_broker.accept_strategy_evidence(text,text,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sharkai_broker.job_sources_current(uuid) FROM PUBLIC;
COMMIT;
