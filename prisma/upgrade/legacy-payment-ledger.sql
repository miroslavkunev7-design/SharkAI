-- Match the recovered production ledger and retain the historical Stripe subscription key.
BEGIN;
ALTER TABLE "Subscription"
  ADD COLUMN IF NOT EXISTS "paymentMethod" TEXT,
  ADD COLUMN IF NOT EXISTS "bankReference" TEXT,
  ADD COLUMN IF NOT EXISTS "amountEur" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "stripeSessionId" TEXT,
  ADD COLUMN IF NOT EXISTS "stripePeriodSubId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_bankReference_key" ON "Subscription" ("bankReference");
CREATE INDEX IF NOT EXISTS "Subscription_stripePeriodSubId_idx" ON "Subscription" ("stripePeriodSubId");
CREATE INDEX IF NOT EXISTS "Subscription_userId_status_idx" ON "Subscription" ("userId", "status");
CREATE INDEX IF NOT EXISTS "Subscription_plan_status_idx" ON "Subscription" ("plan", "status");

CREATE TABLE IF NOT EXISTS "Payment" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "subscriptionId" TEXT,
  "amountEur" DOUBLE PRECISION NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'EUR',
  "method" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'completed',
  "externalId" TEXT,
  "reference" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Payment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Payment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "Payment_userId_idx" ON "Payment" ("userId");
CREATE INDEX IF NOT EXISTS "Payment_status_idx" ON "Payment" ("status");
ALTER TABLE "Payment" ENABLE ROW LEVEL SECURITY;

COMMIT;
