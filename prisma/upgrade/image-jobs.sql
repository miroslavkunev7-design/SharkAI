BEGIN;

DO $enum$
BEGIN
  CREATE TYPE "ImageJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $enum$;

CREATE TABLE IF NOT EXISTS "ImageJob" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "requestId" TEXT NOT NULL,
  "toolId" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "uploadId" TEXT,
  "outputId" TEXT,
  "status" "ImageJobStatus" NOT NULL DEFAULT 'QUEUED',
  "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "runnerId" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "error" TEXT,
  "retryable" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "ImageJob_userId_requestId_key" ON "ImageJob" ("userId", "requestId");

ALTER TABLE "ImageJob" ENABLE ROW LEVEL SECURITY;

COMMIT;
