-- Server-side SharkAI sessions identify the owner. No browser role can access this schema.
CREATE SCHEMA sharkai_portfolio;
REVOKE ALL ON SCHEMA sharkai_portfolio FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE sharkai_portfolio.market_preference (
  owner_id text NOT NULL REFERENCES public."User" (id) ON DELETE CASCADE,
  symbol text NOT NULL CHECK (symbol IN ('BTC','ETH','SOL')),
  starred boolean NOT NULL DEFAULT false,
  alert jsonb CHECK (alert IS NULL OR jsonb_typeof(alert) = 'object'),
  PRIMARY KEY (owner_id, symbol)
);
ALTER TABLE sharkai_portfolio.market_preference ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sharkai_portfolio.market_preference FROM PUBLIC, anon, authenticated, service_role;
