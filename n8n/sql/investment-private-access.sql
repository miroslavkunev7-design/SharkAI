-- Keep ingestion, quotes, customer mandates and order dispatch outside the client Data API.
BEGIN;
ALTER TABLE sharkai_broker.worker_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_broker.worker_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_broker.worker_dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_broker.strategy_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_broker.strategy_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_broker.job_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharkai_broker.verified_account_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON SCHEMA sharkai_broker, sharkai_forecast FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA sharkai_broker, sharkai_forecast FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sharkai_broker, sharkai_forecast FROM PUBLIC, anon, authenticated;
COMMIT;
