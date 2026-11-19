import { randomUUID } from 'node:crypto';
import { FINANCE_STATUS_SCOPE, signWalletStatusGrant } from '@/lib/wallet-investments-grants';
import {commerceScope,issueCommerceGrant} from '@/lib/commerce/agent-access.server';
import { sendSharkAgentRequest, sharkAssistantConfigured } from '@/lib/shark-assistant.server';

export async function sendWalletAgentRequest(
  userId: string, message: string, analysisRevision: number | null, send = fetch, commerceAccess = issueCommerceGrant,
) {
  if (!sharkAssistantConfigured()) return null;
  const grant = analysisRevision === null ? null : await signWalletStatusGrant(userId, analysisRevision);
  if (analysisRevision !== null && !grant) return null;

  const commerceGrant=await commerceAccess(userId);
  return sendSharkAgentRequest({
    userId, conversationId: 'wallet-investments-' + userId, requestId: randomUUID(), message,
    scopes: [...(grant ? [FINANCE_STATUS_SCOPE] : []), ...(commerceGrant ? [commerceScope] : [])],
    financeGrant: grant, commerceGrant,
  }, send);
}
