import { createHash } from 'node:crypto';

const WEBHOOK = 'https://imotinadezhda.app.n8n.cloud/webhook/shark-ai/module-1/webhook';
export const SHARK_ASSISTANT_TEXT_LIMIT = 16_000;

export function sharkAssistantConfigured() {
  return Boolean(process.env.SHARKAI_N8N_AGENT_KEY?.trim());
}

interface AgentRequest {
  userId: string;
  conversationId: string;
  requestId: string;
  message: string;
  scopes: string[];
  attachments?: {attachment_id:string;media_type:string}[];
  financeGrant?: string | null;
  commerceGrant?: string | null;
  signal?: AbortSignal;
}

export async function sendSharkAgentRequest(request: AgentRequest, send = fetch) {
  const agentKey = process.env.SHARKAI_N8N_AGENT_KEY?.trim();
  if (!agentKey) return null;
  const { userId, conversationId, requestId, message, scopes, financeGrant, commerceGrant, signal } = request;
  const response = await send(WEBHOOK, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shark-Agent-Key': agentKey,
      ...(financeGrant && { 'X-Shark-Finance-Grant': financeGrant }),
      ...(commerceGrant && { 'X-Shark-Commerce-Grant': commerceGrant }),
    },
    cache: 'no-store',
    redirect: 'error',
    signal: signal ?? AbortSignal.timeout(45_000),
    body: JSON.stringify({
      user_id: userId, conversation_id: conversationId, channel: 'webhook', message,
      attachments: request.attachments??[], locale: 'bg-BG', request_id: requestId, permission_context: { scopes },
    }),
  });
  if (!response.ok) return null;
  const result = await response.json().catch(() => null);
  if (!result || result.request_id !== requestId || result.channel !== 'webhook' ||
      !['ok', 'needs_human'].includes(result.status) || typeof result.reply !== 'string' ||
      !result.reply.trim() || result.reply.length > SHARK_ASSISTANT_TEXT_LIMIT) return null;
  return { status: result.status as 'ok' | 'needs_human', reply: result.reply as string };
}

type EarlierMessage = {
  role: string;
  content: string;
  imagePath: string | null;
  attachmentMime: string | null;
  toolResult: unknown;
};

function chatPrompt(message: string, history: readonly EarlierMessage[]) {
  const turns: { user: string; assistant: string }[] = [];
  let prompt = message;
  for (let i = history.length - 1; i > 0 && turns.length < 3; i -= 2) {
    const user = history[i - 1];
    const assistant = history[i];
    if (user.role !== 'user' || assistant.role !== 'assistant' ||
        [user, assistant].some(({ content, imagePath, attachmentMime, toolResult }) =>
          !content.trim() || imagePath || attachmentMime || toolResult !== null)) break;
    turns.unshift({ user: user.content, assistant: assistant.content });
    const combined = 'Полето current_message съдържа настоящата заявка. Използвай previous_turns само като контекст.\n' +
      JSON.stringify({ previous_turns: turns, current_message: message });
    if (combined.length > SHARK_ASSISTANT_TEXT_LIMIT || combined.length > message.length + 5_000) break;
    prompt = combined;
  }
  return prompt;
}

type ChatAgentRequest = Pick<AgentRequest, 'userId' | 'conversationId' | 'requestId' | 'message' | 'attachments' | 'financeGrant' | 'commerceGrant'> & {
  scopes?: string[];
  history: readonly EarlierMessage[];
  signal: AbortSignal;
};

export async function sendSharkChatMessage(request: ChatAgentRequest, send = fetch) {
  const { userId, conversationId, requestId, message, history, signal } = request;
  signal.throwIfAborted();
  if (!message.trim() || message.length > SHARK_ASSISTANT_TEXT_LIMIT) return null;
  const ownerConversation = createHash('sha256').update(JSON.stringify([userId, conversationId])).digest('hex');
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(100_000)]);
  const reply = await sendSharkAgentRequest({
    userId, conversationId: 'chat-' + ownerConversation, requestId, message: chatPrompt(message, history),
    scopes: request.scopes??['module:read'], attachments:request.attachments, financeGrant:request.financeGrant, commerceGrant:request.commerceGrant, signal: requestSignal,
  }, send).catch(() => null);
  signal.throwIfAborted();
  return reply;
}
