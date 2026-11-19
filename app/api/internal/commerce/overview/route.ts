import {authorizedCommerceRead} from '@/lib/commerce/agent-access.server';
import {commerceAgentOverview} from '@/lib/commerce/agent-overview.server';

export function POST(request:Request) {
  return authorizedCommerceRead(request,commerceAgentOverview);
}
