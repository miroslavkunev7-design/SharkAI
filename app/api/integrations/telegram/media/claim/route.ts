import { telegramMediaClaimBody } from '@/lib/telegram-contract';
import { claimTelegramMediaOperation, telegramJson, telegramServiceRequest } from '@/lib/telegram-server';

export function POST(request: Request) {
  return telegramServiceRequest(request, telegramMediaClaimBody, async (input) => {
    const claim = await claimTelegramMediaOperation(input);
    return claim ? telegramJson(claim) : telegramJson({ status: 'forbidden' }, 403);
  });
}
