-- Personal preferences and revocation metadata. Shark AI reads them through its authenticated backend.
CREATE TYPE public."WalletInvestmentAiAccess" AS ENUM ('OFF', 'ANALYSIS_ONLY');
CREATE TYPE public."WalletInvestmentTargetPeriod" AS ENUM ('DAY', 'CUSTOM_DAYS', 'WEEK', 'MONTH');

CREATE TABLE public."WalletInvestmentSettings" (
  "userId" text PRIMARY KEY REFERENCES public."User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "currency" text CHECK ("currency" ~ '^[A-Z]{3}$'),
  "authorizedAmountMinor" bigint CHECK ("authorizedAmountMinor" > 0),
  "aiAccess" public."WalletInvestmentAiAccess" NOT NULL DEFAULT 'OFF',
  "accessRevision" integer NOT NULL DEFAULT 0 CHECK ("accessRevision" >= 0),
  "instrumentCode" text,
  "strategyLabel" text,
  "targetPeriod" public."WalletInvestmentTargetPeriod",
  "targetDays" integer CHECK ("targetDays" > 0),
  "targetAmountMinor" bigint CHECK ("targetAmountMinor" > 0),
  "targetReturnBps" integer CHECK ("targetReturnBps" > 0),
  "targetStartDate" date,
  "tradingConsentRevokedAt" timestamp(3),
  "updatedAt" timestamp(3) NOT NULL,
  CHECK ("authorizedAmountMinor" IS NULL OR "currency" IS NOT NULL),
  CHECK ("targetAmountMinor" IS NULL OR "currency" IS NOT NULL),
  CHECK (num_nonnulls("targetAmountMinor", "targetReturnBps") <= 1),
  CHECK (("targetPeriod" IS NULL) = ("targetStartDate" IS NULL)),
  CHECK (("targetPeriod" IS NOT DISTINCT FROM 'CUSTOM_DAYS') = ("targetDays" IS NOT NULL)),
  CHECK ("targetPeriod" IS NOT NULL OR num_nonnulls("targetAmountMinor", "targetReturnBps") = 0)
);

ALTER TABLE public."WalletInvestmentSettings" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."WalletInvestmentSettings" FROM PUBLIC, anon, authenticated, service_role;
