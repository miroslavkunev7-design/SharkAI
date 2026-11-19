-- Requires investment-order-ledger.sql and investment-owner-mandates.sql. The queue producer is a trusted server role.
-- Provision worker/job/role permissions separately after broker approval. Off and empty by default.
BEGIN;
CREATE TABLE sharkai_broker.worker_binding (
  worker_id text NOT NULL CHECK (worker_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  account_id text NOT NULL REFERENCES sharkai_broker.account(id),
  credential_ref text NOT NULL CHECK (credential_ref ~ '^[A-Za-z0-9_-]{1,64}$'),
  credential_sha256 text NOT NULL CHECK (credential_sha256 ~ '^[a-f0-9]{64}$'),
  credential_scope_approved_at timestamptz NOT NULL,
  verified_saxo_client_key text CHECK (verified_saxo_client_key ~ '^[A-Za-z0-9_+=/-]{1,128}$'),
  credential_expires_at timestamptz NOT NULL,
  approved_until timestamptz NOT NULL,
  approval_reference text NOT NULL CHECK (approval_reference ~ '^[A-Za-z0-9_.:/-]{1,128}$'),
  revoked_at timestamptz,
  PRIMARY KEY(worker_id,account_id)
);

CREATE TABLE sharkai_broker.worker_order (
  id uuid PRIMARY KEY,
  worker_id text NOT NULL,
  account_id text NOT NULL,
  consent_version text NOT NULL,
  snapshot_id text NOT NULL,
  instrument_asset_id text NOT NULL,
  instrument_provider_id bigint NOT NULL CHECK (instrument_provider_id BETWEEN 1 AND 999999999999),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  minor_unit_digits integer NOT NULL CHECK (minor_unit_digits BETWEEN 0 AND 3),
  instrument_kind text NOT NULL CHECK (instrument_kind IN ('STOCK','ETF')),
  saxo_extended_assets_verified boolean NOT NULL DEFAULT false,
  minimum_units bigint NOT NULL CHECK (minimum_units BETWEEN 1 AND 999999999999),
  maximum_units bigint NOT NULL CHECK (maximum_units BETWEEN 1 AND 999999999999),
  quantity_step bigint NOT NULL CHECK (quantity_step BETWEEN 1 AND 999999999999),
  price_tick_minor bigint NOT NULL CHECK (price_tick_minor BETWEEN 1 AND 999999999999),
  side text NOT NULL CHECK (side IN ('BUY','SELL')),
  order_kind text NOT NULL CHECK (order_kind IN ('LIMIT','MARKET')),
  units bigint NOT NULL CHECK (units BETWEEN 1 AND 999999999999),
  limit_price_minor bigint CHECK (limit_price_minor BETWEEN 1 AND 999999999999),
  provider_enforced_no_short boolean NOT NULL,
  quote_provider text NOT NULL CHECK (quote_provider IN ('IBKR','SAXO')),
  quote_evidence_sha256 text NOT NULL CHECK (quote_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  max_notional_minor bigint NOT NULL CHECK (max_notional_minor BETWEEN 1 AND 999999999999),
  max_fee_minor bigint NOT NULL CHECK (max_fee_minor BETWEEN 0 AND 999999999999),
  quote_at timestamptz NOT NULL,
  quote_expires_at timestamptz NOT NULL,
  FOREIGN KEY(worker_id,account_id) REFERENCES sharkai_broker.worker_binding(worker_id,account_id),
  FOREIGN KEY(account_id,instrument_asset_id) REFERENCES sharkai_broker.asset(account_id,id),
  CHECK (units BETWEEN minimum_units AND maximum_units AND units % nullif(quantity_step,0)=0),
  CHECK ((order_kind='LIMIT' AND limit_price_minor IS NOT NULL AND limit_price_minor % nullif(price_tick_minor,0)=0)
    OR (order_kind='MARKET' AND side='SELL' AND limit_price_minor IS NULL)),
  CHECK (side<>'SELL' OR provider_enforced_no_short),
  CHECK (side<>'BUY' OR max_notional_minor::numeric >= units::numeric*limit_price_minor::numeric),
  CHECK (quote_expires_at>quote_at AND quote_expires_at<=quote_at+interval '30 seconds')
);

CREATE TABLE sharkai_broker.worker_dispatch (
  worker_id text NOT NULL,
  nonce text NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{22,86}$'),
  job_id uuid NOT NULL UNIQUE REFERENCES sharkai_broker.worker_order(id),
  bound_user_id text NOT NULL,
  bound_provider text NOT NULL,
  bound_provider_account text NOT NULL,
  claimed_at timestamptz NOT NULL,
  last_polled_at timestamptz,
  PRIMARY KEY(worker_id,nonce)
);

CREATE FUNCTION sharkai_broker.immutable_worker_order() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Worker order terms are immutable. Issue a separate authorized job.';
END
$$;
CREATE TRIGGER immutable_worker_order BEFORE UPDATE ON sharkai_broker.worker_order
FOR EACH ROW EXECUTE FUNCTION sharkai_broker.immutable_worker_order();

CREATE FUNCTION sharkai_broker.worker_job_digest(j sharkai_broker.worker_order,a sharkai_broker.account,w sharkai_broker.worker_binding)
RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog SET TimeZone='UTC' AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(to_jsonb(j),a.user_id,a.provider,a.provider_key,
      w.credential_ref,w.credential_sha256,w.verified_saxo_client_key)::text,'UTF8')),'hex')
$$;

-- No provider token or report bytes are stored here.
CREATE FUNCTION sharkai_broker.read_worker_job(p_worker text,p_job uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
  SELECT jsonb_build_object(
    'job',to_jsonb(j),'job_digest',sharkai_broker.worker_job_digest(j,a,w),
    'broker',a.provider,'provider_account_key',a.provider_key,'credential_ref',w.credential_ref,
    'credential_sha256',w.credential_sha256,
    'credential_expires_at',to_char(w.credential_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'state',o.state,'provider_order',o.provider_order_id,'saxo_client',w.verified_saxo_client_key
  )
  FROM sharkai_broker.worker_order j
  JOIN sharkai_broker.worker_binding w ON w.worker_id=j.worker_id AND w.account_id=j.account_id
  JOIN sharkai_broker.account a ON a.id=j.account_id
  LEFT JOIN sharkai_broker.order_ledger o ON o.account_id=a.id AND o.request_key='worker:'||j.id::text
  WHERE j.id=p_job AND j.worker_id=p_worker AND w.revoked_at IS NULL
    AND w.approved_until>statement_timestamp() AND w.credential_scope_approved_at<=statement_timestamp()
$body$;

CREATE FUNCTION sharkai_broker.claim_worker_job(
  p_worker text,p_job uuid,p_nonce text,p_job_digest text,p_credential_digest text,p_client_ref text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE
  j sharkai_broker.worker_order%ROWTYPE;
  w sharkai_broker.worker_binding%ROWTYPE;
  a sharkai_broker.account%ROWTYPE;
  existing sharkai_broker.worker_dispatch%ROWTYPE;
  current_order sharkai_broker.order_ledger%ROWTYPE;
  verified_at timestamptz;
  reservation jsonb;
  pending_fees numeric;
BEGIN
  IF p_worker IS NULL OR p_worker !~ '^[A-Za-z0-9_-]{1,64}$' OR p_job IS NULL OR p_nonce IS NULL
      OR p_nonce !~ '^[A-Za-z0-9_-]{22,86}$' OR p_job_digest IS NULL OR p_credential_digest IS NULL
      OR p_client_ref IS NULL OR p_client_ref !~ '^shark-[0-9a-f]{40}$' THEN
    RETURN jsonb_build_object('status','blocked','code','INVALID_JOB');
  END IF;
  SELECT * INTO j FROM sharkai_broker.worker_order WHERE id=p_job AND worker_id=p_worker FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','blocked','code','JOB_NOT_AVAILABLE');
  END IF;
  SELECT * INTO a FROM sharkai_broker.account WHERE id=j.account_id;
  IF NOT FOUND OR NOT sharkai_broker.owner_can_trade(a.user_id) THEN
    RETURN jsonb_build_object('status','blocked','code','STOPPED');
  END IF;
  SELECT * INTO a FROM sharkai_broker.account WHERE id=j.account_id AND user_id=a.user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','code','JOB_NOT_AVAILABLE'); END IF;
  SELECT * INTO w FROM sharkai_broker.worker_binding WHERE worker_id=p_worker AND account_id=a.id FOR SHARE;
  verified_at := clock_timestamp();
  IF NOT FOUND OR w.revoked_at IS NOT NULL OR w.approved_until<=verified_at OR w.credential_scope_approved_at>verified_at
      OR w.credential_expires_at<=verified_at+interval '5 seconds' OR w.credential_sha256<>p_credential_digest
      OR p_job_digest IS DISTINCT FROM sharkai_broker.worker_job_digest(j,a,w) THEN
    RETURN jsonb_build_object('status','blocked','code','CREDENTIAL_NOT_AUTHORIZED');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sharkai_broker.nonce:'||p_worker||':'||p_nonce,0));
  SELECT * INTO existing FROM sharkai_broker.worker_dispatch WHERE worker_id=p_worker AND nonce=p_nonce;
  IF FOUND AND existing.job_id<>p_job THEN RETURN jsonb_build_object('status','blocked','code','REPLAY_CONFLICT'); END IF;
  SELECT * INTO current_order FROM sharkai_broker.order_ledger WHERE account_id=a.id AND request_key='worker:'||j.id::text;
  IF FOUND THEN RETURN jsonb_build_object('status','replayed','state',current_order.state); END IF;
  SELECT coalesce(sum(other.max_fee_minor),0) INTO pending_fees FROM sharkai_broker.worker_order other
    JOIN sharkai_broker.order_ledger o ON o.account_id=other.account_id AND o.request_key='worker:'||other.id::text
    WHERE other.account_id=a.id AND o.reconciliation_required;
  IF pending_fees+j.max_fee_minor>9223372036854775807 THEN
    RETURN jsonb_build_object('status','blocked','code','CAPITAL_LIMIT');
  END IF;
  IF NOT a.live_enabled OR a.revoked_at IS NOT NULL OR a.halted_at IS NOT NULL OR a.consent_revoked_at IS NOT NULL
      OR a.consent_version IS DISTINCT FROM j.consent_version OR a.currency<>j.currency OR a.provider<>j.quote_provider
      OR a.snapshot_id IS DISTINCT FROM j.snapshot_id OR j.quote_at>verified_at OR j.quote_expires_at<=verified_at+interval '1 second'
      OR NOT sharkai_broker.job_sources_current(j.id)
      OR NOT sharkai_broker.mandate_allows_job(a.id,j.consent_version,j.instrument_asset_id,j.snapshot_id,j.side,
        (pending_fees+j.max_fee_minor)::bigint)
      OR NOT EXISTS (
        SELECT 1 FROM sharkai_broker.asset x WHERE x.account_id=a.id AND x.id=j.instrument_asset_id AND x.enabled
          AND x.broker_instrument_id=j.instrument_provider_id AND x.reconciled_snapshot_id=j.snapshot_id
      ) THEN RETURN jsonb_build_object('status','blocked','code','JOB_APPROVAL_NOT_CURRENT'); END IF;

  reservation := sharkai_broker.reserve_order(a.user_id,a.id,'worker:'||j.id::text,p_client_ref,j.instrument_asset_id,
    j.instrument_provider_id,j.side,j.order_kind,j.units,j.limit_price_minor,
    CASE WHEN j.side='BUY' THEN j.max_notional_minor+j.max_fee_minor ELSE 0 END,j.consent_version,j.snapshot_id,
    j.quote_at,j.quote_expires_at);
  IF reservation->>'status' IS DISTINCT FROM 'reserved' THEN RETURN reservation; END IF;
  IF NOT sharkai_broker.claim_submission(a.id,'worker:'||j.id::text,j.snapshot_id) THEN
    RETURN jsonb_build_object('status','blocked','code','RECHECK_REQUIRED');
  END IF;
  INSERT INTO sharkai_broker.worker_dispatch(worker_id,nonce,job_id,claimed_at,bound_user_id,bound_provider,bound_provider_account)
    VALUES(p_worker,p_nonce,p_job,verified_at,a.user_id,a.provider,a.provider_key);
  RETURN jsonb_build_object('status','claimed','client_reference',p_client_ref);
END
$body$;

-- Revoking a trading mandate prevents submissions. Evidence polling can continue with an approved read scope.
CREATE FUNCTION sharkai_broker.begin_worker_poll(p_worker text,p_job uuid,p_nonce text,p_digest text,p_credential text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
BEGIN
  UPDATE sharkai_broker.worker_dispatch d SET last_polled_at=clock_timestamp()
    FROM sharkai_broker.worker_order j JOIN sharkai_broker.account a ON a.id=j.account_id
    JOIN sharkai_broker.worker_binding w ON w.account_id=a.id AND w.worker_id=j.worker_id
    JOIN sharkai_broker.order_ledger o ON o.account_id=a.id AND o.request_key='worker:'||j.id::text
    WHERE d.job_id=j.id AND d.worker_id=p_worker AND j.worker_id=p_worker AND j.id=p_job AND d.nonce=p_nonce
      AND (a.user_id,a.provider,a.provider_key)=(d.bound_user_id,d.bound_provider,d.bound_provider_account)
      AND w.revoked_at IS NULL AND w.credential_sha256=p_credential
      AND w.credential_scope_approved_at<=clock_timestamp() AND w.credential_expires_at>clock_timestamp()+interval '5 seconds'
      AND w.approved_until>clock_timestamp() AND a.ownership_verified_at<=clock_timestamp()
      AND sharkai_broker.worker_job_digest(j,a,w)=p_digest AND o.provider_order_id IS NOT NULL
      AND o.state IN ('ACKNOWLEDGED','UNKNOWN','PENDING','WORKING','PARTIALLY_FILLED','CANCEL_PENDING')
      AND (d.last_polled_at IS NULL OR d.last_polled_at<=clock_timestamp()-interval '2 seconds');
  RETURN FOUND;
END
$body$;

CREATE FUNCTION sharkai_broker.record_worker_receipt(
  p_worker text,p_job uuid,p_nonce text,p_receipt text,p_provider_order text,p_correlation text,
  p_state text,p_filled bigint,p_observed timestamptz
) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $body$
  SELECT sharkai_broker.record_receipt(j.account_id,'worker:'||j.id::text,a.provider,a.provider_key,
    j.instrument_provider_id,j.side,p_receipt,p_provider_order,p_correlation,p_state,p_filled,p_observed)
  FROM sharkai_broker.worker_dispatch d
  JOIN sharkai_broker.worker_order j ON j.id=d.job_id AND j.worker_id=d.worker_id
  JOIN sharkai_broker.account a ON a.id=j.account_id
  WHERE d.worker_id=p_worker AND d.nonce=p_nonce AND j.id=p_job
    AND (a.user_id,a.provider,a.provider_key)=(d.bound_user_id,d.bound_provider,d.bound_provider_account)
$body$;

-- Each runner selects only its currently actionable jobs. Batches are bounded; atomic claims handle overlap.
CREATE FUNCTION sharkai_broker.list_worker_actions(p_worker text,p_submit boolean)
RETURNS TABLE(job_id uuid,operation text,dispatch_nonce text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
  SELECT j.id,CASE WHEN d.job_id IS NULL THEN 'submit' ELSE 'poll' END,d.nonce
    FROM sharkai_broker.worker_order j JOIN sharkai_broker.worker_binding w ON w.worker_id=j.worker_id AND w.account_id=j.account_id
    JOIN sharkai_broker.account a ON a.id=j.account_id
    LEFT JOIN sharkai_broker.worker_dispatch d ON d.job_id=j.id AND d.worker_id=j.worker_id
    LEFT JOIN sharkai_broker.order_ledger o ON o.account_id=j.account_id AND o.request_key='worker:'||j.id::text
    WHERE j.worker_id=p_worker AND w.revoked_at IS NULL AND w.approved_until>statement_timestamp()
      AND w.credential_expires_at>statement_timestamp()+interval '5 seconds' AND w.credential_scope_approved_at<=statement_timestamp()
      AND ((p_submit AND d.job_id IS NULL AND o.request_key IS NULL AND a.live_enabled AND a.halted_at IS NULL AND a.revoked_at IS NULL
        AND a.consent_version=j.consent_version AND a.snapshot_id=j.snapshot_id AND j.quote_at<=statement_timestamp()
        AND j.quote_expires_at>statement_timestamp()+interval '1 second')
      OR (d.job_id IS NOT NULL AND o.provider_order_id IS NOT NULL
        AND o.state IN ('ACKNOWLEDGED','UNKNOWN','PENDING','WORKING','PARTIALLY_FILLED','CANCEL_PENDING')
        AND (d.last_polled_at IS NULL OR d.last_polled_at<=statement_timestamp()-interval '2 seconds')))
    ORDER BY CASE WHEN d.job_id IS NULL THEN 0 ELSE 1 END,COALESCE(d.last_polled_at,j.quote_at) LIMIT 16
$body$;
CREATE INDEX worker_jobs_due ON sharkai_broker.worker_order(worker_id,quote_expires_at);
CREATE INDEX worker_dispatch_last_poll ON sharkai_broker.worker_dispatch(worker_id,last_polled_at);

REVOKE ALL ON sharkai_broker.worker_binding,sharkai_broker.worker_order,sharkai_broker.worker_dispatch FROM PUBLIC;
REVOKE ALL ON FUNCTION sharkai_broker.list_worker_actions(text,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION sharkai_broker.read_worker_job(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION sharkai_broker.immutable_worker_order() FROM PUBLIC;
REVOKE ALL ON FUNCTION sharkai_broker.worker_job_digest(sharkai_broker.worker_order,sharkai_broker.account,sharkai_broker.worker_binding) FROM PUBLIC;
REVOKE ALL ON FUNCTION sharkai_broker.begin_worker_poll(text,uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sharkai_broker.claim_worker_job(text,uuid,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sharkai_broker.record_worker_receipt(text,uuid,text,text,text,text,text,bigint,timestamptz) FROM PUBLIC;
COMMIT;
