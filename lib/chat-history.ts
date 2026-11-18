import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { ChatToolResult } from './chat-tools';
import { prisma } from './db';

export const LEGACY_CHAT = 'legacy';
export type ConversationMode = 'chat' | 'work';

const messageSelect = {
  id: true, role: true, content: true, imagePath: true, attachmentMime: true,
  toolResult: true, createdAt: true,
} satisfies Prisma.ChatMessageSelect;
const conversationSelect = {
  id: true, title: true, projectId: true, mode: true, updatedAt: true,
} satisfies Prisma.ChatConversationSelect;
const messageOrder = [{ createdAt: 'desc' }, { id: 'desc' }] satisfies Prisma.ChatMessageOrderByWithRelationInput[];

export class ChatError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function messageScope(userId: string, conversationId: string) {
  return { userId, conversationId: conversationId === LEGACY_CHAT ? null : conversationId };
}

export async function loadChat(userId: string, selected?: string) {
  const [recent, legacy] = await Promise.all([
    prisma.chatConversation.findMany({ where: { userId }, select: conversationSelect, orderBy: { updatedAt: 'desc' }, take: 100 }),
    prisma.chatMessage.findFirst({ where: messageScope(userId, LEGACY_CHAT), select: { createdAt: true }, orderBy: messageOrder }),
  ]);
  const conversations = legacy ? [...recent, {
    id: LEGACY_CHAT, title: 'Предишна история', mode: 'chat', updatedAt: legacy.createdAt, projectId: null,
  }] : recent;
  conversations.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  const conversation = selected && selected !== LEGACY_CHAT
    ? recent.find(({ id }) => id === selected) ?? await prisma.chatConversation.findFirst({ where: { id: selected, userId }, select: conversationSelect })
    : selected ? conversations.find(({ id }) => id === selected) : conversations[0];
  if (selected && !conversation) throw new ChatError('Разговорът не е намерен.', 404);
  const messages = conversation ? await prisma.chatMessage.findMany({
    where: messageScope(userId, conversation.id), select: messageSelect, orderBy: messageOrder, take: 200,
  }) : [];
  return {
    conversations,
    conversationId: conversation?.id ?? null,
    conversationMode: conversation?.mode ?? 'chat',
    projectId: conversation?.projectId ?? null,
    messages: messages.reverse(),
  };
}

export async function getCompletedTurn(userId: string, requestId: string, conversationId: string) {
  const rows = await prisma.chatMessage.findMany({
    where: { userId, requestId }, select: { ...messageSelect, conversationId: true },
  });
  const user = rows.find(({ role }) => role === 'user');
  const reply = rows.find(({ role }) => role === 'assistant');
  if (!user || !reply) return null;
  const { conversationId: savedId, ...publicReply } = reply;
  const { conversationId: _savedId, ...publicUser } = user;
  if ((savedId ?? LEGACY_CHAT) !== conversationId) throw new ChatError('Заявката вече е използвана в друг разговор.', 409);
  const conversation = savedId && await prisma.chatConversation.findFirst({
    where: { id: savedId, userId }, select: conversationSelect,
  });
  return {
    content: reply.content, role: 'assistant', mode: reply.toolResult ? 'tool' : 'ai', conversationId,
    conversationMode: conversation ? conversation.mode : 'chat',
    title: conversation ? conversation.title : 'Предишна история',
    messages: [publicUser, publicReply], toolResult: reply.toolResult,
  };
}

export async function acquireChatLease(userId: string, requestId: string) {
  const lease = randomUUID();
  const now = new Date();
  const stale = new Date(now.getTime() - 185_000);
  try {
    await prisma.chatRequest.create({ data: { id: requestId, userId, lease } });
    return lease;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    const takeover = await prisma.chatRequest.updateMany({
      where: { id: requestId, userId, createdAt: { lt: stale } }, data: { lease, createdAt: now },
    });
    if (takeover.count) return lease;
    throw new ChatError('Тази заявка още се изпълнява.', 409);
  }
}

export function releaseChatLease(userId: string, requestId: string, lease: string) {
  return prisma.chatRequest.deleteMany({ where: { id: requestId, userId, lease } });
}

interface ContextInput {
  conversationId: string;
  projectId?: string;
  branchFrom?: { conversationId: string; messageId: string };
}

export async function loadTurnContext(userId: string, input: ContextInput) {
  const previous = input.conversationId === LEGACY_CHAT ? null : await prisma.chatConversation.findFirst({
    where: { id: input.conversationId, userId }, select: conversationSelect,
  });
  if (!previous && input.conversationId !== LEGACY_CHAT) {
    const reserved = await prisma.chatConversation.findUnique({ where: { id: input.conversationId }, select: { id: true } });
    if (reserved) throw new ChatError('Разговорът не е намерен.', 404);
  }
  let projectId = previous ? previous.projectId ?? undefined : input.projectId;
  let branch: Prisma.ChatMessageGetPayload<{ select: typeof messageSelect }>[] = [];
  if (input.branchFrom) {
    if (previous || input.conversationId === LEGACY_CHAT) throw new ChatError('За разклонение е необходим нов разговор.', 409);
    const source = input.branchFrom;
    const scope = messageScope(userId, source.conversationId);
    const selected = await prisma.chatMessage.findFirst({ where: { ...scope, id: source.messageId, role: 'user' }, select: messageSelect });
    if (!selected) throw new ChatError('Изходното съобщение не е намерено.', 404);
    const sourceConversation = source.conversationId === LEGACY_CHAT ? null : await prisma.chatConversation.findFirst({
      where: { id: source.conversationId, userId }, select: { projectId: true },
    });
    projectId = sourceConversation?.projectId ?? undefined;
    branch = await prisma.chatMessage.findMany({
      where: { ...scope, OR: [{ createdAt: { lt: selected.createdAt } }, { createdAt: selected.createdAt, id: { lt: selected.id } }] },
      select: messageSelect,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }
  if ((previous || input.branchFrom) && input.projectId && projectId !== input.projectId) {
    throw new ChatError('Този разговор е свързан с друг проект.', 409);
  }
  if (input.conversationId === LEGACY_CHAT && projectId) throw new ChatError('Започни нов разговор за този проект.');
  const project = projectId ? await prisma.project.findFirst({
    where: { id: projectId, userId }, select: { id: true, name: true, description: true },
  }) : null;
  if (projectId && !project) throw new ChatError('Проектът не е намерен.', 404);
  const recentFiles = input.branchFrom ? branch.slice(-48) : (await prisma.chatMessage.findMany({
    where: messageScope(userId, input.conversationId), select: messageSelect, take: 48, orderBy: messageOrder,
  })).reverse();
  return { previous, project, branch, recent: recentFiles.slice(-30), recentFiles };
}

interface CompletedTurn {
  userId: string;
  requestId: string;
  lease: string;
  conversationId: string;
  conversationMode: ConversationMode;
  context: Awaited<ReturnType<typeof loadTurnContext>>;
  message: string;
  content: string;
  uploadId?: string;
  attachmentMime?: string;
  toolResult?: ChatToolResult;
  tokens: number;
}

export async function recordChatTurn(turn: CompletedTurn) {
  const result = await prisma.$transaction(async (tx) => {
    const { userId, requestId, lease, message, content, conversationMode, context, uploadId, attachmentMime, toolResult } = turn;
    const conversationId = turn.conversationId === LEGACY_CHAT ? null : turn.conversationId;
    const active = await tx.chatRequest.deleteMany({ where: { id: requestId, userId, lease } });
    if (!active.count) throw new ChatError('Заявката е изтекла. Опитай отново.', 409);
    const title = context.previous?.title ?? (conversationId ? message.replace(/\s+/g, ' ').slice(0, 80) || 'Нов разговор' : 'Предишна история');
    if (conversationId) {
      await tx.chatConversation.upsert({
        where: { id: conversationId, userId },
        create: { id: conversationId, userId, title, mode: conversationMode, projectId: context.project?.id },
        update: { mode: conversationMode },
      });
      if (!context.previous && context.branch.length) {
        await tx.chatMessage.createMany({ data: context.branch.map(({ id, toolResult, ...row }) => ({
          ...row, userId, conversationId, toolResult: toolResult ?? undefined,
        })) });
      }
    }
    const now = new Date();
    const user = await tx.chatMessage.create({
      data: { userId, requestId, conversationId, role: 'user', content: message, imagePath: uploadId, attachmentMime, createdAt: now },
      select: messageSelect,
    });
    const reply = await tx.chatMessage.create({
      data: { userId, requestId, conversationId, role: 'assistant', content, toolResult: toolResult as Prisma.InputJsonValue | undefined,
        createdAt: new Date(now.getTime() + 1) },
      select: messageSelect,
    });
    if (turn.tokens > 0) await tx.user.update({ where: { id: userId }, data: { tokensUsed: { increment: turn.tokens } } });
    return { content, role: 'assistant', mode: toolResult ? 'tool' : 'ai', conversationId: turn.conversationId, conversationMode,
      title, messages: [user, reply], toolResult: reply.toolResult };
  });
  return result;
}
