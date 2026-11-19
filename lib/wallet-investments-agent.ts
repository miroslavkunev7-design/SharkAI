import { randomUUID } from 'node:crypto';
import { FINANCE_STATUS_SCOPE, signWalletStatusGrant } from '@/lib/wallet-investments-grants';
import {commerceScope,issueCommerceGrant} from '@/lib/commerce/agent-access.server';

const WEBHOOK = 'https://imotinadezhda.app.n8n.cloud/webhook/shark-ai/module-1/webhook';

export async function sendWalletAgentRequest(
  userId: string, message: string, analysisRevision: number | null, send = fetch, commerceAccess = issueCommerceGrant,
) {
  const agentKey = process.env.SHARKAI_N8N_AGENT_KEY;
  if (!agentKey) return null;
  const grant = analysisRevision === null ? null : await signWalletStatusGrant(userId, analysisRevision);
  if (analysisRevision !== null && !grant) return null;

  const requestId = randomUUID();
  const commerceGrant=await commerceAccess(userId);
  const response = await send(WEBHOOK, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shark-Agent-Key': agentKey,
      ...(grant && { 'X-Shark-Finance-Grant': grant }),
      ...(commerceGrant && {'X-Shark-Commerce-Grant':commerceGrant}),
    },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(45_000),
    body: JSON.stringify({
      user_id: userId, conversation_id: 'wallet-investments-' + userId,
      channel: 'webhook', message, attachments: [], locale: 'bg-BG',
      request_id: requestId, permission_context: { scopes:[...(grant?[FINANCE_STATUS_SCOPE]:[]),...(commerceGrant?[commerceScope]:[])] },
    }),
  });
  if (!response.ok) return null;
  const result = await response.json().catch(() => null);
  if (!result || result.request_id !== requestId || result.channel !== 'webhook' ||
      !['ok', 'needs_human'].includes(result.status) || typeof result.reply !== 'string' ||
      !result.reply.trim() || result.reply.length > 16_000) return null;
  return { status: result.status as 'ok' | 'needs_human', reply: result.reply as string };
}
