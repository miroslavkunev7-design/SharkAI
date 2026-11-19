-- Prepare empty private tables. Each binding requires verified ownership and approved strategy data.
-- Provision restricted caller roles and an authenticated connector separately. Nothing is granted by default.
BEGIN;
CREATE SCHEMA sharkai_forecast;
REVOKE ALL ON SCHEMA sharkai_forecast FROM PUBLIC;

CREATE TABLE sharkai_forecast.binding (
  id text PRIMARY KEY,
  connector_key text NOT NULL,
  user_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('ibkr','saxo')),
  account_key text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  instrument_code text NOT NULL,
  strategy_label text NOT NULL,
  ownership_verified_at timestamptz NOT NULL,
  strategy_isolation_verified_at timestamptz NOT NULL,
  provider_read_approved_at timestamptz NOT NULL,
  strategy_history_from date NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE(provider,account_key),
  UNIQUE(user_id,currency,instrument_code,strategy_label)
);
CREATE TABLE sharkai_forecast.snapshot (
  binding_id text NOT NULL REFERENCES sharkai_forecast.binding(id),
  snapshot_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('funding','history','weekly_report')),
  provider_observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  fingerprint text NOT NULL,
  provider_report_id text NOT NULL,
  provider_evidence_sha256 text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY(binding_id,snapshot_id),
  UNIQUE(binding_id,kind,provider_observed_at)
);
CREATE INDEX snapshot_latest ON sharkai_forecast.snapshot(binding_id,kind,provider_observed_at DESC);

-- Only the server-side authenticated collector can call this function. It cannot provision bindings.
CREATE FUNCTION sharkai_forecast.accept_snapshot(p_connector text,p_packet jsonb,p_fingerprint text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE
  b sharkai_forecast.binding%ROWTYPE;
  prev sharkai_forecast.snapshot%ROWTYPE;
  observed timestamptz;
  captured timestamptz;
  latest timestamptz;
  packet_kind text;
BEGIN
  IF p_packet IS NULL OR jsonb_typeof(p_packet)<>'object' OR p_fingerprint IS NULL
      OR p_fingerprint !~ '^[a-f0-9]{64}$' OR p_connector IS NULL THEN RETURN 'invalid'; END IF;
  SELECT * INTO b FROM sharkai_forecast.binding WHERE id=p_packet->>'binding_id'
    AND connector_key=p_connector AND provider=p_packet->>'provider' AND account_key=p_packet->>'provider_account_key'
    AND currency=p_packet->>'currency' AND instrument_code=p_packet->>'instrument_code'
    AND strategy_label=p_packet->>'strategy_label' FOR UPDATE;
  IF NOT FOUND THEN RETURN 'forbidden'; END IF;
  captured := clock_timestamp();
  IF b.revoked_at IS NOT NULL OR captured>=b.expires_at OR b.ownership_verified_at>captured
      OR b.strategy_isolation_verified_at>captured OR b.provider_read_approved_at>captured THEN RETURN 'forbidden'; END IF;
  packet_kind := p_packet->>'kind';
  IF packet_kind IS NULL OR packet_kind NOT IN ('funding','history','weekly_report') OR p_packet->>'snapshot_id' IS NULL
      OR p_packet->>'snapshot_id' !~ '^[A-Za-z0-9_.:-]{1,128}$' OR p_packet->>'observed_at' IS NULL
      OR p_packet->>'provider_report_id' IS NULL OR p_packet->>'provider_report_id' !~ '^[A-Za-z0-9_.:-]{1,128}$'
      OR p_packet->>'provider_evidence_sha256' IS NULL OR p_packet->>'provider_evidence_sha256' !~ '^[a-f0-9]{64}$'
      OR jsonb_typeof(p_packet->'data') IS DISTINCT FROM 'object' THEN RETURN 'invalid'; END IF;
  IF packet_kind='history' AND ((p_packet#>>'{data,closes,0,date}') IS NULL
      OR (p_packet#>>'{data,closes,0,date}')::date < b.strategy_history_from) THEN RETURN 'forbidden'; END IF;
  IF packet_kind='weekly_report' AND ((p_packet#>>'{data,window_start}') IS NULL
      OR ((p_packet#>>'{data,window_start}')::timestamptz AT TIME ZONE 'UTC')::date < b.strategy_history_from) THEN
    RETURN 'forbidden';
  END IF;
  observed := (p_packet->>'observed_at')::timestamptz;
  IF observed>captured OR (packet_kind='funding' AND observed<captured-interval '5 minutes')
      OR (packet_kind='history' AND observed<captured-interval '3 days')
      OR (packet_kind='weekly_report' AND observed<captured-interval '8 days') THEN RETURN 'stale'; END IF;
  SELECT * INTO prev FROM sharkai_forecast.snapshot WHERE binding_id=b.id AND snapshot_id=p_packet->>'snapshot_id';
  IF FOUND THEN
    RETURN CASE WHEN prev.fingerprint=p_fingerprint THEN 'replayed' ELSE 'conflict' END;
  END IF;
  SELECT provider_observed_at INTO latest FROM sharkai_forecast.snapshot
    WHERE binding_id=b.id AND snapshot.kind=packet_kind ORDER BY provider_observed_at DESC LIMIT 1;
  IF latest IS NOT NULL AND observed<=latest THEN RETURN 'stale'; END IF;
  IF latest IS NOT NULL AND ((packet_kind='funding' AND observed<latest+interval '30 seconds')
      OR (packet_kind IN ('history','weekly_report') AND observed<latest+interval '30 minutes')) THEN RETURN 'stale'; END IF;
  INSERT INTO sharkai_forecast.snapshot(binding_id,snapshot_id,kind,provider_observed_at,received_at,fingerprint,
    provider_report_id,provider_evidence_sha256,payload)
    VALUES(b.id,p_packet->>'snapshot_id',packet_kind,observed,captured,p_fingerprint,
      p_packet->>'provider_report_id',p_packet->>'provider_evidence_sha256',p_packet->'data');
  -- Keep recent immutable source evidence. These retention limits never affect current forecast data.
  DELETE FROM sharkai_forecast.snapshot WHERE binding_id=b.id AND received_at<captured-interval '30 days';
  RETURN 'recorded';
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN 'invalid';
END
$body$;

-- Read exact selected strategy for the account owner after server-side session authorization.
CREATE FUNCTION sharkai_forecast.read_source(p_user text,p_currency text,p_instrument text,p_strategy text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
  WITH candidates AS (
    SELECT * FROM sharkai_forecast.binding
    WHERE user_id=p_user AND currency=p_currency
      AND (p_instrument IS NULL OR instrument_code=p_instrument)
      AND (p_strategy IS NULL OR strategy_label=p_strategy)
      AND revoked_at IS NULL AND expires_at>statement_timestamp() AND ownership_verified_at<=statement_timestamp()
      AND strategy_isolation_verified_at<=statement_timestamp() AND provider_read_approved_at<=statement_timestamp()
    LIMIT 2
  )
  SELECT jsonb_build_object('binding_ref',b.id,'provider',b.provider,'currency',b.currency,
    'instrument_code',b.instrument_code,'strategy_label',b.strategy_label,
    'funding',f.payload,'funding_observed_at',to_char(f.provider_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'history',h.payload,'history_observed_at',to_char(h.provider_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'weekly_report',w.payload,'weekly_observed_at',to_char(w.provider_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM candidates b
  LEFT JOIN LATERAL (
    SELECT payload,provider_observed_at FROM sharkai_forecast.snapshot WHERE binding_id=b.id AND kind='funding'
      AND provider_observed_at>=statement_timestamp()-interval '5 minutes' AND provider_observed_at<=statement_timestamp()
      ORDER BY provider_observed_at DESC LIMIT 1
  ) f ON true
  LEFT JOIN LATERAL (
    SELECT payload,provider_observed_at FROM sharkai_forecast.snapshot WHERE binding_id=b.id AND kind='history'
      AND provider_observed_at>=statement_timestamp()-interval '3 days' AND provider_observed_at<=statement_timestamp()
      ORDER BY provider_observed_at DESC LIMIT 1
  ) h ON true
  LEFT JOIN LATERAL (
    SELECT payload,provider_observed_at FROM sharkai_forecast.snapshot WHERE binding_id=b.id AND kind='weekly_report'
      AND provider_observed_at>=statement_timestamp()-interval '8 days' AND provider_observed_at<=statement_timestamp()
      ORDER BY provider_observed_at DESC LIMIT 1
  ) w ON true
  WHERE (SELECT count(*) FROM candidates) = 1
$body$;

ALTER TABLE sharkai_forecast.binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_forecast.snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA sharkai_forecast FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sharkai_forecast FROM PUBLIC;
COMMIT;
