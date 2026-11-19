import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { nextReminderLocal, reminderInstant } from './reminder-time';

export const REGISTRATION_TIMEZONE = 'Europe/Sofia';
const TELEGRAM_MAX_ID = 2 ** 52 - 1;
const MAX_ATTACHMENT_BYTES = 65_536;
const MAX_ATTACHMENT_CHARACTERS = 12_000;

const positiveTelegramId = z.number().int().positive().max(TELEGRAM_MAX_ID);
const identity = {
  chat_id: positiveTelegramId,
  telegram_user_id: positiveTelegramId,
};

const mediaOperation = z.enum(['generate_image', 'edit_image']);
const mediaFile = z.object({
  file_id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  file_size: z.number().int().positive().max(8 * 1024 * 1024),
}).strict();

export const telegramAuthorizationBody = z.object({
  ...identity,
  update_id: z.number().int().min(0).max(TELEGRAM_MAX_ID),
  pairing_code: z.string().regex(/^[A-Za-z0-9_-]{32}$/).optional(),
  media_operation: mediaOperation.optional(),
  media_file: mediaFile.optional(),
}).strict().refine((input) =>
  (!input.pairing_code || !input.media_operation) && (input.media_operation === 'edit_image') === !!input.media_file,
  { path: ['media_operation'] },
);

const acceptedUpdate = {
  ...identity,
  request_id: z.string().regex(/^telegram-(0|[1-9][0-9]{0,15})$/).refine(
    (id) => Number(id.slice('telegram-'.length)) <= TELEGRAM_MAX_ID,
  ),
};

export const telegramReportBody = z.object(acceptedUpdate).strict();
export const telegramDeliveryBody = z.object({
  ...acceptedUpdate,
  message_id: positiveTelegramId,
}).strict();

export const telegramAttachmentBody = z.object({
  ...acceptedUpdate,
  file_name: z.string().min(1).max(160),
  mime_type: z.enum(['text/plain', 'text/markdown', 'text/csv']),
  content_base64: z.string().min(4).max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4),
}).strict();

export const telegramMediaClaimBody = z.object({
  ...acceptedUpdate,
  operation: mediaOperation,
  operation_id: z.string().min(1).max(64),
  media_file: mediaFile.optional(),
}).strict().refine((input) =>
  input.operation_id === input.request_id + ':' + input.operation && (input.operation === 'edit_image') === !!input.media_file,
  { path: ['operation_id'] },
);

export type TelegramMediaClaim = z.infer<typeof telegramMediaClaimBody>;
export type TelegramAuthorization = z.infer<typeof telegramAuthorizationBody>;
export type TelegramReport = z.infer<typeof telegramReportBody>;
export type TelegramDelivery = z.infer<typeof telegramDeliveryBody>;
export type TelegramAttachment = z.infer<typeof telegramAttachmentBody>;

export function digest(value: string) {
  return createHash('sha256').update(value).digest();
}

export function telegramBoundChallengeHash(chatId: number, senderId: number, code: string) {
  const preimage = 'sharkai.telegram.pair.v1:' + chatId + ':' + senderId + ':' + code;
  return 'telegram-bound-v1:' + digest(preimage).toString('hex');
}

export function telegramServiceSecret() {
  const secret = process.env.SHARKAI_TELEGRAM_SERVICE_SECRET;
  return secret && /^[A-Za-z0-9_-]{32,256}$/.test(secret) ? secret : null;
}

export function hasTelegramServiceAuthorization(authorization: string | null, secret: string) {
  return authorization !== null && timingSafeEqual(digest(authorization), digest('Bearer ' + secret));
}

const sofiaDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: REGISTRATION_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

export function sofiaRegistrationWindow(now: Date) {
  const parts = new Map(sofiaDate.formatToParts(now).map(({ type, value }) => [type, value]));
  const date = [parts.get('year'), parts.get('month'), parts.get('day')].join('-');
  const localMidnight = date + 'T00:00';
  const nextMidnight = nextReminderLocal(localMidnight, localMidnight, 'DAILY');
  const start = reminderInstant(localMidnight, REGISTRATION_TIMEZONE);
  const end = nextMidnight && reminderInstant(nextMidnight, REGISTRATION_TIMEZONE);
  if (!start || !end || now < start || now >= end) throw new Error('Invalid report window');
  return { date, start, end };
}

export function decodeTelegramTextAttachment(attachment: TelegramAttachment) {
  const { file_name, mime_type, content_base64 } = attachment;
  const extension = /\.(txt|md|csv)$/i.exec(file_name)?.[1].toLowerCase();
  if (file_name !== file_name.trim() || /[\\/\p{Cc}]/u.test(file_name) || !extension ||
      (mime_type !== 'text/plain' &&
        !(mime_type === 'text/markdown' && extension === 'md') &&
        !(mime_type === 'text/csv' && extension === 'csv'))) {
    return null;
  }

  const bytes = Buffer.from(content_base64, 'base64');
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES || bytes.toString('base64') !== content_base64) {
    return null;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!/\S/.test(text) || text.length > MAX_ATTACHMENT_CHARACTERS || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
      return null;
    }
    return { file_name, mime_type, text };
  } catch {
    return null;
  }
}
