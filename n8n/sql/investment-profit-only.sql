-- Apply after forecast sources, owner mandates, worker approvals and strategy intake.
-- No rights, contracts, instruments or money are provisioned by this migration.
BEGIN;
ALTER TABLE sharkai_broker.account ADD COLUMN profit_allocation_revision bigint NOT NULL DEFAULT 0;
CREATE TABLE sharkai_broker.profit_protection_policy (
  id uuid PRIMARY KEY,
  user_id text NOT NULL UNIQUE,
  account_id text NOT NULL UNIQUE REFERENCES sharkai_broker.account(id),
  protected_custody_ref text NOT NULL UNIQUE CHECK(length(protected_custody_ref) BETWEEN 1 AND 128),
  profit_lineage_ref text NOT NULL UNIQUE CHECK(length(profit_lineage_ref) BETWEEN 1 AND 128),
  provider_contract_sha256 text NOT NULL UNIQUE CHECK(provider_contract_sha256 ~ '^[a-f0-9]{64}$'),
  worker_id text NOT NULL,
  credential_sha256 text NOT NULL CHECK(credential_sha256 ~ '^[a-f0-9]{64}$'),
  independent_collector text NOT NULL CHECK(independent_collector ~ '^[A-Za-z0-9_-]{1,64}$' AND independent_collector<>worker_id),
  approved_at timestamptz NOT NULL, expires_at timestamptz NOT NULL CHECK(expires_at>approved_at), revoked_at timestamptz,
  -- Each attestation is reviewed against the specific broker/custodian agreement and credential permissions.
  profit_account_segregated boolean NOT NULL CHECK(profit_account_segregated),
  no_principal_access_or_recourse boolean NOT NULL CHECK(no_principal_access_or_recourse),
  no_margin_overdraft_or_fx_debit boolean NOT NULL CHECK(no_margin_overdraft_or_fx_debit),
  no_transfer_pledge_or_setoff boolean NOT NULL CHECK(no_transfer_pledge_or_setoff),
  bounded_all_in_liability boolean NOT NULL CHECK(bounded_all_in_liability),
  FOREIGN KEY(worker_id,account_id) REFERENCES sharkai_broker.worker_binding(worker_id,account_id)
);
CREATE TABLE sharkai_broker.profit_protected_instrument (
  policy_id uuid NOT NULL REFERENCES sharkai_broker.profit_protection_policy(id),
  asset_id text NOT NULL,
  provider_instrument_id bigint NOT NULL CHECK(provider_instrument_id>0),
  kind text NOT NULL CHECK(kind IN ('STOCK','ETF')),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  cash_fully_paid_unleveraged boolean NOT NULL CHECK(cash_fully_paid_unleveraged),
  limited_liability_no_capital_calls boolean NOT NULL CHECK(limited_liability_no_capital_calls),
  broker_enforced_fee_bound boolean NOT NULL CHECK(broker_enforced_fee_bound),
  instrument_contract_sha256 text NOT NULL CHECK(instrument_contract_sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(policy_id,asset_id)
);
CREATE TABLE sharkai_broker.profit_evidence (
  policy_id uuid NOT NULL REFERENCES sharkai_broker.profit_protection_policy(id),
  policy_digest text NOT NULL CHECK(policy_digest ~ '^[a-f0-9]{64}$'),
  snapshot_id text NOT NULL, observed_at timestamptz NOT NULL,
  packet_digest text NOT NULL CHECK(packet_digest ~ '^[a-f0-9]{64}$'),
  report_ref text NOT NULL CHECK(length(report_ref) BETWEEN 1 AND 128),
  evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  protected_principal_minor bigint NOT NULL CHECK(protected_principal_minor>=0),
  gross_settled_gains_minor bigint NOT NULL CHECK(gross_settled_gains_minor>=0),
  gross_settled_losses_minor bigint NOT NULL CHECK(gross_settled_losses_minor>=0),
  total_costs_minor bigint NOT NULL CHECK(total_costs_minor>=0),
  distributed_minor bigint NOT NULL CHECK(distributed_minor>=0),
  open_cost_basis_minor bigint NOT NULL CHECK(open_cost_basis_minor>=0),
  unrealized_loss_minor bigint NOT NULL CHECK(unrealized_loss_minor>=0),
  segregated_profit_cash_minor bigint NOT NULL CHECK(segregated_profit_cash_minor>=0),
  mandate_closeout_minor bigint NOT NULL,period_closeout_minor bigint NOT NULL,
  PRIMARY KEY(policy_id,snapshot_id), UNIQUE(policy_id,observed_at), UNIQUE(policy_id,report_ref)
);
CREATE FUNCTION sharkai_broker.keep_profit_lineage() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
BEGIN
 IF ROW(NEW.id,NEW.account_id,NEW.user_id,NEW.protected_custody_ref,NEW.profit_lineage_ref)
   IS DISTINCT FROM ROW(OLD.id,OLD.account_id,OLD.user_id,OLD.protected_custody_ref,OLD.profit_lineage_ref)
   OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
   OR (ROW(NEW.worker_id,NEW.credential_sha256,NEW.independent_collector,NEW.expires_at) IS DISTINCT FROM
      ROW(OLD.worker_id,OLD.credential_sha256,OLD.independent_collector,OLD.expires_at) AND NEW.provider_contract_sha256=OLD.provider_contract_sha256)
 THEN RAISE EXCEPTION USING ERRCODE='P0301',MESSAGE='Profit protection lineage or unreviewed policy change'; END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER keep_profit_lineage BEFORE UPDATE ON sharkai_broker.profit_protection_policy FOR EACH ROW EXECUTE FUNCTION sharkai_broker.keep_profit_lineage();
-- Bind the signed net result to the owner's actual current mandate and exact recurring UTC window,
-- including mandates with no numeric profit target.
CREATE TABLE sharkai_broker.profit_risk_window (
  version uuid NOT NULL,snapshot_id text NOT NULL,start_date date NOT NULL,end_date date NOT NULL CHECK(end_date>start_date),
  window_net_minor bigint NOT NULL,PRIMARY KEY(version,snapshot_id),
  FOREIGN KEY(version,snapshot_id) REFERENCES sharkai_broker.mandate_risk_snapshot(version,snapshot_id)
);
ALTER FUNCTION sharkai_broker.record_mandate_progress(text,text,text,uuid,text,timestamptz,bigint,bigint,date,date,text,text)
  RENAME TO record_mandate_progress_before_profit_policy;
CREATE FUNCTION sharkai_broker.record_mandate_progress(p_account text,p_provider text,p_key text,p_version uuid,
  p_snapshot text,p_observed timestamptz,p_lifetime_net bigint,p_window_net bigint,p_window_start date,p_window_end date,p_report text,p_evidence text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF NOT sharkai_broker.record_mandate_progress_before_profit_policy(p_account,p_provider,p_key,p_version,p_snapshot,p_observed,
     p_lifetime_net,p_window_net,p_window_start,p_window_end,p_report,p_evidence) THEN RETURN false; END IF;
 INSERT INTO sharkai_broker.profit_risk_window VALUES(p_version,p_snapshot,p_window_start,p_window_end,p_window_net);
 RETURN true;
END $f$;
CREATE FUNCTION sharkai_broker.accept_profit_evidence(p_collector text,p_packet jsonb,p_digest text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE
  p sharkai_broker.profit_protection_policy;
  a sharkai_broker.account;
  prior sharkai_broker.profit_evidence; r sharkai_broker.profit_evidence;
  observed timestamptz:=(p_packet->>'observed_at')::timestamptz;
  snapshot text:=p_packet->>'snapshot_id';
BEGIN
  IF p_digest IS NULL OR p_digest!~'^[a-f0-9]{64}$' OR snapshot IS NULL OR snapshot!~'^[A-Za-z0-9_.:-]{1,128}$'
      OR observed IS NULL OR observed NOT BETWEEN clock_timestamp()-interval '2 minutes' AND clock_timestamp() THEN RETURN 'invalid'; END IF;
  SELECT * INTO p FROM sharkai_broker.profit_protection_policy WHERE id=(p_packet->>'policy_id')::uuid
    AND provider_contract_sha256=p_packet->>'policy_digest' AND independent_collector=p_collector
    AND revoked_at IS NULL AND approved_at<=observed AND expires_at>clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RETURN 'forbidden'; END IF;
  SELECT * INTO a FROM sharkai_broker.account WHERE id=p.account_id AND user_id=p.user_id AND provider=p_packet->>'provider'
    AND provider_key=p_packet->>'provider_account_key' AND currency=p_packet->>'currency' AND revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT a.reconciled OR a.snapshot_id IS DISTINCT FROM snapshot
    OR NOT EXISTS (SELECT 1 FROM sharkai_broker.verified_account_snapshot s WHERE s.account_id=a.id AND s.snapshot_id=snapshot AND s.observed_at=observed)
    OR EXISTS (SELECT 1 FROM sharkai_broker.strategy_source s WHERE s.account_id=a.id
      AND (s.signal_collector=p_collector OR s.quote_collector=p_collector OR s.worker_id=p_collector)) THEN RETURN 'forbidden'; END IF;
  SELECT * INTO prior FROM sharkai_broker.profit_evidence WHERE policy_id=p.id AND snapshot_id=snapshot;
  IF FOUND THEN RETURN CASE WHEN prior.packet_digest=p_digest THEN 'replayed' ELSE 'conflict' END; END IF;
  SELECT * INTO r FROM jsonb_populate_record(NULL::sharkai_broker.profit_evidence,p_packet);
  r.policy_id:=p.id; r.snapshot_id:=snapshot; r.observed_at:=observed; r.packet_digest:=p_digest;
  SELECT * INTO prior FROM sharkai_broker.profit_evidence WHERE policy_id=p.id ORDER BY observed_at DESC LIMIT 1;
  IF FOUND AND (observed<=prior.observed_at OR r.gross_settled_gains_minor<prior.gross_settled_gains_minor
      OR r.gross_settled_losses_minor<prior.gross_settled_losses_minor OR r.total_costs_minor<prior.total_costs_minor
      OR r.distributed_minor<prior.distributed_minor) THEN RETURN 'invalid'; END IF;
  IF r.segregated_profit_cash_minor>a.free_cash_minor OR r.open_cost_basis_minor=0
      AND EXISTS (SELECT 1 FROM sharkai_broker.asset WHERE account_id=a.id AND held_units>0) THEN RETURN 'invalid'; END IF;
  INSERT INTO sharkai_broker.profit_evidence SELECT r.*;
  RETURN 'recorded';
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range
  OR check_violation OR not_null_violation OR unique_violation THEN RETURN 'invalid';
END $f$;

-- A reservation subtracts its worst debit or SELL fee until an authenticated terminal reconciliation.
CREATE FUNCTION sharkai_broker.profit_fee_reserve(p_user text,p_account text,p_currency text,p_net numeric,p_gross bigint)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE hold bigint;
BEGIN
 IF to_regprocedure('sharkai_broker.performance_fee_hold(text,text,text,bigint)') IS NOT NULL THEN
   EXECUTE 'SELECT sharkai_broker.performance_fee_hold($1,$2,$3,$4)' INTO hold USING p_user,p_account,p_currency,greatest(p_net,0)::bigint;
 END IF;
 RETURN CASE WHEN hold>=0 THEN hold ELSE ceil(p_gross::numeric/10)::bigint END;
END $f$;
CREATE FUNCTION sharkai_broker.profit_capacity(p_user text,p_account text,p_except text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT jsonb_build_object('status','verified','currency',a.currency,'observed_at',r.observed_at,
   'protected_principal_minor',r.protected_principal_minor::text,'settled_realized_profit_minor',calc.net::text,
   'unrealized_loss_minor',r.unrealized_loss_minor::text,'policy_id',p.id,'policy_digest',p.provider_contract_sha256,
   'closeout_nonnegative',status.can_buy,
   'exposed_minor',(r.open_cost_basis_minor::numeric+pending.debit)::text,
   'performance_fee_hold_minor',fee.held::text,
   'remaining_cash_minor',greatest(0::numeric,least(r.segregated_profit_cash_minor,a.free_cash_minor)::numeric-pending.debit-fee.held)::text,
   'available_profit_minor',CASE WHEN NOT status.can_buy THEN '0'
      ELSE greatest(0::numeric,least(least(r.segregated_profit_cash_minor,a.free_cash_minor)::numeric,
        calc.net-r.distributed_minor-r.unrealized_loss_minor-greatest(r.open_cost_basis_minor,a.exposure_minor))
        -pending.debit-fee.held)::text END)
 FROM sharkai_broker.account a JOIN sharkai_broker.profit_protection_policy p ON p.account_id=a.id AND p.user_id=a.user_id
 JOIN sharkai_broker.profit_evidence r ON r.policy_id=p.id AND r.policy_digest=p.provider_contract_sha256 AND r.snapshot_id=a.snapshot_id
 JOIN sharkai_broker.verified_account_snapshot s ON s.account_id=a.id AND s.snapshot_id=a.snapshot_id AND s.observed_at=r.observed_at
 JOIN sharkai_broker.worker_binding w ON w.account_id=a.id AND w.worker_id=p.worker_id AND w.credential_sha256=p.credential_sha256
 CROSS JOIN LATERAL (SELECT r.gross_settled_gains_minor::numeric-r.gross_settled_losses_minor-r.total_costs_minor AS net) calc
 CROSS JOIN LATERAL (SELECT sharkai_broker.profit_fee_reserve(a.user_id,a.id,a.currency,calc.net,r.gross_settled_gains_minor) AS held) fee
 CROSS JOIN LATERAL (SELECT r.mandate_closeout_minor>=0 AND r.period_closeout_minor>=0 AND NOT EXISTS(
   SELECT 1 FROM sharkai_broker.owner_mandate m WHERE m.account_id=a.id AND m.user_id=a.user_id AND m.version::text=a.consent_version
     AND m.revoked_at IS NULL AND m.expires_at>clock_timestamp() AND NOT EXISTS(
       SELECT 1 FROM sharkai_broker.mandate_risk_snapshot rs JOIN sharkai_broker.profit_risk_window rw USING(version,snapshot_id)
       WHERE rs.version=m.version AND rs.snapshot_id=a.snapshot_id AND rs.net_pnl_minor>=0 AND rw.window_net_minor>=0
         AND (clock_timestamp() AT TIME ZONE 'UTC')::date>=rw.start_date AND (clock_timestamp() AT TIME ZONE 'UTC')::date<rw.end_date)) AS can_buy) status
 CROSS JOIN LATERAL (SELECT coalesce(sum(CASE WHEN o.side='BUY' THEN o.debit_minor ELSE coalesce(j.max_fee_minor,9223372036854775807) END),0) AS debit
   FROM sharkai_broker.order_ledger o LEFT JOIN sharkai_broker.worker_order j ON j.account_id=o.account_id AND o.request_key='worker:'||j.id::text
   WHERE o.account_id=a.id AND o.reconciliation_required AND o.request_key IS DISTINCT FROM p_except) pending
 WHERE a.id=p_account AND a.user_id=p_user AND a.reconciled AND a.revoked_at IS NULL AND a.free_cash_minor IS NOT NULL AND a.exposure_minor IS NOT NULL
   AND a.snapshot_at=r.observed_at AND r.observed_at BETWEEN statement_timestamp()-interval '2 minutes' AND clock_timestamp()
   AND p.approved_at<=r.observed_at AND p.expires_at>clock_timestamp() AND p.revoked_at IS NULL
   AND w.revoked_at IS NULL AND w.credential_scope_approved_at<=clock_timestamp()
   AND least(w.credential_expires_at,w.approved_until)>clock_timestamp()
   AND p.protected_custody_ref<>a.provider_key AND p.profit_lineage_ref<>a.provider_key
   AND NOT EXISTS (SELECT 1 FROM sharkai_broker.account ap JOIN sharkai_broker.worker_binding wp ON wp.account_id=ap.id
     WHERE ap.provider_key=p.protected_custody_ref AND wp.revoked_at IS NULL AND wp.credential_expires_at>clock_timestamp())
$f$;

CREATE FUNCTION sharkai_broker.owner_profit_budget(p_user text,p_forecast_binding text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT coalesce((SELECT sharkai_broker.profit_capacity(p_user,a.id)-ARRAY['policy_id','policy_digest','closeout_nonnegative','exposed_minor','remaining_cash_minor']
   FROM sharkai_forecast.binding f JOIN sharkai_broker.account a ON a.provider_key=f.account_key AND lower(a.provider)=f.provider
     AND a.user_id=f.user_id AND a.currency=f.currency
   WHERE f.id=p_forecast_binding AND f.user_id=p_user AND f.revoked_at IS NULL AND f.expires_at>clock_timestamp()
     AND f.ownership_verified_at<=clock_timestamp() AND f.strategy_isolation_verified_at<=clock_timestamp() AND f.provider_read_approved_at<=clock_timestamp()),
   jsonb_build_object('status','unverified','currency',null,'protected_principal_minor',null,'settled_realized_profit_minor',null,
     'unrealized_loss_minor',null,'performance_fee_hold_minor',null,'available_profit_minor','0','observed_at',null))
$f$;

-- Reuse already verified billing, strategy, currency, time window and expiry. Terms include a versioned
-- protection contract and consequently invalidate every mandate signed before this migration.
ALTER FUNCTION sharkai_broker.mandate_terms(text,uuid,regclass) RENAME TO mandate_terms_before_profit_policy;
CREATE FUNCTION sharkai_broker.mandate_terms(p_user text,p_policy uuid,p_settings regclass)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE base jsonb; cap jsonb; acct text;
BEGIN
  base:=sharkai_broker.mandate_terms_before_profit_policy(p_user,p_policy,p_settings);
  IF base IS NULL THEN RETURN NULL; END IF;
  SELECT account_id INTO acct FROM sharkai_broker.mandate_policy WHERE id=p_policy;
  cap:=sharkai_broker.profit_capacity(p_user,acct);
  IF NOT EXISTS (SELECT 1 FROM sharkai_broker.owner_mandate m WHERE m.user_id=p_user AND m.account_id=acct
    AND m.revoked_at IS NULL AND m.expires_at>clock_timestamp()
    AND m.approved_terms->>'protection_policy_id'=cap->>'policy_id')
    AND (base->>'capital_minor')::numeric>(cap->>'available_profit_minor')::numeric THEN RETURN NULL; END IF;
  IF cap IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(base->'assets') t(asset)
     WHERE NOT EXISTS(SELECT 1 FROM sharkai_broker.profit_protected_instrument approved
       JOIN sharkai_broker.asset actual ON actual.account_id=acct AND actual.id=approved.asset_id AND actual.broker_instrument_id=approved.provider_instrument_id
       WHERE approved.policy_id=(cap->>'policy_id')::uuid AND approved.asset_id=t.asset AND approved.currency=base->>'currency')) THEN RETURN NULL; END IF;
  RETURN base||jsonb_build_object('capital_source','verified_settled_realized_profit_only','protection_policy_id',cap->'policy_id','protection_digest',cap->'policy_digest','performance_fee_bps',1000);
END $f$;
CREATE FUNCTION sharkai_broker.check_profit_consent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE cap jsonb;
BEGIN
  PERFORM 1 FROM sharkai_broker.account WHERE id=NEW.account_id AND user_id=NEW.user_id FOR UPDATE;
  cap:=sharkai_broker.profit_capacity(NEW.user_id,NEW.account_id);
  IF cap IS NULL OR NEW.approved_terms->>'capital_source' IS DISTINCT FROM 'verified_settled_realized_profit_only'
     OR NEW.approved_terms->>'protection_policy_id' IS DISTINCT FROM cap->>'policy_id'
     OR NEW.approved_terms->>'protection_digest' IS DISTINCT FROM cap->>'policy_digest'
     OR (NEW.approved_terms->>'capital_minor')::numeric>(cap->>'available_profit_minor')::numeric THEN
    RAISE EXCEPTION USING ERRCODE='P0301',MESSAGE='Insufficient verified profit capital'; END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER check_profit_consent BEFORE INSERT ON sharkai_broker.owner_mandate FOR EACH ROW EXECUTE FUNCTION sharkai_broker.check_profit_consent();

CREATE FUNCTION sharkai_broker.owner_profit_verified(p_user text,p_collectors text[] DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT EXISTS(SELECT 1 FROM sharkai_broker.profit_protection_policy p WHERE p.user_id=p_user
   AND (p_collectors IS NULL OR p.independent_collector=ANY(p_collectors))
   AND sharkai_broker.profit_capacity(p_user,p.account_id) IS NOT NULL)
$f$;

CREATE FUNCTION sharkai_broker.profit_order_allowed(o sharkai_broker.order_ledger) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE
 a sharkai_broker.account; m sharkai_broker.owner_mandate; j sharkai_broker.worker_order; p sharkai_broker.profit_protection_policy;
 cap jsonb; settings regclass; risk bigint; reserved_units numeric; held bigint;
BEGIN
 SELECT * INTO a FROM sharkai_broker.account WHERE id=o.account_id AND user_id=o.user_id FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO p FROM sharkai_broker.profit_protection_policy WHERE account_id=a.id AND user_id=o.user_id FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO j FROM sharkai_broker.worker_order WHERE account_id=a.id AND 'worker:'||id::text=o.request_key AND worker_id=p.worker_id;
 IF NOT FOUND OR j.snapshot_id<>o.snapshot_id OR a.snapshot_id IS DISTINCT FROM o.snapshot_id OR j.side<>o.side OR j.order_kind<>'LIMIT'
   OR o.kind<>j.order_kind OR o.provider_instrument_id<>j.instrument_provider_id OR j.instrument_asset_id<>o.asset_id
   OR o.price_minor IS DISTINCT FROM j.limit_price_minor OR o.units<>j.units OR o.consent_version<>j.consent_version
   OR o.quote_at<>j.quote_at OR o.quote_expires_at<>j.quote_expires_at OR o.debit_minor IS DISTINCT FROM
     (CASE WHEN o.side='BUY' THEN j.max_notional_minor+j.max_fee_minor ELSE 0 END)
   OR NOT sharkai_broker.job_sources_current(j.id) THEN RETURN false; END IF;
 cap:=sharkai_broker.profit_capacity(o.user_id,a.id,o.request_key);
 IF cap IS NULL OR NOT EXISTS(SELECT 1 FROM sharkai_broker.profit_protected_instrument i WHERE i.policy_id=p.id
   AND i.asset_id=j.instrument_asset_id AND i.provider_instrument_id=j.instrument_provider_id AND i.kind=j.instrument_kind
   AND i.currency=j.currency) THEN RETURN false; END IF;
 SELECT * INTO m FROM sharkai_broker.owner_mandate WHERE version::text=o.consent_version AND account_id=a.id AND user_id=o.user_id
   AND revoked_at IS NULL AND loss_stopped_at IS NULL AND expires_at>clock_timestamp();
 IF NOT FOUND OR m.approved_terms->>'protection_policy_id' IS DISTINCT FROM p.id::text
   OR m.approved_terms->>'protection_digest' IS DISTINCT FROM p.provider_contract_sha256
   OR m.approved_terms->>'capital_source' IS DISTINCT FROM 'verified_settled_realized_profit_only' THEN RETURN false; END IF;
 SELECT settings_table INTO settings FROM sharkai_broker.owner_application WHERE singleton;
 IF sharkai_broker.mandate_terms(o.user_id,m.policy_id,settings) IS DISTINCT FROM m.approved_terms
    OR NOT sharkai_broker.mandate_allows_job(a.id,o.consent_version,o.asset_id,o.snapshot_id,o.side,j.max_fee_minor) THEN RETURN false; END IF;
 SELECT net_pnl_minor INTO risk FROM sharkai_broker.mandate_risk_snapshot WHERE version=m.version AND snapshot_id=o.snapshot_id;
 IF NOT FOUND THEN RETURN false; END IF;
 IF o.side='BUY' THEN
   RETURN (cap->>'closeout_nonnegative')::boolean AND risk>=0 AND o.debit_minor<=(cap->>'available_profit_minor')::numeric
     AND o.debit_minor+(cap->>'exposed_minor')::numeric<=(m.approved_terms->>'max_loss_minor')::numeric;
 END IF;
 SELECT x.held_units INTO held FROM sharkai_broker.asset x WHERE x.account_id=a.id AND x.id=o.asset_id
   AND x.reconciled_snapshot_id=o.snapshot_id AND x.enabled;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT coalesce(sum(other.units),0) INTO reserved_units FROM sharkai_broker.order_ledger other WHERE other.account_id=a.id AND other.asset_id=o.asset_id
   AND other.side='SELL' AND other.reconciliation_required AND other.request_key<>o.request_key;
 RETURN j.provider_enforced_no_short AND o.units+reserved_units<=held AND
   (j.max_fee_minor<=(cap->>'remaining_cash_minor')::numeric OR j.max_fee_minor<=o.units::numeric*o.price_minor);
END $f$;
CREATE FUNCTION sharkai_broker.enforce_profit_order() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF NOT sharkai_broker.profit_order_allowed(NEW) THEN
   RAISE EXCEPTION USING ERRCODE='P0301',MESSAGE='Profit-only capital protection'; END IF;
 -- Write the locked account as well as the order. REPEATABLE READ callers with an obsolete
 -- snapshot then receive a serialization error instead of allocating the same profits twice.
 UPDATE sharkai_broker.account SET profit_allocation_revision=profit_allocation_revision+1 WHERE id=NEW.account_id;
 RETURN NEW;
END $f$;
CREATE TRIGGER protect_every_new_order BEFORE INSERT ON sharkai_broker.order_ledger
  FOR EACH ROW EXECUTE FUNCTION sharkai_broker.enforce_profit_order();
CREATE TRIGGER protect_every_submission BEFORE UPDATE OF state ON sharkai_broker.order_ledger
  FOR EACH ROW WHEN(NEW.state='SUBMITTING' AND OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION sharkai_broker.enforce_profit_order();

CREATE FUNCTION sharkai_broker.claim_profit_only_job(p_worker text,p_job uuid,p_nonce text,p_job_digest text,p_credential_digest text,p_client_ref text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
  RETURN sharkai_broker.claim_worker_job(p_worker,p_job,p_nonce,p_job_digest,p_credential_digest,p_client_ref);
EXCEPTION WHEN SQLSTATE 'P0301' THEN RETURN jsonb_build_object('status','blocked','code','PROFIT_CAPITAL_UNVERIFIED');
END $f$;

ALTER FUNCTION sharkai_broker.owner_worker_status(text) RENAME TO owner_worker_status_before_profit_policy;
CREATE FUNCTION sharkai_broker.owner_worker_status(p_user text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT sharkai_broker.owner_worker_status_before_profit_policy(p_user) AND EXISTS(
  SELECT 1 FROM sharkai_broker.profit_protection_policy p WHERE p.user_id=p_user
   AND (sharkai_broker.profit_capacity(p_user,p.account_id)->>'available_profit_minor')::numeric>0)
$f$;
ALTER FUNCTION sharkai_broker.diagnostic_worker_binding(text,jsonb) RENAME TO diagnostic_worker_before_profit_policy;
CREATE FUNCTION sharkai_broker.diagnostic_worker_binding(p_owner text,p_keys jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT sharkai_broker.diagnostic_worker_before_profit_policy(p_owner,p_keys)
 AND sharkai_broker.owner_worker_status(p_owner)
 AND sharkai_broker.owner_profit_verified(p_owner,ARRAY(SELECT jsonb_array_elements_text(p_keys->'profits')))
$f$;
ALTER TABLE sharkai_broker.profit_protection_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_broker.profit_protected_instrument ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_broker.profit_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_broker.profit_risk_window ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sharkai_broker.profit_protection_policy,sharkai_broker.profit_protected_instrument,sharkai_broker.profit_evidence,sharkai_broker.profit_risk_window FROM PUBLIC;
REVOKE ALL ON FUNCTION sharkai_broker.accept_profit_evidence(text,jsonb,text),sharkai_broker.profit_capacity(text,text,text),
 sharkai_broker.profit_fee_reserve(text,text,text,numeric,bigint),
 sharkai_broker.keep_profit_lineage(),
 sharkai_broker.record_mandate_progress(text,text,text,uuid,text,timestamptz,bigint,bigint,date,date,text,text),
 sharkai_broker.owner_profit_budget(text,text),sharkai_broker.owner_profit_verified(text,text[]),sharkai_broker.profit_order_allowed(sharkai_broker.order_ledger),
 sharkai_broker.enforce_profit_order(),sharkai_broker.check_profit_consent(),sharkai_broker.claim_profit_only_job(text,uuid,text,text,text,text),
 sharkai_broker.owner_worker_status(text),sharkai_broker.diagnostic_worker_binding(text,jsonb),sharkai_broker.mandate_terms(text,uuid,regclass) FROM PUBLIC;
-- Preserve existing restricted application and service identities when replacing private APIs.
-- Fresh deployments have no such grants and remain off until roles are explicitly provisioned.
DO $grants$
DECLARE old_f regprocedure;new_f regprocedure;role_row record;
BEGIN
 FOR old_f,new_f IN VALUES
   ('sharkai_broker.owner_worker_status_before_profit_policy(text)'::regprocedure,'sharkai_broker.owner_worker_status(text)'::regprocedure),
   ('sharkai_broker.diagnostic_worker_before_profit_policy(text,jsonb)'::regprocedure,'sharkai_broker.diagnostic_worker_binding(text,jsonb)'::regprocedure),
   ('sharkai_broker.mandate_terms_before_profit_policy(text,uuid,regclass)'::regprocedure,'sharkai_broker.mandate_terms(text,uuid,regclass)'::regprocedure),
   ('sharkai_broker.record_mandate_progress_before_profit_policy(text,text,text,uuid,text,timestamptz,bigint,bigint,date,date,text,text)'::regprocedure,
    'sharkai_broker.record_mandate_progress(text,text,text,uuid,text,timestamptz,bigint,bigint,date,date,text,text)'::regprocedure),
   ('sharkai_broker.claim_worker_job(text,uuid,text,text,text,text)'::regprocedure,'sharkai_broker.claim_profit_only_job(text,uuid,text,text,text,text)'::regprocedure)
 LOOP
   FOR role_row IN SELECT DISTINCT r.rolname FROM pg_proc f CROSS JOIN LATERAL aclexplode(f.proacl) perms
     JOIN pg_roles r ON r.oid=perms.grantee WHERE f.oid=old_f AND perms.privilege_type='EXECUTE'
     AND perms.grantee<>f.proowner AND r.rolname NOT IN ('anon','authenticated') LOOP
     EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',new_f,role_row.rolname);
   END LOOP;
 END LOOP;
 FOR role_row IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
   EXECUTE format('REVOKE ALL ON SCHEMA sharkai_broker FROM %I',role_row.rolname);
   EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA sharkai_broker FROM %I',role_row.rolname);
   EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sharkai_broker FROM %I',role_row.rolname);
 END LOOP;
END $grants$;
COMMIT;
