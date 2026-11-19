-- Runtime inputs are non-secret key names and irreversible digests. Output is one boolean.
BEGIN;
CREATE FUNCTION sharkai_broker.diagnostic_worker_binding(p_owner text,p_keys jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
  SELECT sharkai_broker.owner_worker_status(p_owner) AND EXISTS (
    SELECT 1 FROM sharkai_broker.account a
    JOIN sharkai_broker.owner_mandate m ON m.account_id=a.id AND m.user_id=a.user_id AND m.version::text=a.consent_version
    JOIN sharkai_broker.strategy_source s ON s.account_id=a.id AND s.strategy_label=m.approved_terms->>'strategy'
    JOIN sharkai_broker.worker_binding w ON w.account_id=a.id AND w.worker_id=s.worker_id
    JOIN sharkai_broker.verified_account_snapshot v ON v.account_id=a.id AND v.snapshot_id=a.snapshot_id
    WHERE a.user_id=p_owner AND s.revoked_at IS NULL AND s.approved_at<=statement_timestamp() AND s.expires_at>statement_timestamp()
      AND (m.approved_terms->'assets') ? s.asset_id AND w.revoked_at IS NULL AND w.approved_until>statement_timestamp()
      AND w.credential_scope_approved_at<=statement_timestamp() AND w.credential_expires_at>statement_timestamp()+interval '5 seconds'
      AND v.observed_at BETWEEN statement_timestamp()-interval '2 minutes' AND statement_timestamp()
      AND (p_keys->'signals') ? s.signal_collector AND (p_keys->'quotes') ? s.quote_collector AND (p_keys->'workers') ? s.worker_id
      AND p_keys->'tokens'->w.credential_ref->>'digest'=w.credential_sha256
      AND p_keys->'tokens'->w.credential_ref->>'account'=encode(sha256(convert_to(a.provider||'/'||a.provider_key,'UTF8')),'hex')
  )
$body$;
REVOKE ALL ON FUNCTION sharkai_broker.diagnostic_worker_binding(text,jsonb) FROM PUBLIC;
COMMIT;
