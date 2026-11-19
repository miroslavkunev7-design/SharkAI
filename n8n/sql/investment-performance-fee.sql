-- Private application records of calculations and provider statements. The provider moves the money.
BEGIN;
CREATE TABLE sharkai_broker.fee_agreement (
  account_id text NOT NULL REFERENCES sharkai_broker.account(id),
  beneficiary_user_id text NOT NULL REFERENCES public."User"(id),
  beneficiary_account_hash text NOT NULL CHECK(beneficiary_account_hash ~ '^[a-f0-9]{64}$'),
  agreement_digest text PRIMARY KEY CHECK(agreement_digest ~ '^[a-f0-9]{64}$'),
  report_collector text NOT NULL CHECK(length(report_collector) BETWEEN 1 AND 64),
  credit_collector text NOT NULL CHECK(length(credit_collector) BETWEEN 1 AND 64 AND credit_collector<>report_collector),
  effective_at timestamptz NOT NULL, first_period_start date NOT NULL,
  expires_at timestamptz NOT NULL CHECK(expires_at>effective_at), revoked_at timestamptz,
  CHECK(first_period_start::timestamp AT TIME ZONE 'UTC'>=effective_at)
);
CREATE TABLE sharkai_broker.performance_fee_period (
  account_id text NOT NULL REFERENCES sharkai_broker.account(id),
  mandate_id uuid NOT NULL REFERENCES sharkai_broker.owner_mandate(version),
  starts_on date NOT NULL, ends_on date NOT NULL CHECK(ends_on>starts_on),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  opening_net bigint NOT NULL, closing_net bigint NOT NULL, closing_after_open_losses numeric NOT NULL,
  high_water bigint NOT NULL CHECK(high_water>=0),
  eligible_minor bigint NOT NULL CHECK(eligible_minor>=0),
  fee_minor bigint NOT NULL CHECK(fee_minor>=0),
  carry_tenths smallint NOT NULL CHECK(carry_tenths BETWEEN 0 AND 9),
  agreement_digest text NOT NULL REFERENCES sharkai_broker.fee_agreement(agreement_digest), beneficiary_hash text NOT NULL, beneficiary_user_id text NOT NULL,
  source_ref text NOT NULL, source_digest text NOT NULL,
  credited_at timestamptz, credit_ref text, credit_digest text,
  reversed_at timestamptz, reversal_ref text, reversal_digest text,
  PRIMARY KEY (account_id,ends_on),
  UNIQUE(account_id,source_ref), UNIQUE(account_id,credit_ref), UNIQUE(account_id,reversal_ref),
  CHECK ((credited_at IS NULL AND credit_ref IS NULL AND credit_digest IS NULL)
    OR (credited_at IS NOT NULL AND credit_ref IS NOT NULL AND credit_digest IS NOT NULL AND fee_minor>0)),
  CHECK ((reversed_at IS NULL AND reversal_ref IS NULL AND reversal_digest IS NULL)
    OR (reversed_at>=credited_at AND credited_at IS NOT NULL AND reversal_ref IS NOT NULL AND reversal_digest IS NOT NULL))
);
CREATE FUNCTION sharkai_broker.refresh_fee_capacity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $revision$
BEGIN
  UPDATE sharkai_broker.account SET profit_allocation_revision=profit_allocation_revision+1 WHERE id=NEW.account_id;
  RETURN NEW;
END $revision$;
CREATE TRIGGER refresh_fee_capacity AFTER INSERT OR UPDATE ON sharkai_broker.performance_fee_period
FOR EACH ROW EXECUTE FUNCTION sharkai_broker.refresh_fee_capacity();
ALTER TABLE sharkai_broker.fee_agreement ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_broker.performance_fee_period ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sharkai_broker.fee_agreement,sharkai_broker.performance_fee_period FROM PUBLIC,anon,authenticated;
CREATE FUNCTION sharkai_broker.freeze_fee_agreement() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $freeze$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at')
     OR OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'A signed fee beneficiary and billing agreement are immutable';
  END IF;
  RETURN NEW;
END $freeze$;
CREATE TRIGGER fixed_fee_agreement BEFORE UPDATE OR DELETE ON sharkai_broker.fee_agreement
FOR EACH ROW EXECUTE FUNCTION sharkai_broker.freeze_fee_agreement();
CREATE FUNCTION sharkai_broker.check_new_fee_term() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $term$
BEGIN
  PERFORM 1 FROM sharkai_broker.account WHERE id=NEW.account_id FOR UPDATE;
  IF EXISTS(SELECT FROM sharkai_broker.fee_agreement g WHERE g.account_id=NEW.account_id
    AND NEW.effective_at<least(g.expires_at,g.revoked_at) AND g.effective_at<least(NEW.expires_at,NEW.revoked_at)) THEN
    RAISE EXCEPTION 'Fee agreement overlaps an existing term';
  END IF;
  RETURN NEW;
END $term$;
CREATE TRIGGER nonoverlapping_fee_terms BEFORE INSERT ON sharkai_broker.fee_agreement
FOR EACH ROW EXECUTE FUNCTION sharkai_broker.check_new_fee_term();

CREATE FUNCTION sharkai_broker.fee_period_matches(terms jsonb, start_day date, end_day date) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $check$
DECLARE anchor date:=(terms->>'start_date')::date; stride integer; idx integer;
BEGIN
  IF anchor IS NULL OR start_day<anchor THEN RETURN false; END IF;
  IF terms->>'period'='MONTH' THEN
    idx:=(extract(year FROM start_day)::integer-extract(year FROM anchor)::integer)*12
      +extract(month FROM start_day)::integer-extract(month FROM anchor)::integer;
    RETURN start_day=(anchor+make_interval(months=>idx))::date AND end_day=(anchor+make_interval(months=>idx+1))::date;
  END IF;
  stride:=CASE terms->>'period' WHEN 'DAY' THEN 1 WHEN 'WEEK' THEN 7 WHEN 'CUSTOM_DAYS' THEN (terms->>'days')::integer ELSE 0 END;
  IF stride IS NULL OR stride<1 THEN RETURN false; END IF;
  RETURN mod(start_day-anchor,stride)=0 AND end_day-start_day=stride;
END $check$;

CREATE FUNCTION sharkai_broker.record_performance_fee(p_collector text,p jsonb,p_digest text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $record$
DECLARE
  a sharkai_broker.account; g sharkai_broker.fee_agreement; m sharkai_broker.owner_mandate;
  prev sharkai_broker.performance_fee_period; existing sharkai_broker.performance_fee_period;
  op text:=p->>'operation'; end_day date:=(p->>'period_end')::date; start_day date;
  opens bigint; closes bigint; eligible bigint; prior_mark bigint; economic_close numeric; tenths numeric; charge bigint; credit_time timestamptz;
BEGIN
  IF p_digest IS NULL OR p_digest!~'^[a-f0-9]{64}$' OR end_day IS NULL
    OR end_day>(clock_timestamp() AT TIME ZONE 'UTC')::date OR op NOT IN ('period','credit','reversal') THEN RETURN 'invalid'; END IF;
  SELECT * INTO g FROM sharkai_broker.fee_agreement WHERE agreement_digest=p->>'agreement_digest' FOR UPDATE;
  IF NOT FOUND THEN RETURN 'forbidden'; END IF;
  SELECT * INTO a FROM sharkai_broker.account WHERE id=g.account_id AND currency=p->>'currency' FOR UPDATE;
  IF NOT FOUND OR g.beneficiary_user_id=a.user_id OR NOT EXISTS (SELECT FROM public."User" WHERE id=g.beneficiary_user_id AND role::text='ADMIN') THEN RETURN 'forbidden'; END IF;
  IF (op='period' AND p_collector IS DISTINCT FROM g.report_collector)
     OR (op IN ('credit','reversal') AND p_collector IS DISTINCT FROM g.credit_collector) THEN RETURN 'forbidden'; END IF;
  SELECT * INTO existing FROM sharkai_broker.performance_fee_period WHERE account_id=a.id AND ends_on=end_day;
  IF FOUND AND existing.agreement_digest<>g.agreement_digest THEN RETURN 'conflict'; END IF;
  IF op='reversal' THEN
    IF NOT FOUND OR existing.credit_ref IS NULL THEN RETURN 'unmatched'; END IF;
    IF existing.reversal_ref IS NOT NULL THEN RETURN CASE WHEN existing.reversal_digest=p_digest THEN 'replayed' ELSE 'conflict' END; END IF;
    credit_time:=(p->>'posted_at')::timestamptz;
    IF p->>'posting' IS DISTINCT FROM 'provider_final_full_fee_reversal' OR p->>'original_credit_ref' IS DISTINCT FROM existing.credit_ref
      OR p->>'beneficiary_hash' IS DISTINCT FROM existing.beneficiary_hash OR (p->>'amount_minor')::bigint IS DISTINCT FROM existing.fee_minor
      OR credit_time IS NULL OR credit_time<existing.credited_at OR credit_time>clock_timestamp() THEN RETURN 'unmatched'; END IF;
    UPDATE sharkai_broker.performance_fee_period SET reversed_at=credit_time,reversal_ref=p->>'receipt_ref',reversal_digest=p_digest
      WHERE account_id=a.id AND ends_on=end_day;
    RETURN 'reversed';
  END IF;
  IF op='credit' THEN
    IF NOT FOUND THEN RETURN 'unmatched'; END IF;
    IF existing.credit_ref IS NOT NULL THEN RETURN CASE WHEN existing.credit_digest=p_digest THEN 'replayed' ELSE 'conflict' END; END IF;
    credit_time:=(p->>'posted_at')::timestamptz;
    IF p->>'posting' IS DISTINCT FROM 'provider_final_client_debit_and_beneficiary_credit'
      OR p->>'beneficiary_hash' IS DISTINCT FROM existing.beneficiary_hash
      OR p->>'debited_account_hash' IS DISTINCT FROM encode(sha256(convert_to(a.provider||'/'||a.provider_key,'UTF8')),'hex')
      OR p->>'debited_account_hash'=existing.beneficiary_hash OR existing.fee_minor<=0
      OR (p->>'amount_minor')::bigint IS DISTINCT FROM existing.fee_minor
      OR credit_time IS NULL OR credit_time<end_day::timestamp AT TIME ZONE 'UTC' OR credit_time>clock_timestamp()
      OR p->>'receipt_ref' IS NULL OR length(p->>'receipt_ref') NOT BETWEEN 1 AND 128 THEN RETURN 'unmatched'; END IF;
    UPDATE sharkai_broker.performance_fee_period SET credited_at=credit_time,credit_ref=p->>'receipt_ref',credit_digest=p_digest
      WHERE account_id=a.id AND ends_on=end_day;
    RETURN 'credited';
  END IF;
  IF FOUND THEN RETURN CASE WHEN existing.source_digest=p_digest THEN 'replayed' ELSE 'conflict' END; END IF;
  start_day:=(p->>'period_start')::date;
  SELECT * INTO m FROM sharkai_broker.owner_mandate WHERE version=(p->>'mandate_id')::uuid AND account_id=a.id AND user_id=a.user_id;
  IF NOT FOUND OR start_day IS NULL OR start_day>=end_day OR p->>'basis' IS DISTINCT FROM 'cumulative_settled_realized_after_all_costs_before_platform_fee_ex_flow'
    OR (m.approved_terms->>'performance_fee_bps') IS DISTINCT FROM '1000' OR (m.approved_terms->>'capital_source') IS DISTINCT FROM 'verified_settled_realized_profit_only'
    OR NOT sharkai_broker.fee_period_matches(m.approved_terms,start_day,end_day)
    OR start_day::timestamp AT TIME ZONE 'UTC'<greatest(m.accepted_at,g.effective_at)
    OR end_day::timestamp AT TIME ZONE 'UTC'>least(m.expires_at,g.expires_at,m.revoked_at,g.revoked_at)
    OR p->>'report_ref' IS NULL OR length(p->>'report_ref') NOT BETWEEN 1 AND 128 THEN RETURN 'forbidden'; END IF;
  opens:=(p->>'opening_net_minor')::bigint; closes:=(p->>'closing_net_minor')::bigint;
  IF opens IS NULL OR closes IS NULL THEN RETURN 'invalid'; END IF;
  SELECT * INTO prev FROM sharkai_broker.performance_fee_period WHERE account_id=a.id ORDER BY ends_on DESC LIMIT 1;
  IF (NOT FOUND OR prev.agreement_digest<>g.agreement_digest) AND start_day<>g.first_period_start THEN RETURN 'missing_period'; END IF;
  IF FOUND AND (start_day<prev.ends_on OR (start_day=prev.ends_on AND opens<>prev.closing_net)) THEN RETURN 'conflict'; END IF;
  -- After a gap, gains earned outside the mandate raise the mark and previous unrecovered losses carry forward.
  prior_mark:=CASE WHEN prev.ends_on=start_day THEN prev.high_water ELSE greatest(0,opens,prev.high_water) END;
  IF prev.ends_on IS NOT NULL AND start_day>prev.ends_on THEN
    IF m.version=prev.mandate_id AND g.agreement_digest=prev.agreement_digest THEN RETURN 'missing_period'; END IF;
    prior_mark:=greatest(prior_mark,opens+greatest(0,prev.high_water-prev.closing_after_open_losses));
  END IF;
  IF p->>'closing_unrealized_loss_minor' IS NULL OR (p->>'closing_unrealized_loss_minor')::bigint<0 THEN RETURN 'invalid'; END IF;
  economic_close:=closes::numeric-(p->>'closing_unrealized_loss_minor')::bigint;
  eligible:=greatest(0,economic_close-prior_mark);
  tenths:=eligible::numeric+coalesce(prev.carry_tenths,0);
  charge:=trunc(tenths/10)::bigint;
  INSERT INTO sharkai_broker.performance_fee_period(account_id,mandate_id,starts_on,ends_on,currency,opening_net,
    closing_net,closing_after_open_losses,high_water,eligible_minor,fee_minor,carry_tenths,agreement_digest,beneficiary_hash,beneficiary_user_id,source_ref,source_digest)
    VALUES(a.id,m.version,start_day,end_day,a.currency,opens,closes,economic_close,greatest(prior_mark,economic_close),eligible,charge,
      mod(tenths,10)::smallint,g.agreement_digest,g.beneficiary_account_hash,g.beneficiary_user_id,p->>'report_ref',p_digest);
  RETURN 'recorded';
EXCEPTION WHEN unique_violation THEN RETURN 'conflict';
  WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow OR invalid_datetime_format OR check_violation THEN RETURN 'invalid';
END $record$;

-- Includes unpaid periods and the potential additional charge on positive realized gains. Missing agreement keeps the full conservative hold.
CREATE OR REPLACE FUNCTION sharkai_broker.performance_fee_hold(p_user text,p_account text,p_currency text,p_positive_net_minor bigint)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $hold$
DECLARE outstanding numeric; mark bigint; remainder integer; possible numeric; covered date; next_due date;
  terms jsonb; anchor date; month_index integer; agreement sharkai_broker.fee_agreement;
BEGIN
  IF p_positive_net_minor IS NULL OR p_positive_net_minor<0 THEN RETURN NULL; END IF;
  SELECT g.* INTO agreement FROM sharkai_broker.fee_agreement g JOIN sharkai_broker.account a ON a.id=g.account_id
    WHERE a.id=p_account AND a.user_id=p_user AND a.currency=p_currency AND g.effective_at<=statement_timestamp()
      AND least(g.expires_at,g.revoked_at)>statement_timestamp();
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT m.approved_terms INTO terms FROM sharkai_broker.owner_mandate m WHERE m.account_id=p_account AND m.user_id=p_user
    AND m.accepted_at<=statement_timestamp() AND least(m.expires_at,m.revoked_at)>statement_timestamp()
    AND m.approved_terms->>'performance_fee_bps'='1000' ORDER BY m.accepted_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT max(ends_on) INTO covered FROM sharkai_broker.performance_fee_period WHERE agreement_digest=agreement.agreement_digest;
  covered:=coalesce(covered,agreement.first_period_start);
  IF terms->>'period'='MONTH' THEN
    anchor:=(terms->>'start_date')::date;
    month_index:=(extract(year FROM covered)::integer-extract(year FROM anchor)::integer)*12
      +extract(month FROM covered)::integer-extract(month FROM anchor)::integer+1;
    next_due:=(anchor+make_interval(months=>month_index))::date;
  ELSE
    next_due:=covered+CASE terms->>'period' WHEN 'DAY' THEN 1 WHEN 'WEEK' THEN 7 WHEN 'CUSTOM_DAYS' THEN (terms->>'days')::integer END;
  END IF;
  IF next_due IS NULL OR NOT sharkai_broker.fee_period_matches(terms,covered,next_due)
      OR next_due<=(statement_timestamp() AT TIME ZONE 'UTC')::date THEN RETURN NULL; END IF;
  SELECT sum(f.fee_minor) INTO outstanding FROM sharkai_broker.performance_fee_period f JOIN sharkai_broker.account a ON a.id=f.account_id
    WHERE f.account_id=p_account AND f.reversed_at IS NULL AND (f.credited_at IS NULL OR a.snapshot_at IS NULL OR a.snapshot_at<=f.credited_at);
  SELECT high_water,carry_tenths INTO mark,remainder FROM sharkai_broker.performance_fee_period WHERE account_id=p_account ORDER BY ends_on DESC LIMIT 1;
  possible:=greatest(0,p_positive_net_minor::numeric-coalesce(mark,0))+coalesce(remainder,0);
  RETURN least(9223372036854775807::numeric,coalesce(outstanding,0)+ceil(possible/10))::bigint;
END $hold$;

CREATE FUNCTION sharkai_broker.owner_performance_fee(p_user text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $view$
  SELECT jsonb_build_object('status','available','rate_bps',1000,'currency',f.currency,'period_end',f.ends_on,
    'eligible_profit_minor',f.eligible_minor::text,'period_result_minor',(f.closing_net::numeric-f.opening_net)::text,
    'fee_minor',f.fee_minor::text,'client_net_minor',(f.closing_net::numeric-f.opening_net-CASE WHEN f.reversed_at IS NULL THEN f.fee_minor ELSE 0 END)::text,
    'settlement',CASE WHEN f.reversed_at IS NOT NULL THEN 'reversed' WHEN f.credited_at IS NOT NULL THEN 'credited' ELSE 'accrued' END)
  FROM sharkai_broker.performance_fee_period f JOIN sharkai_broker.account a ON a.id=f.account_id WHERE a.user_id=p_user
  ORDER BY f.ends_on DESC,f.account_id LIMIT 1
$view$;
CREATE FUNCTION sharkai_broker.admin_fee_receipts(p_user text) RETURNS TABLE(currency text,accrued_minor text,credited_minor text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $view$
  SELECT f.currency,coalesce(sum(f.fee_minor) FILTER(WHERE f.credited_at IS NULL),0)::text,
    coalesce(sum(f.fee_minor) FILTER(WHERE f.credited_at IS NOT NULL AND f.reversed_at IS NULL),0)::text
  FROM sharkai_broker.performance_fee_period f JOIN public."User" u ON u.id=f.beneficiary_user_id AND u.role::text='ADMIN'
  WHERE u.id=p_user GROUP BY f.currency ORDER BY f.currency
$view$;
REVOKE ALL ON FUNCTION sharkai_broker.check_new_fee_term(),sharkai_broker.refresh_fee_capacity(),sharkai_broker.freeze_fee_agreement(),sharkai_broker.fee_period_matches(jsonb,date,date),
  sharkai_broker.record_performance_fee(text,jsonb,text),sharkai_broker.performance_fee_hold(text,text,text,bigint),
  sharkai_broker.owner_performance_fee(text),sharkai_broker.admin_fee_receipts(text) FROM PUBLIC,anon,authenticated;
COMMIT;
