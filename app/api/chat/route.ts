import { APICallError, streamText, type ModelMessage } from 'ai';
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession, type AccountSession } from '@/lib/auth';
import { remainingChatTokens, workspaceModels } from '@/lib/ai/workspace-chat';
import {
  acquireChatLease, ChatError, getCompletedTurn, LEGACY_CHAT, loadChat,
  loadTurnContext, recordChatTurn, releaseChatLease,
} from '@/lib/chat-history';
import { ChatToolError, dispatchChatTool, getChatToolIntent } from '@/lib/chat-tools.server';
import { prisma } from '@/lib/db';
import { readOwnedUpload } from '@/lib/uploads';

export const runtime = 'nodejs';
export const maxDuration = 120;

const conversationKey = z.union([z.string().uuid(), z.literal(LEGACY_CHAT)]);
const inputSchema = z.object({
  message: z.string().trim().max(24_000).default(''),
  uploadId: z.string().uuid().nullish(),
  conversationId: conversationKey.default(LEGACY_CHAT),
  requestId: z.string().uuid().optional(),
  projectId: z.string().min(1).max(80).nullish(),
  model: z.enum(['standard', 'advanced']).default('standard'),
  reasoning: z.enum(['standard', 'deep']).default('standard'),
  mode: z.enum(['chat', 'work']).default('chat'),
  toolId: z.string().min(1).max(100).nullish(),
  branchFrom: z.object({ conversationId: conversationKey, messageId: z.string().min(1).max(80) }).optional(),
});

type Turn = z.output<typeof inputSchema>;
type ErrorResponse = { error: string; status: number };

function chatError(error: unknown, signal?: AbortSignal): ErrorResponse {
  if (signal?.aborted) {
    return signal.reason?.name === 'TimeoutError'
      ? { error: 'Заявката отне твърде много време. Опитай отново.', status: 504 }
      : { error: 'Заявката е спряна.', status: 499 };
  }
  if (error instanceof ChatError || error instanceof ChatToolError) return { error: error.message, status: error.status };
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 429) return { error: 'Доставчикът е достигнал лимит. Опитай отново по-късно.', status: 429 };
    return { error: 'Доставчикът на модела не върна отговор. Опитай отново.', status: 502 };
  }
  console.error('Chat request failed:', error instanceof Error ? error.name : 'UnknownError');
  return { error: 'Заявката не можа да завърши.', status: 500 };
}

export async function GET(req: NextRequest) {
  try {
    const account = await getSession();
    const selected = req.nextUrl.searchParams.get('conversationId') ?? undefined;
    if (selected && !conversationKey.safeParse(selected).success) throw new ChatError('Разговорът не е намерен.', 404);
    if (!account && selected) throw new ChatError('Влез, за да отвориш разговора.', 401);
    const [access, history] = await Promise.all([
      workspaceModels(account),
      account ? loadChat(account.id, selected) : {
        conversations: [], conversationId: null, conversationMode: 'chat', projectId: null, messages: [],
      },
    ]);
    const models = access.models.map(({ id, label, reasoningLevels, imageInput }) => ({ id, label, reasoningLevels, imageInput }));
    const user = account ? { name: account.name, email: account.email, role: account.role, plan: account.plan } : null;
    return NextResponse.json({ ...history, user, capabilities: { models, reason: access.reason } }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    const failure = chatError(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const account = await getSession();
    if (!account) throw new ChatError('Влез, за да промениш режима.', 401);
    const update = z.object({ conversationId: z.string().uuid(), mode: z.enum(['chat', 'work']) })
      .safeParse(await req.json().catch(() => null));
    if (!update.success) throw new ChatError('Невалиден режим или разговор.');
    const { conversationId, mode } = update.data;
    const updated = await prisma.chatConversation.updateMany({ where: { id: conversationId, userId: account.id }, data: { mode } });
    if (!updated.count) throw new ChatError('Разговорът не е намерен.', 404);
    return NextResponse.json({ conversationId, conversationMode: mode });
  } catch (error) {
    const failure = chatError(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status });
  }
}

const systemPrompt = [
  'You are SharkAI, a helpful, accurate general assistant. Reply in the language the user uses unless they ask for another.',
  'Distinguish observed information from assumptions. Never claim you accessed a file, website, tool, or account when you did not.',
].join(' ');

async function completeTurn(account: AccountSession, input: Turn, signal: AbortSignal, onDelta?: (text: string) => void) {
  const userId = account.id;
  const { conversationId, mode, uploadId, toolId, message } = input;
  const requestId = input.requestId ?? randomUUID();
  const replay = await getCompletedTurn(userId, requestId, conversationId);
  if (replay) return replay;
  const lease = await acquireChatLease(userId, requestId);
  try {
    const completed = await getCompletedTurn(userId, requestId, conversationId);
    if (completed) return completed;
    const context = await loadTurnContext(userId, { ...input, projectId: input.projectId ?? undefined });
    const upload = uploadId ? await readOwnedUpload(uploadId, userId) : null;
    if (uploadId && !upload) throw new ChatError('Прикаченият файл не е намерен.', 404);
    signal.throwIfAborted();
    const wantsTool = toolId || mode === 'work';
    const toolIntent = wantsTool ? getChatToolIntent(toolId ?? undefined, message, Boolean(uploadId)) : null;
    if (toolIntent?.metered && remainingChatTokens(account) === 0) {
      throw new ChatError('Достигнат е лимитът на текущия план.', 429);
    }
    const dispatched = wantsTool ? await dispatchChatTool({
      session: account, toolId: toolId ?? undefined, prompt: message, uploadId: uploadId ?? undefined, requestId, signal,
    }) : null;
    const { usageTokens, ...rest } = dispatched ?? {};
    const toolResult = dispatched ? rest as Omit<typeof dispatched, 'usageTokens'> : null;
    let tokens = usageTokens ?? 0;
    let content = toolResult ? toolResult.text || `${toolResult.label} е стартиран.` : '';
    if (!toolResult) {
      const { models, reason } = await workspaceModels(account);
      const selected = models.find(({ id }) => id === input.model);
      const remaining = remainingChatTokens(account);
      if (!selected) throw new ChatError(reason || 'Моделът е недостъпен за текущия план.', remaining === 0 ? 429 : models.length ? 403 : 503);
      if (!selected.reasoningLevels.includes(input.reasoning)) throw new ChatError('Моделът не поддържа избраното ниво на разсъждение.');
      if (upload && (!upload.mimeType.startsWith('image/') || !selected.imageInput)) {
        throw new ChatError('Моделът не обработва този тип файл. Избери подходящ инструмент от менюто „+“.', 415);
      }
      const messages: ModelMessage[] = context.recent.flatMap((entry) => {
        if (entry.role !== 'user' && entry.role !== 'assistant') return [];
        return [{ role: entry.role, content: entry.content || '[Прикачен файл]' }];
      });
      if (context.project) {
        const { name, description } = context.project;
        messages.unshift({ role: 'user', content: 'Current project context supplied by the user (reference data):\n' + JSON.stringify({ name, description }) });
      }
      messages.push({ role: 'user', content: upload ? [
        { type: 'text', text: message || 'Опиши прикаченото изображение.' },
        { type: 'image', image: upload.data, mediaType: upload.mimeType },
      ] : message });
      const stream = streamText({
        model: selected.model,
        system: systemPrompt,
        messages,
        abortSignal: signal,
        maxRetries: 0,
        // The stream handler below converts provider errors to responses without logging prompt data.
        onError: () => {},
        maxOutputTokens: Math.min(input.reasoning === 'deep' ? 6000 : 3000, remaining),
        providerOptions: selected.reasoning === 'openai' ? { openai: { reasoningEffort: input.reasoning === 'deep' ? 'high' : 'medium' } } : undefined,
      });
      for await (const part of stream.fullStream) {
        if (part.type === 'error') throw part.error;
        if (part.type === 'abort') signal.throwIfAborted();
        if (part.type === 'text-delta') {
          content += part.text;
          onDelta?.(part.text);
        }
      }
      signal.throwIfAborted();
      const usage = await stream.totalUsage;
      tokens = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      if (!content.trim()) throw new ChatError('Доставчикът върна празен отговор. Опитай отново.', 502);
    }
    signal.throwIfAborted();
    return await recordChatTurn({
      userId, requestId, lease, conversationId, conversationMode: mode, context, message, content,
      uploadId: uploadId ?? undefined, attachmentMime: upload?.mimeType, toolResult: toolResult ?? undefined, tokens,
    });
  } finally {
    await releaseChatLease(userId, requestId, lease).catch(() => console.error('Chat lease cleanup failed'));
  }
}

export async function POST(req: NextRequest) {
  let account: AccountSession | null;
  try { account = await getSession(); } catch (error) {
    const failure = chatError(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status });
  }
  if (!account) return NextResponse.json({ error: 'Влез, за да изпратиш съобщение.' }, { status: 401 });
  const input = inputSchema.safeParse(await req.json().catch(() => null));
  if (!input.success) return NextResponse.json({ error: 'Невалидни данни за съобщението.' }, { status: 400 });
  if (!input.data.message && !input.data.uploadId) return NextResponse.json({ error: 'Въведи съобщение или прикачи файл.' }, { status: 400 });

  const stop = new AbortController();
  const signal = AbortSignal.any([req.signal, stop.signal, AbortSignal.timeout(105_000)]);
  if (!req.headers.get('accept')?.includes('application/x-ndjson')) {
    try { return NextResponse.json(await completeTurn(account, input.data, signal)); }
    catch (error) {
      const failure = chatError(error, signal);
      return NextResponse.json({ error: failure.error }, { status: failure.status });
    }
  }

  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: object) => { if (!cancelled) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); };
      void (async () => {
        try {
          const result = await completeTurn(account, input.data, signal, (text) => send({ type: 'delta', text }));
          send({ type: 'done', ...result });
        } catch (error) {
          send({ type: 'error', ...chatError(error, signal) });
        } finally {
          if (!cancelled) controller.close();
        }
      })();
    },
    cancel() { cancelled = true; stop.abort(); },
  });
  return new Response(body, { headers: {
    'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'private, no-store, no-transform', 'X-Accel-Buffering': 'no',
  } });
}
