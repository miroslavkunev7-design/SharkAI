-- Additive upgrade for databases created from previous prisma/schema.prisma.
BEGIN;

CREATE TABLE IF NOT EXISTS "ChatConversation" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "projectId" TEXT REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "title" TEXT NOT NULL,
  "mode" TEXT NOT NULL DEFAULT 'chat',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS "ChatRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "lease" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId", "id")
);

ALTER TABLE "ChatMessage"
  ADD COLUMN IF NOT EXISTS "attachmentMime" TEXT,
  ADD COLUMN IF NOT EXISTS "conversationId" TEXT REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD COLUMN IF NOT EXISTS "requestId" TEXT,
  ADD COLUMN IF NOT EXISTS "toolResult" JSONB;

ALTER TABLE "FileUpload"
  ADD COLUMN IF NOT EXISTS "userId" TEXT REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "requestId" TEXT;

CREATE INDEX IF NOT EXISTS "ChatConversation_userId_updatedAt_idx" ON "ChatConversation" ("userId", "updatedAt");
CREATE INDEX IF NOT EXISTS "ChatMessage_userId_conversationId_createdAt_idx" ON "ChatMessage" ("userId", "conversationId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "ChatMessage_userId_requestId_role_key" ON "ChatMessage" ("userId", "requestId", "role");
CREATE UNIQUE INDEX IF NOT EXISTS "Project_userId_requestId_key" ON "Project" ("userId", "requestId");

-- Preserve uploads with one provable owner. The retired shared guest is ineligible.
UPDATE "FileUpload" AS upload
SET "userId" = owners.owner
FROM (
  SELECT message."imagePath" AS id, MIN(message."userId") AS owner
  FROM "ChatMessage" AS message
  JOIN "User" AS account ON account.id = message."userId"
  WHERE message."imagePath" IS NOT NULL
  GROUP BY message."imagePath"
  HAVING COUNT(DISTINCT message."userId") = 1
    AND BOOL_AND(account.email <> 'guest@sharkai.local')
) AS owners
WHERE upload.id = owners.id AND upload."userId" IS NULL;

ALTER TABLE "ChatConversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChatRequest" ENABLE ROW LEVEL SECURITY;

COMMIT;
