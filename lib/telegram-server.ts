import { randomBytes, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { LEGACY_GUEST_EMAIL } from './auth';
import { prisma } from './db';
import { FINANCE_STATUS_SCOPE, signWalletStatusGrant } from './wallet-investments-grants';
import {
  decodeTelegramTextAttachment, digest, hasTelegramServiceAuthorization, REGISTRATION_TIMEZONE,
  sofiaRegistrationWindow, telegramBoundChallengeHash, telegramServiceSecret,
  type TelegramAttachment, type TelegramAuthorization, type TelegramDelivery, type TelegramMediaClaim, type TelegramReport,
} from './telegram-contract';

const PAIRING_LIFETIME = 10 * 60 * 1000;
const REQUEST_LIFETIME = 5 * 60 * 1000;

export async function readRecentTelegramDelivery(userId: string, now = new Date()) {
  const received = await prisma.telegramUpdate.findFirst({
    where: {
      binding: { userId, user: { role: 'ADMIN', email: { not: LEGACY_GUEST_EMAIL } } },
      receivedAt: { gte: new Date(now.valueOf() - REQUEST_LIFETIME), lte: now },
    },
    orderBy: { replyDeliveredAt: { sort: 'desc', nulls: 'last' } },
    select: { receivedAt: true, replyDeliveredAt: true, replyMessageId: true },
  });
  if (!received) return 'none';
  if (received.replyDeliveredAt && received.replyDeliveredAt >= received.receivedAt &&
      received.replyDeliveredAt <= now && received.replyMessageId && received.replyMessageId > BigInt(0)) return 'delivered';
  return 'inbound';
}
const DEDUPLICATION_LIFETIME = 7 * 24 * 60 * 60 * 1000;
const ADMIN_SCOPES = ['module:read', 'automation:draft', 'admin:registrations:read'];
const headers = { 'Cache-Control': 'private, no-store' };

export function telegramJson(body: object, status = 200) {
  return NextResponse.json(body, { status, headers });
}

export async function telegramServiceRequest<T>(
  request: Request, schema: z.ZodType<T>, handle: (input: T) => Promise<NextResponse>,
) {
  const secret = telegramServiceSecret();
  if (!secret) return telegramJson({ status: 'unavailable' }, 503);
  if (!hasTelegramServiceAuthorization(request.headers.get('authorization'), secret)) {
    return telegramJson({ status: 'forbidden' }, 403);
  }

  const body = schema.safeParse(await request.json().catch(() => null));
  if (!body.success) return telegramJson({ status: 'invalid_request' }, 400);
  try {
    return await handle(body.data);
  } catch {
    return telegramJson({ status: 'unavailable' }, 503);
  }
}

export async function createTelegramPairing(userId: string, now = new Date()) {
  const code = randomBytes(24).toString('base64url');
  const tokenHash = digest(code).toString('hex');
  const expiresAt = new Date(now.valueOf() + PAIRING_LIFETIME);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.telegramBinding.findUnique({ where: { userId }, select: { id: true } });
    if (existing) return null;
    await tx.telegramPairingChallenge.upsert({
      where: { userId }, create: { userId, tokenHash, expiresAt }, update: { tokenHash, expiresAt },
    });
    return { code, expires_at: expiresAt.toISOString() };
  });
}

export function telegramPairingStatus(userId: string) {
  return prisma.telegramBinding.findUnique({ where: { userId }, select: { id: true } });
}

export function revokeTelegramPairing(userId: string) {
  return prisma.$transaction([
    prisma.telegramPairingChallenge.deleteMany({ where: { userId } }),
    prisma.telegramBinding.deleteMany({ where: { userId } }),
  ]);
}

async function consumeTelegramPairing(
  tx: Prisma.TransactionClient, input: TelegramAuthorization & { pairing_code: string }, now: Date,
) {
  const boundHash = telegramBoundChallengeHash(input.chat_id, input.telegram_user_id, input.pairing_code);
  const websiteHash = digest(input.pairing_code).toString('hex');
  const challenges = await tx.telegramPairingChallenge.findMany({
    where: { tokenHash: { in: [boundHash, websiteHash] } },
    select: { tokenHash: true, userId: true, expiresAt: true, user: { select: { role: true, email: true } } },
  });
  const challenge = challenges.find((entry) => entry.tokenHash === boundHash) ?? challenges[0];
  if (!challenge || challenge.expiresAt <= now || challenge.user.role !== 'ADMIN' ||
      challenge.user.email === LEGACY_GUEST_EMAIL) return false;

  const consumed = await tx.telegramPairingChallenge.deleteMany({
    where: { userId: challenge.userId, tokenHash: challenge.tokenHash, expiresAt: { gt: now } },
  });
  if (consumed.count !== 1) return false;

  const linked = await tx.telegramBinding.createMany({
    data: {
      id: randomUUID(), conversationId: randomUUID(), userId: challenge.userId,
      chatId: BigInt(input.chat_id), telegramUserId: BigInt(input.telegram_user_id),
    },
    skipDuplicates: true,
  });
  return linked.count === 1;
}

export function authorizeTelegramUpdate(input: TelegramAuthorization, now = new Date()) {
  const updateId = BigInt(input.update_id);
  const request_id = 'telegram-' + input.update_id;
  return prisma.$transaction(async (tx) => {
    const reserved = await tx.telegramUpdate.createMany({
      data: { updateId, receivedAt: now }, skipDuplicates: true,
    });
    if (reserved.count !== 1) return { status: 'duplicate_update' } as const;

    await tx.telegramUpdate.deleteMany({
      where: { receivedAt: { lt: new Date(now.valueOf() - DEDUPLICATION_LIFETIME) } },
    });

    if (input.pairing_code) {
      const paired = await consumeTelegramPairing(tx, { ...input, pairing_code: input.pairing_code }, now);
      return paired ? { status: 'paired', request_id } as const : { status: 'invalid_pairing' } as const;
    }

    const binding = await tx.telegramBinding.findFirst({
      where: {
        chatId: BigInt(input.chat_id), telegramUserId: BigInt(input.telegram_user_id),
        user: { role: 'ADMIN', email: { not: LEGACY_GUEST_EMAIL } },
      },
      select: { id: true, userId: true, conversationId: true },
    });
    if (!binding) return { status: 'unlinked' } as const;

    const { media_operation, media_file } = input;
    await tx.telegramUpdate.update({
      where: { updateId },
      data: {
        bindingId: binding.id, mediaOperation: media_operation, mediaFileId: media_file?.file_id,
        mediaMimeType: media_file?.mime_type, mediaFileSize: media_file?.file_size,
      },
    });

    const scopes = media_operation
      ? [...ADMIN_SCOPES, media_operation === 'generate_image' ? 'media:generate' : 'media:edit']
      : [...ADMIN_SCOPES];
    const preferences = !media_operation && await tx.walletInvestmentSettings.findUnique({
      where:{userId:binding.userId},select:{aiAccess:true,accessRevision:true},
    });
    const financeGrant = preferences && preferences.aiAccess === 'ANALYSIS_ONLY'
      ? await signWalletStatusGrant(binding.userId,preferences.accessRevision,binding.id) : null;
    if (financeGrant) scopes.push(FINANCE_STATUS_SCOPE);
    return {
      status: 'authorized', channel: 'telegram', request_id, user_id: binding.userId,
      conversation_id: binding.conversationId, permission_context: { scopes },
      ...(financeGrant && { finance_grant:financeGrant }),
      ...(media_operation && { media_operation }), ...(media_file && { media_file }),
    } as const;
  });
}

function activeTelegramUpdate(input: TelegramReport, now: Date): Prisma.TelegramUpdateWhereInput {
  return {
    updateId: BigInt(input.request_id.slice('telegram-'.length)),
    receivedAt: { gte: new Date(now.valueOf() - REQUEST_LIFETIME), lte: now },
    binding: {
      is: {
        chatId: BigInt(input.chat_id), telegramUserId: BigInt(input.telegram_user_id),
        user: { role: 'ADMIN', email: { not: LEGACY_GUEST_EMAIL } },
      },
    },
  };
}

export async function recordTelegramDelivery(input: TelegramDelivery, now = new Date()) {
  const accepted = activeTelegramUpdate(input, now);
  const messageId = BigInt(input.message_id);
  try {
    const result = await prisma.telegramUpdate.updateMany({
      where: { ...accepted, replyDeliveredAt: null, replyMessageId: null },
      data: { replyDeliveredAt: now, replyMessageId: messageId },
    });
    if (result.count === 1) return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return false;
    throw error;
  }
  const existing = await prisma.telegramUpdate.findFirst({
    where: { ...accepted, replyMessageId: messageId, replyDeliveredAt: { not: null } },
    select: { receivedAt: true },
  });
  return existing !== null;
}

export async function readTelegramDailyRegistrations(input: TelegramReport, now = new Date()) {
  const { date, start, end } = sofiaRegistrationWindow(now);
  const total = await prisma.$transaction(async (tx) => {
    const claim = await tx.telegramUpdate.updateMany({
      where: { ...activeTelegramUpdate(input, now), reportClaimedAt: null },
      data: { reportClaimedAt: now },
    });
    if (claim.count !== 1) return null;
    return tx.user.count({
      where: { createdAt: { gte: start, lt: end }, email: { not: LEGACY_GUEST_EMAIL } },
    });
  });
  if (total === null) return null;

  return {
    status: 'ok', source: 'shark-ai-product-db', timestamp: now.toISOString(),
    request_id: input.request_id, channel: 'telegram',
    data: { date, timezone: REGISTRATION_TIMEZONE, window_start: start.toISOString(), window_end: end.toISOString(), total },
  } as const;
}

export async function readTelegramTextAttachment(input: TelegramAttachment, now = new Date()) {
  const data = decodeTelegramTextAttachment(input);
  if (!data) return { status: 'invalid_request' } as const;

  const claim = await prisma.telegramUpdate.updateMany({
    where: { ...activeTelegramUpdate(input, now), attachmentClaimedAt: null },
    data: { attachmentClaimedAt: now },
  });
  if (claim.count !== 1) return { status: 'forbidden' } as const;

  return {
    status: 'ok', source: 'shark-ai-text-attachment', timestamp: now.toISOString(),
    request_id: input.request_id, channel: 'telegram', data,
  } as const;
}

export async function claimTelegramMediaOperation(input: TelegramMediaClaim, now = new Date()) {
  const edit = input.media_file;
  const claim = await prisma.telegramUpdate.updateMany({
    where: {
      ...activeTelegramUpdate(input, now), mediaOperation: input.operation, mediaClaimedAt: null,
      mediaFileId: edit?.file_id ?? null, mediaMimeType: edit?.mime_type ?? null, mediaFileSize: edit?.file_size ?? null,
    },
    data: { mediaClaimedAt: now, mediaFileId: null, mediaMimeType: null, mediaFileSize: null },
  });
  if (claim.count !== 1) return null;
  return {
    status: 'claimed', source: 'shark-ai-telegram-media', timestamp: now.toISOString(),
    request_id: input.request_id, channel: 'telegram', operation: input.operation, operation_id: input.operation_id,
    ...(edit && { media_file: edit }),
  } as const;
}
