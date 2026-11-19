-- Bind the original application's settings relation for owner-only reads and immediate revocation.
BEGIN;
INSERT INTO sharkai_broker.owner_application(singleton,settings_table)
VALUES (true, 'public."WalletInvestmentSettings"'::regclass)
ON CONFLICT (singleton) DO NOTHING;

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM sharkai_broker.owner_application
    WHERE singleton AND settings_table = 'public."WalletInvestmentSettings"'::regclass
  ) THEN
    RAISE EXCEPTION 'This registry is already linked to a different settings relation';
  END IF;
END;
$check$;
COMMIT;
