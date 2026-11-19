-- Apply after investment-forecast-sources.sql. No production bindings or grants are created.
BEGIN;
CREATE SCHEMA sharkai_research;
REVOKE ALL ON SCHEMA sharkai_research FROM PUBLIC;
CREATE TABLE sharkai_research.investment_cohort(
  user_id text NOT NULL,currency text NOT NULL,members jsonb NOT NULL,strategy_versions jsonb NOT NULL,registered_at timestamptz NOT NULL,
  PRIMARY KEY(user_id,currency),CHECK(jsonb_typeof(members)='object'),CHECK(jsonb_typeof(strategy_versions)='object')
);
CREATE TABLE sharkai_research.daily_mark(
  binding_id text NOT NULL,identity_hash text NOT NULL,mark_date date NOT NULL,nav text NOT NULL,kind text NOT NULL,
  observed_at timestamptz NOT NULL,received_at timestamptz NOT NULL,source_hash text NOT NULL,
  PRIMARY KEY(binding_id,mark_date)
);
ALTER TABLE sharkai_research.investment_cohort ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_research.daily_mark ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION sharkai_research.strategy_identity(b sharkai_forecast.binding)
RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $f$
  SELECT encode(sha256(convert_to(jsonb_build_array(b.id,b.user_id,b.currency,b.provider,b.account_key,b.connector_key,
    b.strategy_label,b.instrument_code,b.strategy_history_from,extract(epoch from b.ownership_verified_at),
    extract(epoch from b.strategy_isolation_verified_at),extract(epoch from b.provider_read_approved_at))::text,'UTF8')),'hex')
$f$;

-- A privileged research operator may register the entire currently authorized universe once per
-- owner and currency. Selection of individual strategies and backdating are not input parameters.
CREATE FUNCTION sharkai_research.register_investment_cohort(p_owner text,p_currency text,p_strategy_versions jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE members jsonb; variants integer;
BEGIN
  SELECT jsonb_object_agg(b.id,sharkai_research.strategy_identity(b)),count(*) INTO members,variants
    FROM sharkai_forecast.binding b WHERE b.user_id=p_owner AND b.currency=p_currency AND b.revoked_at IS NULL
      AND b.expires_at>statement_timestamp() AND b.ownership_verified_at<=statement_timestamp()
      AND b.strategy_isolation_verified_at<=statement_timestamp() AND b.provider_read_approved_at<=statement_timestamp();
  IF variants NOT BETWEEN 2 AND 32 OR jsonb_typeof(p_strategy_versions) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_each(p_strategy_versions))<>variants OR EXISTS(SELECT 1 FROM jsonb_each_text(p_strategy_versions) v
    WHERE NOT members?v.key OR v.value IS NULL OR v.value!~'^[0-9a-f]{64}$') THEN RETURN false; END IF;
  INSERT INTO sharkai_research.investment_cohort VALUES(p_owner,p_currency,members,p_strategy_versions,clock_timestamp())
    ON CONFLICT DO NOTHING;
  RETURN FOUND;
END $f$;

-- Archive only the latest completed day from a contemporaneous signed report. Historic data
-- arriving in a backfill never becomes a forward observation. Original marks survive feed retention.
CREATE FUNCTION sharkai_research.capture_daily_mark()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE b sharkai_forecast.binding; cohort sharkai_research.investment_cohort; close jsonb; day date; identity text;
BEGIN
  SELECT * INTO b FROM sharkai_forecast.binding WHERE id=NEW.binding_id;
  SELECT * INTO cohort FROM sharkai_research.investment_cohort WHERE user_id=b.user_id AND currency=b.currency;
  IF NOT FOUND THEN RETURN NEW; END IF;
  identity:=sharkai_research.strategy_identity(b);
  day:=(NEW.provider_observed_at AT TIME ZONE 'UTC')::date-1;
  close:=NEW.payload->'closes'->-1;
  IF cohort.members->>b.id IS DISTINCT FROM identity OR cohort.registered_at>(day::timestamp AT TIME ZONE 'UTC')
    OR cohort.strategy_versions->>b.id IS DISTINCT FROM NEW.payload->>'strategy_version_sha256'
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['execution','ongoing','financing','currencyConversion']) f
      WHERE coalesce(NEW.payload->'fee_coverage'->>f,'') NOT IN ('included','not_applicable'))
    OR (NEW.received_at AT TIME ZONE 'UTC')::date<>day+1 OR close->>'date' IS DISTINCT FROM day::text
    OR close->>'units' IS NULL OR close->>'units'!~'^(0|[1-9][0-9]{0,24})$'
    OR close->>'kind' IS NULL OR close->>'kind' NOT IN ('valued','confirmed_market_closed')
    OR NEW.payload->>'source' IS DISTINCT FROM (CASE b.provider WHEN 'ibkr' THEN 'ibkr_portfolio_analyst_net_strategy' ELSE 'saxo_account_history_net_strategy' END)
    OR NEW.payload->>'basis' IS DISTINCT FROM 'cash_flow_adjusted_after_fees' OR NEW.payload->>'valuation_basis' IS DISTINCT FROM 'unitized_strategy_nav'
    OR NEW.payload->>'coverage' IS DISTINCT FROM 'complete_daily_calendar' THEN RETURN NEW; END IF;
  INSERT INTO sharkai_research.daily_mark VALUES(b.id,identity,day,close->>'units',close->>'kind',NEW.provider_observed_at,NEW.received_at,NEW.provider_evidence_sha256)
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END $f$;
CREATE TRIGGER archive_prospective_strategy_mark AFTER INSERT ON sharkai_forecast.snapshot
  FOR EACH ROW WHEN (NEW.kind='history') EXECUTE FUNCTION sharkai_research.capture_daily_mark();

-- One report has one currency. Ambiguous currency selection or a universe exceeding the bounded
-- comparison limit produces an empty result rather than silently selecting top performers.
CREATE FUNCTION sharkai_research.investment_candidates(p_owner text,p_currency text,p_horizon integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 WITH owned AS MATERIALIZED (
  SELECT b.*,sharkai_research.strategy_identity(b) AS identity FROM sharkai_forecast.binding b
  WHERE b.user_id=p_owner AND b.revoked_at IS NULL AND b.expires_at>statement_timestamp() AND p_horizon BETWEEN 1 AND 366
    AND b.ownership_verified_at<=statement_timestamp() AND b.strategy_isolation_verified_at<=statement_timestamp()
    AND b.provider_read_approved_at<=statement_timestamp() AND (p_currency IS NULL OR b.currency=p_currency)
 ), pick AS (
  SELECT CASE WHEN min(currency)=max(currency) AND count(*)<=32 THEN min(currency) END AS currency FROM owned
 ), active AS MATERIALIZED (SELECT b.* FROM owned b JOIN pick USING(currency)),
 universe AS (
  SELECT c.members IS NOT NULL AND c.members=(SELECT jsonb_object_agg(id,identity) FROM active) AS complete
  FROM pick LEFT JOIN sharkai_research.investment_cohort c ON c.user_id=p_owner AND c.currency=pick.currency
 ), reports AS (
  SELECT b.*,s.payload,s.provider_observed_at FROM active b LEFT JOIN LATERAL(
   SELECT s.payload,s.provider_observed_at FROM sharkai_forecast.snapshot s WHERE s.binding_id=b.id AND s.kind='history'
     AND s.provider_observed_at<=statement_timestamp() ORDER BY s.provider_observed_at DESC LIMIT 1
  ) s ON true
 )
 SELECT jsonb_build_object('currency',(SELECT currency FROM pick),'cohort_complete',coalesce((SELECT complete FROM universe),false),
   'candidates',coalesce(jsonb_agg(jsonb_build_object(
    'id',encode(sha256(convert_to(b.id,'UTF8')),'hex'),'label',b.strategy_label,'instrument_code',b.instrument_code,
    'source',b.payload->>'source','observed_at',b.provider_observed_at,
    'closes',coalesce(series.closes,'[]'::jsonb)) ORDER BY b.id),'[]'::jsonb))
 FROM reports b LEFT JOIN LATERAL (
   SELECT jsonb_agg(jsonb_build_object('date',e.day->>'date','kind',e.day->>'kind','units',e.day->>'units',
     'forward',m.binding_id IS NOT NULL AND EXISTS(SELECT 1 FROM sharkai_research.investment_cohort c
       WHERE c.user_id=p_owner AND c.currency=b.currency AND c.strategy_versions->>b.id=b.payload->>'strategy_version_sha256')) ORDER BY e.seq) AS closes
   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.payload->'closes')='array' THEN b.payload->'closes' ELSE '[]'::jsonb END)
     WITH ORDINALITY e(day,seq) LEFT JOIN sharkai_research.daily_mark m ON m.binding_id=b.id AND m.identity_hash=b.identity
     AND m.mark_date=(e.day->>'date')::date AND m.nav=e.day->>'units' AND m.kind=e.day->>'kind'
   WHERE e.seq>jsonb_array_length(b.payload->'closes')-(90*p_horizon+1)
     AND b.payload->>'basis'='cash_flow_adjusted_after_fees' AND b.payload->>'valuation_basis'='unitized_strategy_nav'
     AND b.payload->>'coverage'='complete_daily_calendar'
     AND b.payload->>'source'=CASE b.provider WHEN 'ibkr' THEN 'ibkr_portfolio_analyst_net_strategy' ELSE 'saxo_account_history_net_strategy' END
     AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['execution','ongoing','financing','currencyConversion']) f
       WHERE coalesce(b.payload->'fee_coverage'->>f,'') NOT IN ('included','not_applicable'))
 ) series ON true
$f$;
REVOKE ALL ON ALL TABLES IN SCHEMA sharkai_research FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sharkai_research FROM PUBLIC;
COMMIT;
