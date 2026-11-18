ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "currentPeriodStart" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "Subscription_stripeSubId_idx" ON "Subscription" ("stripeSubId");
