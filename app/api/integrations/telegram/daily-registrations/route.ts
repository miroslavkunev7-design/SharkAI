import { telegramReportBody } from '@/lib/telegram-contract';
import { readTelegramDailyRegistrations, telegramJson, telegramServiceRequest } from '@/lib/telegram-server';

export function POST(request: Request) {
  return telegramServiceRequest(request, telegramReportBody, async (input) => {
    const result = await readTelegramDailyRegistrations(input);
    return result ? telegramJson(result) : telegramJson({ status: 'forbidden' }, 403);
  });
}
