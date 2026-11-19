import { telegramAttachmentBody } from '@/lib/telegram-contract';
import { readTelegramTextAttachment, telegramJson, telegramServiceRequest } from '@/lib/telegram-server';

export function POST(request: Request) {
  return telegramServiceRequest(request, telegramAttachmentBody, async (input) => {
    const result = await readTelegramTextAttachment(input);
    const code = { ok: 200, invalid_request: 400, forbidden: 403 }[result.status];
    return telegramJson(result, code);
  });
}
