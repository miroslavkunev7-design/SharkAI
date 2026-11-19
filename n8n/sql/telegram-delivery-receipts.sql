-- Additive, re-runnable on the original Shark AI TelegramUpdate table.
BEGIN;
ALTER TABLE public."TelegramUpdate"
  ADD COLUMN IF NOT EXISTS "replyDeliveredAt" timestamp(3),
  ADD COLUMN IF NOT EXISTS "replyMessageId" bigint;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public."TelegramUpdate"'::regclass AND conname='telegram_reply_delivery_pair'
  ) THEN
    ALTER TABLE public."TelegramUpdate" ADD CONSTRAINT telegram_reply_delivery_pair CHECK (
      ("replyDeliveredAt" IS NULL AND "replyMessageId" IS NULL)
      OR ("replyDeliveredAt" IS NOT NULL AND "replyMessageId" IS NOT NULL
          AND "replyDeliveredAt">="receivedAt" AND "replyMessageId">0)
    );
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "TelegramUpdate_bindingId_replyMessageId_key"
  ON public."TelegramUpdate" ("bindingId","replyMessageId");
COMMIT;
