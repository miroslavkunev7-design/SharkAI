import { telegramDeliveryBody } from '@/lib/telegram-contract';
import { recordTelegramDelivery, telegramJson, telegramServiceRequest } from '@/lib/telegram-server';

export function POST(request: Request) {
  return telegramServiceRequest(request, telegramDeliveryBody, async (input) => {
    const received = await recordTelegramDelivery(input);
    return received ? telegramJson({ status: 'recorded' }) : telegramJson({ status: 'unverified' }, 409);
  });
}
