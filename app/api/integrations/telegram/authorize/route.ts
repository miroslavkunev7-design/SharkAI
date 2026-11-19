import { telegramAuthorizationBody } from '@/lib/telegram-contract';
import { authorizeTelegramUpdate, telegramJson, telegramServiceRequest } from '@/lib/telegram-server';
import {commerceScope,issueCommerceGrant} from '@/lib/commerce/agent-access.server';
import {prisma} from '@/lib/db';

export function POST(request: Request) {
  return telegramServiceRequest(request, telegramAuthorizationBody, async (input) => {
    const result = await authorizeTelegramUpdate(input);
    if(result.status==='authorized' && !input.media_operation) {
      const binding=await prisma.telegramBinding.findFirst({where:{userId:result.user_id,chatId:BigInt(input.chat_id),
        telegramUserId:BigInt(input.telegram_user_id),user:{role:'ADMIN'}},select:{id:true}});
      const grant=binding?await issueCommerceGrant(result.user_id,binding.id):null;
      if(grant) return telegramJson({...result,commerce_grant:grant,
        permission_context:{scopes:[...result.permission_context.scopes,commerceScope]}});
    }
    const code = {
      duplicate_update: 409, invalid_pairing: 403, unlinked: 403, authorized: 200, paired: 200,
    }[result.status];
    return telegramJson(result, code);
  });
}
