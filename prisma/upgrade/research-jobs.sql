BEGIN;

DO $enum$
BEGIN
  CREATE TYPE "ResearchStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $enum$;

CREATE TABLE IF NOT EXISTS "ResearchJob" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "requestId" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "status" "ResearchStatus" NOT NULL DEFAULT 'QUEUED',
  "stage" INTEGER NOT NULL DEFAULT 0,
  "evidence" JSONB,
  "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "report" TEXT,
  "error" TEXT,
  "runnerId" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "ResearchJob_userId_requestId_key" ON "ResearchJob" ("userId", "requestId");

ALTER TABLE "ResearchJob" ENABLE ROW LEVEL SECURITY;

COMMIT;
