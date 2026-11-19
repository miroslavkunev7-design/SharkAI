-- Private application records for orders and reconciliation. Provider approval is required to enable an account.
-- No role grants, connection, provider secrets or enabled account rows are installed here.
BEGIN;

CREATE SCHEMA IF NOT EXISTS sharkai_broker;
REVOKE ALL ON SCHEMA sharkai_broker FROM PUBLIC;

-- An operator must link the exact WalletInvestmentSettings relation in this database.
-- No registration is equivalent to disabled trading. A regclass cannot point at a remote DB.
CREATE TABLE sharkai_broker.owner_application (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  settings_table regclass NOT NULL
);

CREATE TABLE sharkai_broker.owner_trade_revocation (
  user_id text PRIMARY KEY,
  revoked_at timestamptz NOT NULL
);

CREATE FUNCTION sharkai_broker.owner_can_trade(p_user text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE
  settings regclass;
  allowed boolean;
BEGIN
  IF p_user IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sharkai_broker.owner:' || p_user, 0));
  SELECT app.settings_table INTO settings
    FROM sharkai_broker.owner_application app JOIN pg_class c ON c.oid=app.settings_table
    WHERE app.singleton AND c.relname='WalletInvestmentSettings' AND c.relkind IN ('r','p');
  IF NOT FOUND OR EXISTS (SELECT 1 FROM sharkai_broker.owner_trade_revocation WHERE user_id=p_user) THEN
    RETURN false;
  END IF;
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %s WHERE "userId"=$1 AND "tradingConsentRevokedAt" IS NULL)',settings
  ) INTO allowed USING p_user;
  RETURN coalesce(allowed,false);
EXCEPTION WHEN undefined_table OR undefined_column OR insufficient_privilege THEN
  RETURN false;
END
$body$;

CREATE TABLE sharkai_broker.account (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('IBKR', 'SAXO')),
  provider_key text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  contractual_approval_at timestamptz,
  ownership_verified_at timestamptz,
  scope_verified_at timestamptz,
  revoked_at timestamptz,
  live_enabled boolean NOT NULL DEFAULT false,
  halted_at timestamptz,
  consent_version text,
  consent_expires_at timestamptz,
  consent_revoked_at timestamptz,
  consent_cap_minor bigint CHECK (consent_cap_minor > 0),
  entitlement_cap_minor bigint CHECK (entitlement_cap_minor > 0),
  target_state text NOT NULL DEFAULT 'UNKNOWN' CHECK (target_state IN ('NONE','PENDING','REACHED','UNKNOWN')),
  target_id text,
  target_window_start timestamptz,
  target_window_end timestamptz,
  target_checked_at timestamptz,
  snapshot_id text,
  snapshot_at timestamptz,
  exposure_minor bigint CHECK (exposure_minor >= 0),
  free_cash_minor bigint CHECK (free_cash_minor >= 0),
  reconciled boolean NOT NULL DEFAULT false,
  CHECK ((target_id IS NULL AND target_window_start IS NULL AND target_window_end IS NULL)
      OR (target_id IS NOT NULL AND target_window_start IS NOT NULL AND target_window_end IS NOT NULL
        AND target_window_start < target_window_end)),
  CHECK (target_state NOT IN ('PENDING','REACHED') OR (target_id IS NOT NULL AND target_checked_at IS NOT NULL)),
  UNIQUE (provider, provider_key)
);

CREATE TABLE sharkai_broker.asset (
  account_id text NOT NULL REFERENCES sharkai_broker.account(id),
  id text NOT NULL,
  broker_instrument_id bigint NOT NULL CHECK (broker_instrument_id > 0),
  held_units bigint NOT NULL CHECK (held_units >= 0),
  enabled boolean NOT NULL DEFAULT false,
  reconciled_snapshot_id text,
  PRIMARY KEY (account_id, id)
);

CREATE TABLE sharkai_broker.order_ledger (
  account_id text NOT NULL,
  request_key text NOT NULL,
  fingerprint text NOT NULL,
  user_id text NOT NULL,
  asset_id text NOT NULL,
  provider_instrument_id bigint NOT NULL CHECK (provider_instrument_id > 0),
  provider_order_id text CHECK (provider_order_id ~ '^[1-9][0-9]{0,17}$'),
  client_reference text NOT NULL CHECK (client_reference ~ '^shark-[0-9a-f]{40}$'),
  side text NOT NULL CHECK (side IN ('BUY','SELL')),
  kind text NOT NULL CHECK (kind IN ('LIMIT','MARKET')),
  units bigint NOT NULL CHECK (units > 0),
  price_minor bigint,
  debit_minor bigint NOT NULL CHECK (debit_minor >= 0 AND (side = 'BUY') = (debit_minor > 0)),
  consent_version text NOT NULL,
  quote_at timestamptz NOT NULL,
  quote_expires_at timestamptz NOT NULL,
  snapshot_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('RESERVED','SUBMITTING','ACKNOWLEDGED','PENDING','WORKING',
    'PARTIALLY_FILLED','CANCEL_PENDING','REVIEW_REQUIRED','FILLED','CANCELED','REJECTED','UNKNOWN','VOIDED')),
  filled_units bigint NOT NULL DEFAULT 0 CHECK (filled_units >= 0 AND filled_units <= units),
  provider_observed_at timestamptz,
  reconciliation_required boolean NOT NULL DEFAULT true,
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, request_key),
  FOREIGN KEY (account_id, asset_id) REFERENCES sharkai_broker.asset(account_id,id),
  UNIQUE (account_id, client_reference),
  UNIQUE (account_id, provider_order_id),
  CHECK (kind <> 'MARKET' OR side = 'SELL'),
  CHECK (((kind = 'LIMIT') AND price_minor > 0) OR ((kind = 'MARKET') AND price_minor IS NULL))
);
CREATE INDEX order_ledger_risk ON sharkai_broker.order_ledger(account_id) WHERE reconciliation_required;

CREATE TABLE sharkai_broker.receipt (
  account_id text NOT NULL,
  receipt_key text NOT NULL,
  request_key text NOT NULL,
  provider_order_id text,
  provider_correlation_id text,
  receipt_type text NOT NULL,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  filled_units bigint,
  PRIMARY KEY (account_id, receipt_key),
  FOREIGN KEY (account_id, request_key) REFERENCES sharkai_broker.order_ledger(account_id, request_key)
);

-- Caller is the server boundary, which verifies quote, fees, provider data and entitlement.
-- Browser/AI inputs cannot call this function. All competing reservations lock the same account.
CREATE FUNCTION sharkai_broker.reserve_order(
  p_user text, p_account text, p_req text, p_ref text, p_asset text, p_instrument bigint,
  p_side text, p_kind text, p_units bigint, p_price bigint, p_debit bigint, p_consent text,
  p_snapshot text, p_quote timestamptz, p_quote_expires timestamptz
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
DECLARE
  a sharkai_broker.account%ROWTYPE;
  o sharkai_broker.order_ledger%ROWTYPE;
  asset sharkai_broker.asset%ROWTYPE;
  t timestamptz;
  fp text;
  pending numeric;
BEGIN
  IF p_user IS NULL OR p_account IS NULL OR p_req IS NULL OR p_ref IS NULL OR p_asset IS NULL
      OR p_instrument IS NULL OR p_side IS NULL OR p_kind IS NULL OR p_units IS NULL OR p_debit IS NULL
      OR p_consent IS NULL OR p_snapshot IS NULL OR p_quote IS NULL OR p_quote_expires IS NULL
      OR p_req !~ '^[A-Za-z0-9_.:/-]{1,128}$' OR p_ref !~ '^shark-[0-9a-f]{40}$' OR p_instrument < 1
      OR p_side NOT IN ('BUY','SELL') OR p_kind NOT IN ('LIMIT','MARKET') OR p_units < 1
      OR (p_kind = 'LIMIT' AND (p_price IS NULL OR p_price < 1))
      OR (p_kind = 'MARKET' AND (p_price IS NOT NULL OR p_side <> 'SELL'))
      OR (p_side = 'BUY' AND p_debit::numeric < p_units::numeric * p_price::numeric)
      OR (p_side = 'SELL' AND p_debit <> 0) THEN
    RETURN jsonb_build_object('status','blocked','code','INVALID_ORDER');
  END IF;
  IF NOT sharkai_broker.owner_can_trade(p_user) THEN
    RETURN jsonb_build_object('status','blocked','code','STOPPED');
  END IF;
  SELECT * INTO a FROM sharkai_broker.account WHERE id = p_account AND user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','code','AUTHORIZATION_REQUIRED'); END IF;
  t := pg_catalog.clock_timestamp();
  UPDATE sharkai_broker.order_ledger SET state='VOIDED',changed_at=t,reconciliation_required=false
    WHERE account_id=p_account AND state='RESERVED' AND (quote_expires_at<=t OR quote_at<t-interval '30 seconds');
  fp := jsonb_build_array(p_account,p_asset,p_side,p_kind,p_units,p_price)::text;
  SELECT * INTO o FROM sharkai_broker.order_ledger WHERE account_id = p_account AND request_key = p_req;
  IF FOUND THEN
    IF o.fingerprint <> fp OR o.client_reference <> p_ref THEN
      RETURN jsonb_build_object('status','blocked','code','IDEMPOTENCY_CONFLICT');
    END IF;
    RETURN jsonb_build_object('status','replayed','state',o.state,'client_reference',o.client_reference);
  END IF;
  IF NOT a.live_enabled OR a.contractual_approval_at IS NULL THEN
    RETURN jsonb_build_object('status','blocked','code','LIVE_DISABLED');
  END IF;
  IF a.halted_at IS NOT NULL OR a.revoked_at IS NOT NULL OR a.consent_revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('status','blocked','code','STOPPED');
  END IF;
  IF a.ownership_verified_at IS NULL OR a.ownership_verified_at > t OR a.contractual_approval_at > t
      OR a.scope_verified_at IS NULL OR a.scope_verified_at > t
      OR a.consent_version IS DISTINCT FROM p_consent OR a.consent_expires_at IS NULL OR a.consent_expires_at <= t
      OR a.consent_cap_minor IS NULL OR a.entitlement_cap_minor IS NULL THEN
    RETURN jsonb_build_object('status','blocked','code','AUTHORIZATION_REQUIRED');
  END IF;
  IF NOT a.reconciled OR a.exposure_minor IS NULL OR a.free_cash_minor IS NULL
      OR a.snapshot_id IS DISTINCT FROM p_snapshot OR a.snapshot_at IS NULL
      OR a.snapshot_at > t OR a.snapshot_at < t - interval '2 minutes'
      OR EXISTS (SELECT 1 FROM sharkai_broker.order_ledger WHERE account_id = p_account AND
        state IN ('SUBMITTING','UNKNOWN','REVIEW_REQUIRED','FILLED','CANCELED','REJECTED') AND reconciliation_required) THEN
    RETURN jsonb_build_object('status','blocked','code','RECONCILIATION_REQUIRED');
  END IF;
  IF p_quote > t OR p_quote < t - interval '30 seconds' OR p_quote_expires <= t THEN
    RETURN jsonb_build_object('status','blocked','code','MARKET_DATA_UNAVAILABLE');
  END IF;
  IF a.target_state = 'REACHED' THEN RETURN jsonb_build_object('status','blocked','code','TARGET_REACHED'); END IF;
  IF a.target_state = 'UNKNOWN' OR (a.target_state = 'PENDING' AND (
      a.target_checked_at IS NULL OR a.target_checked_at > t OR a.target_checked_at < t - interval '2 minutes'
      OR t < a.target_window_start OR t >= a.target_window_end)) THEN
    RETURN jsonb_build_object('status','blocked','code','TARGET_UNVERIFIED');
  END IF;
  SELECT * INTO asset FROM sharkai_broker.asset WHERE account_id = p_account AND id = p_asset AND enabled;
  IF NOT FOUND OR asset.broker_instrument_id <> p_instrument THEN
    RETURN jsonb_build_object('status','blocked','code','UNSUPPORTED_ORDER');
  END IF;
  IF p_side = 'BUY' THEN
    SELECT coalesce(sum(debit_minor),0) INTO pending FROM sharkai_broker.order_ledger
      WHERE account_id = p_account AND reconciliation_required AND side = 'BUY';
    IF a.exposure_minor::numeric + pending + p_debit > least(a.consent_cap_minor,a.entitlement_cap_minor) THEN
      RETURN jsonb_build_object('status','blocked','code','CAPITAL_LIMIT');
    END IF;
    IF pending + p_debit > a.free_cash_minor THEN
      RETURN jsonb_build_object('status','blocked','code','INSUFFICIENT_FUNDS');
    END IF;
  ELSE
    SELECT coalesce(sum(units),0) INTO pending FROM sharkai_broker.order_ledger
      WHERE account_id = p_account AND asset_id = p_asset AND reconciliation_required AND side = 'SELL';
    IF pending + p_units > asset.held_units THEN
      RETURN jsonb_build_object('status','blocked','code','INSUFFICIENT_HELD_UNITS');
    END IF;
  END IF;
  INSERT INTO sharkai_broker.order_ledger (account_id,request_key,fingerprint,user_id,asset_id,provider_instrument_id,
    client_reference,side,kind,units,price_minor,debit_minor,consent_version,snapshot_id,quote_at,quote_expires_at,state,changed_at)
  VALUES (p_account,p_req,fp,p_user,p_asset,p_instrument,p_ref,p_side,p_kind,p_units,p_price,p_debit,p_consent,
    p_snapshot,p_quote,p_quote_expires,'RESERVED',t);
  RETURN jsonb_build_object('status','reserved','client_reference',p_ref);
END
$body$;

-- Atomic one-time claim. A crash/time-out after this point means uncertain, even if no reply arrived.
CREATE FUNCTION sharkai_broker.claim_submission(p_account text,p_req text,p_snapshot text)
RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
DECLARE
  a sharkai_broker.account%ROWTYPE;
  o sharkai_broker.order_ledger%ROWTYPE;
  t timestamptz;
  owner_id text;
BEGIN
  SELECT user_id INTO owner_id FROM sharkai_broker.account WHERE id=p_account;
  IF NOT sharkai_broker.owner_can_trade(owner_id) THEN RETURN false; END IF;
  SELECT * INTO a FROM sharkai_broker.account WHERE id=p_account AND user_id=owner_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO o FROM sharkai_broker.order_ledger WHERE account_id=p_account AND request_key=p_req FOR UPDATE;
  IF NOT FOUND OR o.state <> 'RESERVED' THEN RETURN false; END IF;
  t := pg_catalog.clock_timestamp();
  IF o.quote_expires_at <= t OR o.quote_at < t - interval '30 seconds' THEN
    UPDATE sharkai_broker.order_ledger SET state='VOIDED',changed_at=t,reconciliation_required=false
      WHERE account_id=p_account AND request_key=p_req;
    RETURN false;
  END IF;
  IF NOT a.live_enabled OR a.contractual_approval_at IS NULL OR a.contractual_approval_at > t OR a.revoked_at IS NOT NULL
      OR a.halted_at IS NOT NULL OR a.consent_revoked_at IS NOT NULL OR a.consent_version IS DISTINCT FROM o.consent_version
      OR a.ownership_verified_at IS NULL OR a.ownership_verified_at > t OR a.scope_verified_at IS NULL OR a.scope_verified_at > t
      OR a.consent_expires_at IS NULL OR a.consent_expires_at <= t OR a.consent_cap_minor IS NULL OR a.entitlement_cap_minor IS NULL
      OR NOT a.reconciled OR a.snapshot_id IS DISTINCT FROM p_snapshot OR o.snapshot_id IS DISTINCT FROM p_snapshot
      OR a.snapshot_at IS NULL OR a.snapshot_at > t OR a.snapshot_at < t - interval '2 minutes'
      OR o.quote_at > t OR o.quote_at < t - interval '30 seconds' OR o.quote_expires_at <= t
      OR a.target_state NOT IN ('NONE','PENDING') OR (a.target_state = 'PENDING' AND (
        a.target_checked_at IS NULL OR a.target_checked_at > t OR a.target_checked_at < t - interval '2 minutes'
        OR t < a.target_window_start OR t >= a.target_window_end))
      OR NOT EXISTS (SELECT 1 FROM sharkai_broker.asset WHERE account_id=p_account AND id=o.asset_id
        AND enabled AND broker_instrument_id=o.provider_instrument_id)
      OR EXISTS (SELECT 1 FROM sharkai_broker.order_ledger WHERE account_id=p_account AND
        state IN ('SUBMITTING','UNKNOWN','REVIEW_REQUIRED','FILLED','CANCELED','REJECTED') AND reconciliation_required) THEN
    RETURN false;
  END IF;
  IF o.side = 'BUY' AND (a.exposure_minor IS NULL OR a.free_cash_minor IS NULL OR
      (SELECT coalesce(sum(debit_minor),0) FROM sharkai_broker.order_ledger
       WHERE account_id=p_account AND reconciliation_required AND side='BUY') >
      least(a.free_cash_minor,least(a.consent_cap_minor,a.entitlement_cap_minor)::numeric-a.exposure_minor)) THEN
    RETURN false;
  END IF;
  IF o.side = 'SELL' AND
      (SELECT coalesce(sum(units),0) FROM sharkai_broker.order_ledger
       WHERE account_id=p_account AND reconciliation_required AND side='SELL' AND asset_id=o.asset_id) >
      (SELECT held_units FROM sharkai_broker.asset WHERE account_id=p_account AND id=o.asset_id) THEN
    RETURN false;
  END IF;
  UPDATE sharkai_broker.order_ledger SET state='SUBMITTING', changed_at=t WHERE account_id=p_account AND request_key=p_req;
  RETURN true;
END
$body$;

-- Only a trusted provider result parser can supply evidence. Absence/timeout is UNKNOWN and retains the reservation.
CREATE FUNCTION sharkai_broker.record_receipt(
  p_account text,p_req text,p_provider text,p_provider_key text,p_instrument bigint,p_side text,
  p_receipt text,p_order_id text,p_correlation text,p_state text,p_filled bigint,p_observed timestamptz
) RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
DECLARE
  o sharkai_broker.order_ledger%ROWTYPE;
  prior sharkai_broker.receipt%ROWTYPE;
  t timestamptz := pg_catalog.statement_timestamp();
BEGIN
  PERFORM 1 FROM sharkai_broker.account WHERE id=p_account AND provider=p_provider AND provider_key=p_provider_key FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unavailable'; END IF;
  SELECT * INTO o FROM sharkai_broker.order_ledger WHERE account_id=p_account AND request_key=p_req FOR UPDATE;
  IF NOT FOUND OR o.provider_instrument_id IS DISTINCT FROM p_instrument OR o.side IS DISTINCT FROM p_side THEN
    RETURN 'unavailable';
  END IF;
  IF p_receipt IS NULL OR p_receipt !~ '^[A-Za-z0-9_:.|/-]{1,128}$' OR p_observed IS NULL
      OR (p_correlation IS NOT NULL AND p_correlation !~ '^[A-Za-z0-9_.:=|/-]{1,128}$')
      OR p_observed > t OR p_state IS NULL OR p_state NOT IN ('ACKNOWLEDGED','PENDING','WORKING','PARTIALLY_FILLED',
      'CANCEL_PENDING','REVIEW_REQUIRED','FILLED','CANCELED','REJECTED','UNKNOWN') THEN RETURN 'invalid'; END IF;
  SELECT * INTO prior FROM sharkai_broker.receipt WHERE account_id=p_account AND receipt_key=p_receipt;
  IF FOUND THEN
    IF prior.request_key = p_req AND prior.provider_order_id IS NOT DISTINCT FROM p_order_id
        AND prior.provider_correlation_id IS NOT DISTINCT FROM p_correlation
        AND prior.receipt_type = p_state AND prior.filled_units IS NOT DISTINCT FROM p_filled THEN RETURN 'replayed'; END IF;
    RETURN 'conflict';
  END IF;
  IF p_observed < o.changed_at - interval '10 seconds' OR (o.provider_observed_at IS NOT NULL AND p_observed < o.provider_observed_at)
      OR o.state IN ('RESERVED','VOIDED','FILLED','CANCELED','REJECTED')
      OR (p_state IN ('ACKNOWLEDGED','REVIEW_REQUIRED','REJECTED') AND o.state <> 'SUBMITTING')
      OR (p_state = 'PENDING' AND o.state NOT IN ('SUBMITTING','ACKNOWLEDGED','PENDING','UNKNOWN'))
      OR (p_state = 'WORKING' AND o.state NOT IN ('SUBMITTING','ACKNOWLEDGED','PENDING','WORKING','UNKNOWN'))
      OR (p_state = 'PARTIALLY_FILLED' AND o.state = 'CANCEL_PENDING')
      OR (p_order_id IS NOT NULL AND p_order_id !~ '^[1-9][0-9]{0,17}$')
      OR (o.provider_order_id IS NOT NULL AND p_order_id IS NOT NULL AND o.provider_order_id <> p_order_id)
      OR (p_state <> 'ACKNOWLEDGED' AND p_order_id IS NOT NULL AND o.provider_order_id IS NULL
        AND NOT (p_provider='SAXO' AND p_state='UNKNOWN' AND o.state='SUBMITTING'))
      OR (p_state <> 'REVIEW_REQUIRED' AND p_correlation IS NOT NULL)
      OR (p_state IN ('ACKNOWLEDGED','PENDING','WORKING','PARTIALLY_FILLED','CANCEL_PENDING','FILLED','CANCELED')
        AND (p_order_id IS NULL OR p_filled IS NULL))
      OR (p_filled IS NOT NULL AND (p_filled < o.filled_units OR p_filled > o.units))
      OR (p_state = 'FILLED' AND p_filled <> o.units)
      OR (p_state = 'PARTIALLY_FILLED' AND (p_filled = 0 OR p_filled >= o.units))
      OR (p_state = 'CANCELED' AND p_filled >= o.units)
      OR (p_state IN ('ACKNOWLEDGED','PENDING','WORKING') AND p_filled <> 0)
      OR (p_state IN ('REVIEW_REQUIRED','REJECTED') AND (p_order_id IS NOT NULL OR coalesce(p_filled,0) <> 0)) THEN
    RETURN 'invalid';
  END IF;
  IF p_order_id IS NOT NULL AND EXISTS (SELECT 1 FROM sharkai_broker.order_ledger
      WHERE account_id=p_account AND provider_order_id=p_order_id AND request_key<>p_req) THEN RETURN 'conflict'; END IF;
  INSERT INTO sharkai_broker.receipt VALUES (p_account,p_receipt,p_req,p_order_id,p_correlation,p_state,p_observed,t,p_filled);
  UPDATE sharkai_broker.order_ledger SET state=p_state, changed_at=t, provider_observed_at=p_observed,
    provider_order_id=coalesce(p_order_id,provider_order_id), filled_units=coalesce(p_filled,filled_units)
    WHERE account_id=p_account AND request_key=p_req;
  RETURN 'recorded';
END
$body$;

-- Snapshot replacement and release of terminal reserves are one transaction. Caller attests that the
-- provider snapshot is complete, single-currency, owner-verified and incorporates each supplied order.
CREATE FUNCTION sharkai_broker.reconcile_snapshot(
  p_account text,p_provider text,p_provider_key text,p_snapshot text,p_at timestamptz,p_exposure bigint,p_cash bigint,
  p_assets jsonb,p_closed text[]
) RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
DECLARE
  a sharkai_broker.account%ROWTYPE;
  asset_record record;
  terminal record;
  t timestamptz := pg_catalog.clock_timestamp();
BEGIN
  SELECT * INTO a FROM sharkai_broker.account WHERE id=p_account AND provider=p_provider AND provider_key=p_provider_key FOR UPDATE;
  IF NOT FOUND OR a.ownership_verified_at IS NULL OR p_at IS NULL OR p_at>t OR p_at<t-interval '2 minutes'
      OR (a.snapshot_at IS NOT NULL AND p_at<=a.snapshot_at) OR p_snapshot IS NULL OR p_snapshot=a.snapshot_id
      OR p_exposure IS NULL OR p_exposure<0 OR p_cash IS NULL OR p_cash<0
      OR jsonb_typeof(p_assets) IS DISTINCT FROM 'object' OR p_closed IS NULL
      OR EXISTS (SELECT 1 FROM unnest(p_closed) k WHERE k IS NULL)
      OR EXISTS (SELECT 1 FROM sharkai_broker.asset WHERE account_id=p_account AND enabled
        AND NOT p_assets ? id) THEN RETURN false; END IF;
  FOR asset_record IN SELECT * FROM jsonb_each_text(p_assets) LOOP
    IF asset_record.value IS NULL OR asset_record.value !~ '^(0|[1-9][0-9]{0,14})$' OR NOT EXISTS (
      SELECT 1 FROM sharkai_broker.asset WHERE account_id=p_account AND id=asset_record.key) THEN RETURN false; END IF;
  END LOOP;
  FOR terminal IN SELECT distinct unnest(p_closed) as request_key LOOP
    IF NOT EXISTS (SELECT 1 FROM sharkai_broker.order_ledger WHERE account_id=p_account AND request_key=terminal.request_key
        AND state IN ('FILLED','CANCELED','REJECTED') AND provider_observed_at <= p_at) THEN RETURN false; END IF;
  END LOOP;
  UPDATE sharkai_broker.asset SET held_units=(p_assets->>id)::bigint,reconciled_snapshot_id=p_snapshot
    WHERE account_id=p_account AND p_assets ? id;
  UPDATE sharkai_broker.order_ledger SET reconciliation_required=false WHERE account_id=p_account AND request_key=ANY(p_closed);
  UPDATE sharkai_broker.account SET snapshot_id=p_snapshot,snapshot_at=p_at,exposure_minor=p_exposure,
    free_cash_minor=p_cash,reconciled=true WHERE id=p_account;
  RETURN true;
END
$body$;

-- A valid measured target hit is latched for the armed window. Reconfiguration is separate from measurements.
CREATE FUNCTION sharkai_broker.record_target_progress(
  p_account text,p_provider text,p_provider_key text,p_target text,p_at timestamptz,p_state text
) RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
DECLARE t timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('PENDING','REACHED') OR p_at IS NULL OR p_at>t OR p_at<t-interval '2 minutes'
      OR p_target IS NULL THEN RETURN false; END IF;
  UPDATE sharkai_broker.account SET target_state=p_state,target_checked_at=p_at
    WHERE id=p_account AND provider=p_provider AND provider_key=p_provider_key AND target_id=p_target
      AND p_at>=target_window_start AND p_at<target_window_end
      AND (target_checked_at IS NULL OR p_at>target_checked_at)
      AND (target_state IN ('PENDING','UNKNOWN') OR (target_state='REACHED' AND p_state='REACHED'));
  RETURN FOUND;
END
$body$;

-- Stop is immediate for unclaimed orders. In-flight or open orders are kept for authoritative reconciliation.
CREATE FUNCTION sharkai_broker.halt(p_user text,p_account text)
RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
DECLARE t timestamptz := pg_catalog.statement_timestamp();
BEGIN
  UPDATE sharkai_broker.account SET halted_at=coalesce(halted_at,t),live_enabled=false WHERE id=p_account AND user_id=p_user;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE sharkai_broker.order_ledger SET state='VOIDED',changed_at=t,reconciliation_required=false
    WHERE account_id=p_account AND state='RESERVED';
  RETURN true;
END
$body$;

-- Called from the app's revocation transaction before updating its settings row.
-- A claimed or provider-open order remains unchanged for authoritative reconciliation.
CREATE FUNCTION sharkai_broker.revoke_owner_trading(p_user text,p_settings regclass)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE
  settings regclass;
  t timestamptz;
BEGIN
  IF p_user IS NULL OR p_user='' OR p_settings IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sharkai_broker.owner:' || p_user, 0));
  SELECT settings_table INTO settings FROM sharkai_broker.owner_application WHERE singleton;
  IF FOUND AND settings IS DISTINCT FROM p_settings THEN RETURN false; END IF;
  t := clock_timestamp();
  INSERT INTO sharkai_broker.owner_trade_revocation(user_id,revoked_at) VALUES (p_user,t)
    ON CONFLICT (user_id) DO NOTHING;
  UPDATE sharkai_broker.account SET
    halted_at=coalesce(halted_at,t), live_enabled=false, consent_revoked_at=coalesce(consent_revoked_at,t)
    WHERE user_id=p_user;
  UPDATE sharkai_broker.order_ledger o SET state='VOIDED',changed_at=t,reconciliation_required=false
    FROM sharkai_broker.account a WHERE a.id=o.account_id AND a.user_id=p_user AND o.state='RESERVED';
  RETURN true;
END
$body$;

-- Bounded presentation for the authenticated owner. Provider keys and order identifiers stay private.
CREATE FUNCTION sharkai_broker.read_owner_state(p_user text,p_settings regclass)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $body$
  WITH linked AS (
    SELECT settings_table=p_settings AS exact
      FROM sharkai_broker.owner_application WHERE singleton
  ), eligible AS (
    SELECT a.id,a.provider,a.currency,a.halted_at,a.snapshot_id,a.snapshot_at,
      CASE
        WHEN NOT a.reconciled OR a.snapshot_id IS NULL OR a.snapshot_at IS NULL
          OR a.snapshot_at>statement_timestamp() OR EXISTS (SELECT 1 FROM sharkai_broker.asset p
            WHERE p.account_id=a.id AND p.enabled AND p.reconciled_snapshot_id IS DISTINCT FROM a.snapshot_id)
          THEN 'unavailable'
        WHEN a.snapshot_at<statement_timestamp()-interval '2 minutes' THEN 'stale'
        WHEN EXISTS (SELECT 1 FROM sharkai_broker.order_ledger o WHERE o.account_id=a.id
          AND o.reconciliation_required AND o.state<>'RESERVED') THEN 'pending'
        ELSE 'verified'
      END AS reconciliation
    FROM sharkai_broker.account a
    WHERE (SELECT exact FROM linked) AND a.user_id=p_user AND a.revoked_at IS NULL
      AND a.ownership_verified_at<=statement_timestamp() AND a.contractual_approval_at<=statement_timestamp()
      AND a.scope_verified_at<=statement_timestamp()
    ORDER BY a.id
    LIMIT 5
  ), summaries AS (
    SELECT a.id,jsonb_build_object(
      'provider',lower(a.provider),'currency',a.currency,
      'halted_at',to_char(a.halted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'reconciliation',a.reconciliation,
      'snapshot_at',CASE WHEN a.snapshot_at<=statement_timestamp()
        THEN to_char(a.snapshot_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
      'positions', CASE WHEN a.reconciliation='verified' THEN coalesce((
        SELECT jsonb_agg(jsonb_build_object('instrument',p.id,'units',p.held_units::text) ORDER BY p.id)
        FROM (SELECT id,held_units FROM sharkai_broker.asset
          WHERE account_id=a.id AND reconciled_snapshot_id=a.snapshot_id AND enabled AND held_units>0
          ORDER BY id LIMIT 20) p
      ),'[]'::jsonb) END,
      'recent_orders',coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'instrument',o.asset_id,'side',o.side,'status',o.state,'units',o.units::text,
          'filled_units',o.filled_units::text,'reconciliation_required',o.reconciliation_required,
          'recorded_at',to_char(o.changed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'provider_observed_at',CASE WHEN o.state IN ('ACKNOWLEDGED','PENDING','WORKING','PARTIALLY_FILLED',
            'CANCEL_PENDING','FILLED','CANCELED','REJECTED')
            THEN to_char(o.provider_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
        ) ORDER BY o.changed_at DESC,o.request_key)
        FROM (SELECT asset_id,side,state,units,filled_units,reconciliation_required,
          changed_at,provider_observed_at,request_key FROM sharkai_broker.order_ledger
          WHERE account_id=a.id AND user_id=p_user ORDER BY changed_at DESC,request_key LIMIT 10) o
      ),'[]'::jsonb)
    ) AS item FROM eligible a
  )
  SELECT jsonb_build_object(
    'status',CASE WHEN NOT EXISTS (SELECT 1 FROM linked) THEN 'provider_unconfigured'
      WHEN (SELECT exact FROM linked) IS DISTINCT FROM true THEN 'unavailable'
      WHEN NOT EXISTS (SELECT 1 FROM summaries) THEN 'provider_unlinked' ELSE 'available' END,
    'accounts',coalesce((SELECT jsonb_agg(item ORDER BY id) FROM summaries),'[]'::jsonb)
  )
$body$;

ALTER TABLE sharkai_broker.owner_application ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_broker.owner_trade_revocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_broker.account ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_broker.asset ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_broker.order_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_broker.receipt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA sharkai_broker FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sharkai_broker FROM PUBLIC;
COMMIT;
