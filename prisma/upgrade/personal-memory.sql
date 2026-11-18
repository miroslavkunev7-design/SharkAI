BEGIN;

CREATE TABLE IF NOT EXISTS "PersonalMemory" (
  "userId" TEXT PRIMARY KEY REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "notes" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PersonalMemory_notes_size_check"
    CHECK (jsonb_typeof("notes") = 'array' AND jsonb_array_length("notes") <= 12 AND pg_column_size("notes") <= 16384)
);

ALTER TABLE "PersonalMemory" ENABLE ROW LEVEL SECURITY;

COMMIT;
