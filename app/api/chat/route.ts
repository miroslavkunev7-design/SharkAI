import { APICallError } from 'ai';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession, type AccountSession } from '@/lib/auth';
import { isPaidAIEnabled } from '@/lib/ai/config';
import { remainingChatTokens } from '@/lib/ai/workspace-chat';
import { countChatTextTokens } from '@/lib/ai/chat-text-tokens.server';
import { chatFileReference, isFileFollowUp, rememberedChatFiles, specifiesParticularChatFile, type ChatFile } from '@/lib/chat-file-context';
import {
  acquireChatLease, ChatError, getCompletedTurn, LEGACY_CHAT, loadChat,
  loadTurnContext, recordChatTurn, releaseChatLease,
} from '@/lib/chat-history';
import {
  parseResearchFollowUp, previousAnswerExport, reportReceiptId, requireConversationReport, selectResearchCitation,
} from '@/lib/chat-research-followup.server';
import {
  ChatToolError, dispatchChatTool, getChatToolIntent, isExactRememberedFileCommand, matchesRememberedToolFile,
} from '@/lib/chat-tools.server';
import type { ChatToolResult } from '@/lib/chat-tools';
import { prisma } from '@/lib/db';
import { kickImageJob } from '@/lib/image-jobs';
import { kickResearchJob } from '@/lib/research';
import { MemoryError, readChatMemory } from '@/lib/personal-memory.server';
import { reminderInputSchema } from '@/lib/reminder-input';
import { requestHasSameOrigin } from '@/lib/request-origin';
import { sendSharkChatMessage, sharkAssistantConfigured, SHARK_ASSISTANT_TEXT_LIMIT } from '@/lib/shark-assistant.server';
import { getWalletSettings } from '@/lib/wallet-investments-server';
import { FINANCE_STATUS_SCOPE, signWalletStatusGrant } from '@/lib/wallet-investments-grants';
import { commerceScope, issueCommerceGrant } from '@/lib/commerce/agent-access.server';
import { readInvestmentResearch } from '@/lib/research/research.server';
import { readOwnedUpload } from '@/lib/uploads';

export const runtime = 'nodejs';
export const maxDuration = 180;

const conversationKey = z.union([z.string().uuid(), z.literal(LEGACY_CHAT)]);
const inputSchema = z.object({
  message: z.string().max(24_000).transform((message) => /^(?:Запиши съдържание|Save content):\r?\n/iu.test(message) ? message : message.trim()).default(''),
  uploadId: z.string().uuid().nullish(),
  conversationId: conversationKey.default(LEGACY_CHAT),
  requestId: z.string().uuid().optional(),
  projectId: z.string().min(1).max(80).nullish(),
  model: z.enum(['auto', 'standard', 'advanced']).default('auto'),
  reasoning: z.enum(['standard', 'deep']).default('standard'),
  mode: z.enum(['chat', 'work']).default('chat'),
  strategy: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  strategyCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
  strategyDays: z.number().int().min(1).max(366).optional(),
  toolId: z.string().min(1).max(100).nullish(),
  asyncImage: z.boolean().default(false),
  reminder: reminderInputSchema.optional(),
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
    const history = account ? await loadChat(account.id, selected) : {
      conversations: [], conversationId: null, conversationMode: 'chat', projectId: null, messages: [],
    };
    const remaining = account ? remainingChatTokens(account) : 0;
    const sharkAssistant = !!account && remaining > 0 && sharkAssistantConfigured() && await isPaidAIEnabled();
    const reason = !account ? 'Влез в профила си за разговор.' : !remaining ? 'Достигнат е лимитът на текущия план.' : !sharkAssistant ? 'Връзката към Шарк агента в n8n още не е активна.' : null;
    const user = account ? { name: account.name, email: account.email, role: account.role, plan: account.plan,
      ...(account.lifetime && { lifetime: true }) } : null;
    return NextResponse.json({ ...history, user, capabilities: { models: [], reason, sharkAssistant } }, {
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

async function personalPreferences(userId: string) {
  try { return await readChatMemory(userId); }
  catch (error) {
    const missingStorage = error instanceof Prisma.PrismaClientKnownRequestError && ['P2021', 'P2022'].includes(error.code);
    if (missingStorage || error instanceof MemoryError) return [];
    throw error;
  }
}

async function completeTurn(account: AccountSession, input: Turn, signal: AbortSignal, sameOrigin: boolean, onDelta?: (text: string) => void) {
  const userId = account.id;
  const { conversationId, mode, toolId, message } = input;
  const requestId = input.requestId ?? randomUUID();
  const replay = await getCompletedTurn(userId, requestId, conversationId);
  if (replay) return replay;
  const lease = await acquireChatLease(userId, requestId);
  try {
    const completed = await getCompletedTurn(userId, requestId, conversationId);
    if (completed) return completed;
    const context = await loadTurnContext(userId, { ...input, projectId: input.projectId ?? undefined });
    let uploadId = input.uploadId ?? undefined;
    const lastReply = context.recent.at(-1);
    const directIntent = getChatToolIntent(toolId ?? undefined, message, false);
    const researchAction = uploadId ? null : parseResearchFollowUp(message, toolId ?? undefined);
    const priorReportId = !uploadId && previousAnswerExport(message, directIntent?.id)
      ? reportReceiptId(lastReply) : undefined;
    const report = researchAction || priorReportId
      ? await requireConversationReport(userId, researchAction
        ? context.recentFiles.map(reportReceiptId).findLast(Boolean) : priorReportId)
      : undefined;
    const reportText = report?.text;
    if (researchAction?.kind === 'analysis' && reportText && reportText.length > 24_000) {
      throw new ChatError('Анализът на доклад поддържа до 24 000 знака. Изтегли отчета и приложи по-кратък откъс.', 413);
    }
    const reference = chatFileReference(message);
    const referencesFile = Boolean(reference && isFileFollowUp(message));
    if (!uploadId && !researchAction && (!directIntent || directIntent.needsFile) && (referencesFile || directIntent?.needsFile)
      && specifiesParticularChatFile(message)) {
      throw new ChatError('Избери посочения файл чрез „Прикачи отново“ в разговора или го качи.', 400);
    }
    const files = uploadId || researchAction || (directIntent && !directIntent.needsFile) ? [] : rememberedChatFiles(context.recentFiles);
    const compatibleFiles = files.filter(({ mime }) => mime && (!reference || reference.matches(mime)));
    let historicalMatch: { file: ChatFile; intent: NonNullable<typeof directIntent> } | undefined;
    for (const file of compatibleFiles) {
      if (!file.mime || (!directIntent && !referencesFile && !isExactRememberedFileCommand(message, file.mime))) continue;
      const intent = directIntent ?? getChatToolIntent(toolId ?? undefined, message, true, file.mime);
      if (intent?.needsFile && matchesRememberedToolFile(intent.id, message, file.mime)) {
        historicalMatch = { file, intent };
        break;
      }
    }
    const legacyFile = directIntent?.needsFile && !directIntent.id.startsWith('screenshot-')
      ? files.find(({ mime }) => !mime) : undefined;
    const priorFile = referencesFile ? compatibleFiles[0] : undefined;
    if (!uploadId) {
      uploadId = historicalMatch?.file.id ?? legacyFile?.id;
    }
    let upload = uploadId ? await readOwnedUpload(uploadId, userId) : null;
    if (uploadId && !upload) throw new ChatError('Прикаченият файл не е намерен.', 404);
    const implicitIntent = historicalMatch?.intent ?? (!input.uploadId && uploadId ? directIntent : null);
    if (implicitIntent && upload && ((reference && !reference.matches(upload.mimeType))
      || !matchesRememberedToolFile(implicitIntent.id, message, upload.mimeType))) {
      throw new ChatError('Избери файл с подходящ формат от разговора.', 415);
    }
    signal.throwIfAborted();
    let toolResult: Omit<ChatToolResult, 'usageTokens'> | null = null;
    let tokens = 0;
    let content = '';
    let assistant: 'shark' | undefined;

    async function executeTool(id: string, prompt: string) {
      const dispatched = await dispatchChatTool({
        session: account, toolId: id, prompt, uploadId, requestId, signal, reminder: input.reminder, asyncImage: input.asyncImage,
        file: upload ? { data: Buffer.from(upload.data), mimeType: upload.mimeType } : undefined,
        contextText: reportText ?? (lastReply?.role === 'assistant' ? lastReply.content : undefined),
      });
      if (!dispatched) throw new ChatToolError('Инструментът не е намерен.', 404);
      const { usageTokens, ...receipt } = dispatched;
      toolResult = receipt;
      tokens += usageTokens ?? 0;
      content = receipt.text || `${receipt.label} е стартиран.`;
    }

    const toolIntent = implicitIntent ?? getChatToolIntent(toolId ?? undefined, message, Boolean(uploadId), upload?.mimeType);
    if (toolIntent?.metered && remainingChatTokens(account) === 0) {
      throw new ChatError('Достигнат е лимитът на текущия план.', 429);
    }
    if (researchAction?.kind === 'citation' && report) {
      const { title, url, number } = selectResearchCitation(report, researchAction.number);
      content = `[${number}] ${title}`;
      toolResult = { id: randomUUID(), toolId: 'research-source', label: 'Източник от доклада', status: 'completed',
        text: content, sources: [{ title, url }] };
    } else if (researchAction?.kind === 'tool') {
      await executeTool(researchAction.id, researchAction.prompt);
    } else if (toolIntent && researchAction?.kind !== 'analysis') {
      await executeTool(toolIntent.id, message);
    } else {
      if (!sameOrigin) throw new ChatError('Заявката трябва да идва от Shark AI.',403);
      const remaining = remainingChatTokens(account);
      if (!remaining) throw new ChatError('Достигнат е лимитът на текущия план.',429);
      if (!sharkAssistantConfigured() || !(await isPaidAIEnabled())) throw new ChatError('Връзката към Шарк агента в n8n още не е активна.',503);
      const [settings, commerceGrant, preferences] = await Promise.all([
        getWalletSettings(userId).catch(()=>null), issueCommerceGrant(userId),
        mode === 'chat' && !context.project ? personalPreferences(userId) : Promise.resolve([]),
      ]);
      const financeGrant = settings?.aiAccess === 'ANALYSIS_ONLY' ? await signWalletStatusGrant(userId,settings.accessRevision) : null;
      let strategyEvidence;
      if (input.strategy && financeGrant) {
        const research = await readInvestmentResearch(userId,{currency:input.strategyCurrency,horizonDays:input.strategyDays??7});
        const candidate=research.candidates.find(item=>item.id===input.strategy);
        if (candidate) strategyEvidence={label:candidate.label,status:candidate.status,metrics:candidate.metrics,reasons:candidate.reasons};
      }
      const details = {project:context.project??undefined, preferences:preferences.length?preferences:undefined,
        report:reportText||undefined, strategy:strategyEvidence,
        attachmentText:upload?.mimeType.startsWith('text/') ? Buffer.from(upload.data).toString('utf8') : undefined};
      const prompt = Object.values(details).some(value=>value!==undefined) ? JSON.stringify({current_message:message,reference_data:details}) : message;
      if (prompt.length>SHARK_ASSISTANT_TEXT_LIMIT) throw new ChatError('Контекстът надхвърля 16 000 знака. Избери по-кратък откъс.',413);
      const inputUnits=Number.isFinite(remaining)?countChatTextTokens(prompt):0;
      if (inputUnits>=remaining) throw new ChatError('Оставащите токени са недостатъчни за тази заявка.',429);
      const shark=await sendSharkChatMessage({userId,conversationId,requestId,message:prompt||'Прегледай прикачения файл.',history:context.recent,signal,
        attachments:uploadId && upload ? [{attachment_id:uploadId,media_type:upload.mimeType}]:[],
        scopes:['module:read',...(financeGrant?[FINANCE_STATUS_SCOPE]:[]),...(commerceGrant?[commerceScope]:[])],financeGrant,commerceGrant},
        fetch);
      if (!shark) throw new ChatError('Шарк агентът в n8n не върна отговор. Опитай отново.',503);
      assistant='shark'; content=shark.reply;
      tokens=Number.isFinite(remaining)?inputUnits+countChatTextTokens(content):0;
      onDelta?.(content);
    }
    signal.throwIfAborted();
    const saved = await recordChatTurn({
      userId, requestId, lease, conversationId, conversationMode: mode, context, message, content, tokenLimit: Number.isFinite(remainingChatTokens(account)) ? account.tokensLimit : undefined,
      uploadId: uploadId ?? undefined, attachmentMime: upload?.mimeType, toolResult: toolResult ?? undefined, tokens,
    });
    const savedTool = saved.toolResult as ChatToolResult | null;
    if (savedTool?.imageJobId) kickImageJob(savedTool.imageJobId, userId);
    if (savedTool?.researchId) kickResearchJob(savedTool.researchId, userId);
    return { ...saved, ...(assistant && { assistant }) };
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
  if (input.data.reminder && input.data.toolId !== 'scheduled-task') return NextResponse.json({ error: 'Избери действието за напомняне.' }, { status: 400 });
  if (!input.data.message && !input.data.uploadId) return NextResponse.json({ error: 'Въведи съобщение или прикачи файл.' }, { status: 400 });

  const stop = new AbortController();
  const signal = AbortSignal.any([req.signal, stop.signal, AbortSignal.timeout(165_000)]);
  const sameOrigin = !req.headers.has('origin') || requestHasSameOrigin(req);
  if (!req.headers.get('accept')?.includes('application/x-ndjson')) {
    try { return NextResponse.json(await completeTurn(account, input.data, signal, sameOrigin)); }
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
          const result = await completeTurn(account, input.data, signal, sameOrigin, (text) => send({ type: 'delta', text }));
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
