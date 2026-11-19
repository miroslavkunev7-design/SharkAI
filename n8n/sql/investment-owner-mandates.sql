-- Apply after the private investment order ledger. This migration creates no policy, mandate, login or grant.
BEGIN;
CREATE TABLE sharkai_broker.mandate_policy (
  id uuid PRIMARY KEY,
  account_id text NOT NULL UNIQUE REFERENCES sharkai_broker.account(id),
  subscription_id text NOT NULL,
  plan text NOT NULL CHECK (plan IN ('PRO','ULTRA')),
  strategy_label text NOT NULL CHECK (length(strategy_label) BETWEEN 1 AND 100),
  allowed_assets text[] NOT NULL CHECK (cardinality(allowed_assets) BETWEEN 1 AND 64 AND array_position(allowed_assets,NULL) IS NULL),
  max_loss_minor bigint NOT NULL CHECK (max_loss_minor>0),
  max_positions integer NOT NULL CHECK (max_positions BETWEEN 1 AND 64),
  approval_ref text NOT NULL,
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at>approved_at),
  revoked_at timestamptz
);
ALTER TABLE sharkai_broker.account ADD COLUMN operator_halted_at timestamptz;
CREATE TABLE sharkai_broker.owner_mandate (
  version uuid PRIMARY KEY,
  policy_id uuid NOT NULL REFERENCES sharkai_broker.mandate_policy(id),
  account_id text NOT NULL REFERENCES sharkai_broker.account(id),
  user_id text NOT NULL,
  approved_terms jsonb NOT NULL,
  terms_digest text NOT NULL CHECK (terms_digest ~ '^[a-f0-9]{64}$'),
  accepted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  loss_stopped_at timestamptz
);
CREATE UNIQUE INDEX owner_single_open_mandate ON sharkai_broker.owner_mandate(user_id) WHERE revoked_at IS NULL;
CREATE TABLE sharkai_broker.mandate_risk_snapshot (
  version uuid NOT NULL REFERENCES sharkai_broker.owner_mandate(version),
  snapshot_id text NOT NULL,
  net_pnl_minor bigint NOT NULL,
  observed_at timestamptz NOT NULL,
  report_ref text NOT NULL,
  evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(version,snapshot_id)
);

-- Resolve identity and billing through the linked application's schema. Empty evidence yields no terms.
CREATE FUNCTION sharkai_broker.mandate_terms(p_user text,p_policy uuid,p_settings regclass)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE
  p sharkai_broker.mandate_policy;
  a sharkai_broker.account;
  app_schema name;
  prefs record;
  billing_end timestamptz;
  assets text[];
  t timestamptz := statement_timestamp();
BEGIN
  SELECT n.nspname INTO app_schema FROM sharkai_broker.owner_application x
    JOIN pg_class c ON c.oid=x.settings_table JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE x.singleton AND x.settings_table=p_settings AND c.relname='WalletInvestmentSettings';
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO p FROM sharkai_broker.mandate_policy
    WHERE id=p_policy AND approved_at<=t AND expires_at>t AND revoked_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO a FROM sharkai_broker.account WHERE id=p.account_id AND user_id=p_user
    AND revoked_at IS NULL AND operator_halted_at IS NULL AND (halted_at IS NULL OR halted_at=consent_revoked_at) AND contractual_approval_at<=t
    AND ownership_verified_at<=t AND scope_verified_at<=t AND entitlement_cap_minor>0;
  IF NOT FOUND THEN RETURN NULL; END IF;
  EXECUTE format('SELECT "currency","authorizedAmountMinor" cap,"instrumentCode" instrument,
    "strategyLabel" strategy,"targetPeriod"::text period,"targetDays" days,"targetStartDate"::text start_date,
    "targetAmountMinor" goal,"targetReturnBps" goal_bps FROM %s WHERE "userId"=$1',p_settings) INTO prefs USING p_user;
  IF prefs.cap IS NULL OR prefs.cap<=0 OR prefs.cap>a.entitlement_cap_minor
    OR prefs.currency IS DISTINCT FROM a.currency OR prefs.strategy IS DISTINCT FROM p.strategy_label
    OR prefs.instrument IS NULL OR NOT (prefs.instrument=ANY(p.allowed_assets))
    OR prefs.period IS NULL OR prefs.start_date IS NULL THEN RETURN NULL; END IF;
  EXECUTE format('SELECT "currentPeriodEnd" AT TIME ZONE ''UTC'' FROM %I."Subscription" WHERE id=$1 AND "userId"=$2
    AND plan::text=$3 AND status=''active'' AND "currentPeriodStart"<=(statement_timestamp() AT TIME ZONE ''UTC'')
    AND "currentPeriodEnd">(statement_timestamp() AT TIME ZONE ''UTC'')',app_schema)
    INTO billing_end USING p.subscription_id,p_user,p.plan;
  IF billing_end IS NULL THEN RETURN NULL; END IF;
  SELECT array_agg(id ORDER BY id) INTO assets FROM sharkai_broker.asset
    WHERE account_id=a.id AND id=prefs.instrument AND enabled;
  IF assets IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('policy_id',p.id,'provider',lower(a.provider),'plan',p.plan,'currency',a.currency,
    'capital_minor',prefs.cap::text,'max_loss_minor',least(p.max_loss_minor,prefs.cap)::text,
    'max_positions',least(p.max_positions,cardinality(assets)),'assets',assets,'strategy',p.strategy_label,
    'period',prefs.period,'days',prefs.days,'start_date',prefs.start_date,'goal_minor',prefs.goal::text,'goal_bps',prefs.goal_bps,
    'expires_at',to_char(least(p.expires_at,billing_end) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
EXCEPTION WHEN undefined_table OR undefined_column OR insufficient_privilege THEN RETURN NULL;
END
$body$;

CREATE FUNCTION sharkai_broker.mandate_review_digest(p_user text,p_settings regclass,p_terms jsonb)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE revision integer;
BEGIN
  IF p_terms IS NULL OR NOT EXISTS (SELECT 1 FROM sharkai_broker.owner_application WHERE settings_table=p_settings)
    THEN RETURN NULL; END IF;
  EXECUTE format('SELECT "accessRevision" FROM %s WHERE "userId"=$1',p_settings) INTO revision USING p_user;
  IF revision IS NULL THEN RETURN NULL; END IF;
  RETURN encode(sha256(convert_to(jsonb_build_array(p_terms,revision)::text,'UTF8')),'hex');
END
$body$;

CREATE FUNCTION sharkai_broker.owner_mandates(p_user text,p_settings regclass)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
  WITH current_m AS (
    SELECT m.approved_terms AS terms,m.accepted_at,a.halted_at,a.live_enabled,m.loss_stopped_at,
      coalesce(sharkai_broker.mandate_terms(p_user,m.policy_id,p_settings)=m.approved_terms,false) AS current_terms
      FROM sharkai_broker.owner_mandate m JOIN sharkai_broker.account a ON a.id=m.account_id
      WHERE m.user_id=p_user AND m.revoked_at IS NULL AND m.expires_at>statement_timestamp()
      AND a.consent_version=m.version::text AND a.consent_revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM sharkai_broker.owner_application WHERE settings_table=p_settings)
  ), offers AS (
    SELECT q.terms,sharkai_broker.mandate_review_digest(p_user,p_settings,q.terms) AS digest
      FROM sharkai_broker.mandate_policy p JOIN sharkai_broker.account a ON a.id=p.account_id
      CROSS JOIN LATERAL (SELECT sharkai_broker.mandate_terms(p_user,p.id,p_settings) AS terms) q
      WHERE a.user_id=p_user AND q.terms IS NOT NULL AND a.reconciled AND a.snapshot_id IS NOT NULL
      AND a.snapshot_at BETWEEN statement_timestamp()-interval '2 minutes' AND statement_timestamp()
      AND a.free_cash_minor >= (q.terms->>'capital_minor')::bigint AND a.exposure_minor=0
      AND NOT EXISTS (SELECT 1 FROM sharkai_broker.order_ledger o WHERE o.account_id=a.id AND o.reconciliation_required)
      ORDER BY p.id LIMIT 5
  )
  SELECT jsonb_build_object('active',(SELECT jsonb_build_object('terms',terms,'valid',
    current_terms AND live_enabled AND halted_at IS NULL AND loss_stopped_at IS NULL,'accepted_at',accepted_at) FROM current_m LIMIT 1),
    'offers',CASE WHEN EXISTS (SELECT 1 FROM current_m) THEN '[]'::jsonb ELSE coalesce((
      SELECT jsonb_agg(jsonb_build_object('terms',terms,'digest',digest)) FROM offers),'[]'::jsonb) END)
$body$;

CREATE FUNCTION sharkai_broker.accept_owner_mandate(p_user text,p_policy uuid,p_digest text,p_settings regclass,p_version uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE
  policy sharkai_broker.mandate_policy;
  selected_account sharkai_broker.account;
  terms jsonb;
  old sharkai_broker.owner_mandate;
  t timestamptz;
BEGIN
  IF p_user IS NULL OR p_policy IS NULL OR p_version IS NULL OR p_digest IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sharkai_broker.owner:'||p_user,0));
  SELECT * INTO policy FROM sharkai_broker.mandate_policy WHERE id=p_policy FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO selected_account FROM sharkai_broker.account WHERE id=policy.account_id AND user_id=p_user FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  terms:=sharkai_broker.mandate_terms(p_user,p_policy,p_settings);
  IF terms IS NULL OR p_digest IS DISTINCT FROM sharkai_broker.mandate_review_digest(p_user,p_settings,terms) THEN RETURN false; END IF;
  t:=clock_timestamp();
  SELECT * INTO old FROM sharkai_broker.owner_mandate WHERE user_id=p_user AND revoked_at IS NULL;
  IF FOUND AND old.expires_at>t THEN RETURN old.terms_digest=p_digest AND selected_account.consent_version=old.version::text
    AND selected_account.consent_revoked_at IS NULL AND selected_account.halted_at IS NULL; END IF;
  IF NOT selected_account.reconciled OR selected_account.snapshot_id IS NULL OR selected_account.snapshot_at IS NULL
    OR selected_account.snapshot_at>t OR selected_account.snapshot_at<t-interval '2 minutes'
    OR selected_account.free_cash_minor IS NULL OR selected_account.free_cash_minor<(terms->>'capital_minor')::bigint
    OR selected_account.exposure_minor IS DISTINCT FROM 0 OR selected_account.operator_halted_at IS NOT NULL
    OR EXISTS (SELECT 1 FROM sharkai_broker.order_ledger WHERE account_id=selected_account.id AND reconciliation_required)
    OR EXISTS (SELECT 1 FROM sharkai_broker.asset WHERE account_id=selected_account.id AND enabled
      AND (held_units<>0 OR reconciled_snapshot_id IS DISTINCT FROM selected_account.snapshot_id)) THEN RETURN false; END IF;
  UPDATE sharkai_broker.owner_mandate SET revoked_at=t WHERE user_id=p_user AND revoked_at IS NULL;
  INSERT INTO sharkai_broker.owner_mandate (version,policy_id,account_id,user_id,approved_terms,terms_digest,accepted_at,expires_at)
    VALUES(p_version,p_policy,selected_account.id,p_user,terms,p_digest,t,(terms->>'expires_at')::timestamptz);
  DELETE FROM sharkai_broker.owner_trade_revocation WHERE user_id=p_user;
  EXECUTE format('UPDATE %s SET "tradingConsentRevokedAt"=NULL,"accessRevision"="accessRevision"+1,
    "updatedAt"=clock_timestamp() AT TIME ZONE ''UTC'' WHERE "userId"=$1',p_settings) USING p_user;
  UPDATE sharkai_broker.account SET consent_version=p_version::text,consent_expires_at=(terms->>'expires_at')::timestamptz,
    consent_cap_minor=(terms->>'capital_minor')::bigint,consent_revoked_at=NULL,halted_at=NULL,live_enabled=true,
    target_state=CASE WHEN terms->>'goal_minor' IS NULL AND terms->>'goal_bps' IS NULL THEN 'NONE' ELSE 'UNKNOWN' END,
    target_id=NULL,target_window_start=NULL,target_window_end=NULL,target_checked_at=NULL WHERE id=selected_account.id;
  RETURN true;
END
$body$;

-- The worker additionally enforces quote, capital, cash, units, order state, and one-time dispatch.
CREATE FUNCTION sharkai_broker.mandate_allows_job(p_account text,p_consent text,p_asset text,p_snapshot text,p_side text,p_max_fee bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE
  m sharkai_broker.owner_mandate;
  a sharkai_broker.account;
  settings regclass;
  risk sharkai_broker.mandate_risk_snapshot;
  occupied integer;
  t timestamptz;
BEGIN
  IF p_side IS NULL OR p_side NOT IN ('BUY','SELL') OR p_max_fee IS NULL OR p_max_fee<0 THEN RETURN false; END IF;
  SELECT * INTO a FROM sharkai_broker.account WHERE id=p_account;
  IF NOT FOUND OR NOT sharkai_broker.owner_can_trade(a.user_id) THEN RETURN false; END IF;
  SELECT * INTO a FROM sharkai_broker.account WHERE id=p_account FOR UPDATE;
  SELECT * INTO m FROM sharkai_broker.owner_mandate WHERE version::text=p_consent AND account_id=p_account AND user_id=a.user_id;
  t:=clock_timestamp();
  IF NOT FOUND OR m.revoked_at IS NOT NULL OR m.loss_stopped_at IS NOT NULL OR m.expires_at<=t OR NOT a.live_enabled OR a.halted_at IS NOT NULL
    OR a.operator_halted_at IS NOT NULL OR a.revoked_at IS NOT NULL OR a.consent_revoked_at IS NOT NULL
    OR a.consent_version IS DISTINCT FROM p_consent OR a.snapshot_id IS DISTINCT FROM p_snapshot OR NOT a.reconciled
    OR a.snapshot_at IS NULL OR a.snapshot_at>t OR a.snapshot_at<t-interval '2 minutes'
    OR NOT coalesce((m.approved_terms->'assets') ? p_asset,false) THEN RETURN false; END IF;
  SELECT settings_table INTO settings FROM sharkai_broker.owner_application WHERE singleton;
  IF sharkai_broker.mandate_terms(a.user_id,m.policy_id,settings) IS DISTINCT FROM m.approved_terms THEN RETURN false; END IF;
  SELECT * INTO risk FROM sharkai_broker.mandate_risk_snapshot WHERE version=m.version AND snapshot_id=p_snapshot;
  IF NOT FOUND OR risk.observed_at<m.accepted_at OR risk.observed_at>t OR risk.observed_at<t-interval '2 minutes'
    OR risk.net_pnl_minor::numeric-p_max_fee<= -(m.approved_terms->>'max_loss_minor')::numeric THEN RETURN false; END IF;
  SELECT count(DISTINCT symbol) INTO occupied FROM (
    SELECT id AS symbol FROM sharkai_broker.asset WHERE account_id=p_account AND held_units>0
    UNION ALL SELECT asset_id FROM sharkai_broker.order_ledger WHERE account_id=p_account AND reconciliation_required AND side='BUY'
    UNION ALL SELECT p_asset WHERE p_side='BUY'
  ) positions;
  RETURN occupied<=(m.approved_terms->>'max_positions')::integer;
END
$body$;

-- Called by the approved read-side collector after reconciling broker equity, outside flows and all costs.
-- Two P/L amounts have different baselines: mandate acceptance and the current user-selected target window.
CREATE FUNCTION sharkai_broker.record_mandate_progress(p_account text,p_provider text,p_key text,p_version uuid,
  p_snapshot text,p_observed timestamptz,p_lifetime_net bigint,p_window_net bigint,p_window_start date,p_window_end date,
  p_report text,p_evidence text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE
  a sharkai_broker.account;
  m sharkai_broker.owner_mandate;
  t timestamptz:=clock_timestamp();
  days integer;
  start_date date;
  window_start date;
  window_end date;
  today date;
  periods integer;
  target numeric;
  state text;
BEGIN
  IF p_observed IS NULL OR p_observed>t OR p_observed<t-interval '2 minutes' OR p_lifetime_net IS NULL
    OR p_report IS NULL OR length(p_report) NOT BETWEEN 1 AND 160 OR p_evidence IS NULL OR p_evidence !~ '^[a-f0-9]{64}$'
    THEN RETURN false; END IF;
  SELECT * INTO a FROM sharkai_broker.account WHERE id=p_account AND provider=p_provider AND provider_key=p_key FOR UPDATE;
  IF NOT FOUND OR NOT a.reconciled OR a.snapshot_id IS DISTINCT FROM p_snapshot OR a.snapshot_at IS NULL
    OR p_observed<a.snapshot_at OR a.snapshot_at<t-interval '2 minutes' OR a.consent_version IS DISTINCT FROM p_version::text
    THEN RETURN false; END IF;
  SELECT * INTO m FROM sharkai_broker.owner_mandate WHERE version=p_version AND account_id=a.id FOR UPDATE;
  IF NOT FOUND OR m.revoked_at IS NOT NULL OR m.accepted_at>p_observed OR m.expires_at<=t THEN RETURN false; END IF;
  today:=(p_observed AT TIME ZONE 'UTC')::date;
  start_date:=(m.approved_terms->>'start_date')::date;
  IF today<start_date THEN RETURN false; END IF;
  IF m.approved_terms->>'period'='MONTH' THEN
    periods:=(extract(year FROM today)::integer-extract(year FROM start_date)::integer)*12
      + extract(month FROM today)::integer-extract(month FROM start_date)::integer;
    IF (start_date+make_interval(months=>periods))::date>today THEN periods:=periods-1; END IF;
    window_start:=(start_date+make_interval(months=>periods))::date;
    window_end:=(start_date+make_interval(months=>periods+1))::date;
  ELSE
    days:=CASE m.approved_terms->>'period' WHEN 'DAY' THEN 1 WHEN 'WEEK' THEN 7 WHEN 'CUSTOM_DAYS' THEN (m.approved_terms->>'days')::integer END;
    IF days IS NULL OR days<1 THEN RETURN false; END IF;
    window_start:=start_date+((today-start_date)/days)*days;
    window_end:=window_start+days;
  END IF;
  IF window_start IS DISTINCT FROM p_window_start OR window_end IS DISTINCT FROM p_window_end OR p_window_net IS NULL THEN RETURN false; END IF;
  target:=coalesce((m.approved_terms->>'goal_minor')::numeric,
    ceil((m.approved_terms->>'capital_minor')::numeric*(m.approved_terms->>'goal_bps')::numeric/10000));
  state:=CASE WHEN target IS NULL THEN 'NONE' WHEN p_window_net>=target THEN 'REACHED' ELSE 'PENDING' END;
  IF a.target_window_start=window_start::timestamp AT TIME ZONE 'UTC' AND a.target_state='REACHED' THEN state:='REACHED'; END IF;
  INSERT INTO sharkai_broker.mandate_risk_snapshot VALUES(p_version,p_snapshot,p_lifetime_net,p_observed,p_report,p_evidence)
    ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_lifetime_net<= -(m.approved_terms->>'max_loss_minor')::bigint THEN
    UPDATE sharkai_broker.owner_mandate SET loss_stopped_at=coalesce(loss_stopped_at,p_observed) WHERE version=m.version;
  END IF;
  UPDATE sharkai_broker.account SET target_id=CASE WHEN target IS NOT NULL THEN m.version::text||':'||window_start::text END,
    target_window_start=CASE WHEN target IS NOT NULL THEN window_start::timestamp AT TIME ZONE 'UTC' END,
    target_window_end=CASE WHEN target IS NOT NULL THEN window_end::timestamp AT TIME ZONE 'UTC' END,
    target_state=state,target_checked_at=p_observed WHERE id=a.id;
  RETURN true;
END
$body$;

CREATE FUNCTION sharkai_broker.close_revoked_mandates() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN
  UPDATE sharkai_broker.owner_mandate SET revoked_at=NEW.revoked_at WHERE user_id=NEW.user_id AND revoked_at IS NULL;
  RETURN NEW;
END
$body$;
CREATE TRIGGER close_owner_mandates AFTER INSERT OR UPDATE OF revoked_at ON sharkai_broker.owner_trade_revocation
  FOR EACH ROW EXECUTE FUNCTION sharkai_broker.close_revoked_mandates();
CREATE OR REPLACE FUNCTION sharkai_broker.halt(p_user text,p_account text)
RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
DECLARE t timestamptz:=statement_timestamp();
BEGIN
  UPDATE sharkai_broker.account SET halted_at=coalesce(halted_at,t),operator_halted_at=coalesce(operator_halted_at,t),live_enabled=false
    WHERE id=p_account AND user_id=p_user;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE sharkai_broker.order_ledger SET state='VOIDED',changed_at=t,reconciliation_required=false WHERE account_id=p_account AND state='RESERVED';
  RETURN true;
END
$body$;
ALTER TABLE sharkai_broker.mandate_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_broker.owner_mandate ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_broker.mandate_risk_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA sharkai_broker FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sharkai_broker FROM PUBLIC;
COMMIT;
