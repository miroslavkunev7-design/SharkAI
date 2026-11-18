BEGIN;

DO $enum$
BEGIN
  CREATE TYPE "ReminderRepeat" AS ENUM ('NONE', 'DAILY', 'WEEKLY', 'MONTHLY');
EXCEPTION WHEN duplicate_object THEN NULL;
END $enum$;

CREATE TABLE IF NOT EXISTS "Reminder" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "requestId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "timeZone" TEXT NOT NULL,
  "localTime" TEXT NOT NULL,
  "repeat" "ReminderRepeat" NOT NULL DEFAULT 'NONE',
  "nextLocal" TEXT,
  "nextAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS "ReminderOccurrence" (
  "id" TEXT PRIMARY KEY,
  "reminderId" TEXT NOT NULL REFERENCES "Reminder"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "acknowledgedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "Reminder_userId_requestId_key" ON "Reminder" ("userId", "requestId");
CREATE INDEX IF NOT EXISTS "Reminder_userId_nextAt_idx" ON "Reminder" ("userId", "nextAt");
CREATE UNIQUE INDEX IF NOT EXISTS "ReminderOccurrence_reminderId_dueAt_key" ON "ReminderOccurrence" ("reminderId", "dueAt");
CREATE INDEX IF NOT EXISTS "ReminderOccurrence_reminderId_acknowledgedAt_idx" ON "ReminderOccurrence" ("reminderId", "acknowledgedAt");

ALTER TABLE "Reminder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReminderOccurrence" ENABLE ROW LEVEL SECURITY;

COMMIT;
