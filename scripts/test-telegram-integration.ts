import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  decodeTelegramTextAttachment, hasTelegramServiceAuthorization, sofiaRegistrationWindow,
  telegramAttachmentBody, telegramAuthorizationBody, telegramDeliveryBody, telegramMediaClaimBody, telegramReportBody,
  type TelegramAuthorization,
} from '../lib/telegram-contract';

const chat_id = 90000217;
const telegram_user_id = chat_id;

function contractChecks() {
  const authorization = { update_id: 0, chat_id, telegram_user_id };
  assert(telegramAuthorizationBody.safeParse(authorization).success);
  assert(!telegramAuthorizationBody.safeParse({ ...authorization, chat_id: '90000217' }).success);
  assert(!telegramAuthorizationBody.safeParse({ ...authorization, role: 'ADMIN' }).success);
  assert(!telegramReportBody.safeParse({ chat_id, telegram_user_id, request_id: 'telegram-01' }).success);
  assert(!telegramReportBody.safeParse({ chat_id, telegram_user_id, request_id: 'telegram-1', date: '2026-11-18' }).success);
  const outbound = { chat_id, telegram_user_id, request_id: 'telegram-1', message_id: 23 };
  assert(telegramDeliveryBody.safeParse(outbound).success);
  for (const patch of [{ message_id: 0 }, { message_id: '23' }, { message_id: 1.5 }, { user_id: 'owner' }]) {
    assert(!telegramDeliveryBody.safeParse({ ...outbound, ...patch }).success);
  }
  assert(!hasTelegramServiceAuthorization('Bearer wrong', 'synthetic_test_only_secret'));
  assert(hasTelegramServiceAuthorization('Bearer synthetic_test_only_secret', 'synthetic_test_only_secret'));
  const editFile = { file_id: 'telegram-fixture-png', mime_type: 'image/png' as const, file_size: 256 };
  const media = { request_id: 'telegram-1', chat_id, telegram_user_id, operation: 'edit_image', operation_id: 'telegram-1:edit_image' };
  assert(telegramAuthorizationBody.safeParse({ ...authorization, media_operation: 'edit_image', media_file: editFile }).success);
  assert(!telegramAuthorizationBody.safeParse({ ...authorization, media_operation: 'edit_image' }).success);
  assert(!telegramAuthorizationBody.safeParse({ ...authorization, pairing_code: 'M'.repeat(32), media_operation: 'generate_image' }).success);
  assert(!telegramAuthorizationBody.safeParse({ ...authorization, media_operation: 'generate_image', media_file: editFile }).success);
  assert(!telegramAuthorizationBody.safeParse({ ...authorization, media_operation: 'edit_image', media_file: { ...editFile, file_size: 8 * 1024 * 1024 + 1 } }).success);
  assert(telegramMediaClaimBody.safeParse({ ...media, media_file: editFile }).success);
  assert(!telegramMediaClaimBody.safeParse({ ...media, media_file: editFile, operation_id: 'other' }).success);
  assert(!telegramMediaClaimBody.safeParse(media).success);

  const attach = {
    chat_id, telegram_user_id, request_id: 'telegram-1', file_name: 'Данни.csv',
    mime_type: 'text/csv' as const, content_base64: Buffer.from('а,б\n1,2').toString('base64'),
  };
  assert(telegramAttachmentBody.safeParse(attach).success);
  assert.deepEqual(decodeTelegramTextAttachment(attach), {
    file_name: 'Данни.csv', mime_type: 'text/csv', text: 'а,б\n1,2',
  });
  assert.equal(decodeTelegramTextAttachment({ ...attach, file_name: '../../bad.csv' }), null);
  assert.equal(decodeTelegramTextAttachment({ ...attach, file_name: 'bad.txt' }), null);
  assert.equal(decodeTelegramTextAttachment({ ...attach, content_base64: Buffer.from([0xff]).toString('base64') }), null);
  assert.equal(decodeTelegramTextAttachment({ ...attach, content_base64: Buffer.from('a'.repeat(12_001)).toString('base64') }), null);

  for (const [instant, date, start, end] of [
    ['2026-11-18T22:00:00.000Z', '2026-11-19', '2026-11-18T22:00:00.000Z', '2026-11-19T22:00:00.000Z'],
    ['2026-03-29T12:00:00.000Z', '2026-03-29', '2026-03-28T22:00:00.000Z', '2026-03-29T21:00:00.000Z'],
    ['2026-10-25T12:00:00.000Z', '2026-10-25', '2026-10-24T21:00:00.000Z', '2026-10-25T22:00:00.000Z'],
  ]) {
    const window = sofiaRegistrationWindow(new Date(instant));
    assert.equal(window.date, date);
    assert.equal(window.start.toISOString(), start);
    assert.equal(window.end.toISOString(), end);
  }
  console.log('Telegram contract, authorization shape, attachment, Sofia midnight and DST checks passed.');
}

async function databaseChecks() {
  for (const value of [process.env.POSTGRES_PRISMA_URL, process.env.POSTGRES_URL_NON_POOLING]) {
    const url = new URL(value ?? '');
    assert.equal(url.hostname, '127.0.0.1', 'Use an isolated local PostgreSQL fixture.');
    assert.equal(url.pathname, '/telegram_fixture', 'Use a disposable telegram_fixture database.');
  }
  const { prisma } = await import('../lib/db');
  const { LEGACY_GUEST_EMAIL } = await import('../lib/auth');
  const {
    authorizeTelegramUpdate, claimTelegramMediaOperation, createTelegramPairing, readTelegramDailyRegistrations,
    readTelegramTextAttachment, recordTelegramDelivery, readRecentTelegramDelivery, revokeTelegramPairing, telegramPairingStatus,
  } = await import('../lib/telegram-server');
  const stamp = randomUUID();
  const now = new Date('2026-11-19T12:00:00.000Z');
  const rowIds: string[] = [];
  const updateBase = Math.floor(Math.random() * 1_000_000_000);
  const authorize = (suffix: number, extra: Partial<Omit<TelegramAuthorization, 'update_id' | 'chat_id'>> = {}, at = now) =>
    authorizeTelegramUpdate({ chat_id, telegram_user_id, update_id: updateBase + suffix, ...extra }, at);
  const request = (suffix: number) => ({ chat_id, telegram_user_id, request_id: 'telegram-' + (updateBase + suffix) });
  const account = async (kind: string, createdAt: string, role: 'USER' | 'ADMIN' = 'USER', email?: string) => {
    const row = await prisma.user.create({
      data: { email: email ?? kind + '-' + stamp + '@example.invalid', passwordHash: 'fixture', role, createdAt: new Date(createdAt) },
    });
    rowIds.push(row.id);
    return row;
  };

  try {
    const { start, end } = sofiaRegistrationWindow(now);
    const before = await prisma.user.count({
      where: { createdAt: { gte: start, lt: end }, email: { not: LEGACY_GUEST_EMAIL } },
    });
    const admin = await account('admin', '2026-11-18T21:59:59.999Z', 'ADMIN');
    const outsider = await account('user', '2026-11-19T22:00:00.000Z');
    await account('signup-at-start', '2026-11-18T22:00:00.000Z');
    await account('signup-before-end', '2026-11-19T21:59:59.999Z');
    if (!await prisma.user.findUnique({ where: { email: LEGACY_GUEST_EMAIL } })) {
      await account('internal-guest', '2026-11-19T10:00:00.000Z', 'USER', LEGACY_GUEST_EMAIL);
    }

    const badRolePairing = await createTelegramPairing(outsider.id, now);
    assert(badRolePairing);
    assert.equal((await authorize(0, { pairing_code: badRolePairing.code })).status, 'invalid_pairing');
    assert.equal((await authorize(1)).status, 'unlinked');
    const expired = await createTelegramPairing(admin.id, new Date(now.valueOf() - 11 * 60_000));
    assert(expired);
    assert.equal((await authorize(2, { pairing_code: expired.code })).status, 'invalid_pairing');
    const pairing = await createTelegramPairing(admin.id, now);
    assert(pairing);
    assert.equal(pairing.code.length, 32);

    const pairs = await Promise.all([authorize(3, { pairing_code: pairing.code }), authorize(4, { pairing_code: pairing.code })]);
    assert.deepEqual(pairs.map(({ status }) => status).sort(), ['invalid_pairing', 'paired']);
    assert(await telegramPairingStatus(admin.id));
    assert.equal(await createTelegramPairing(admin.id, now), null);
    assert.equal((await authorize(1)).status, 'duplicate_update');
    assert.equal((await authorize(5, { telegram_user_id: telegram_user_id + 1 })).status, 'unlinked');

    const attempts = await Promise.all([authorize(6), authorize(6)]);
    assert.deepEqual(attempts.map(({ status }) => status).sort(), ['authorized', 'duplicate_update']);
    const authorized = attempts.find((result) => result.status === 'authorized');
    assert(authorized);
    assert.equal(authorized.user_id, admin.id);
    assert.equal(await readRecentTelegramDelivery(admin.id, now), 'inbound');
    assert.equal(await readRecentTelegramDelivery(outsider.id, now), 'none');
    const outbound = { ...request(6), message_id: 23 };
    assert.equal(await recordTelegramDelivery({ ...outbound, chat_id: chat_id + 1 }, now), false);
    assert.equal(await recordTelegramDelivery({ ...outbound, telegram_user_id: telegram_user_id + 1 }, now), false);
    const duplicate = await Promise.all([recordTelegramDelivery(outbound, now), recordTelegramDelivery(outbound, now)]);
    assert.deepEqual(duplicate, [true, true]);
    assert.equal(await recordTelegramDelivery({ ...outbound, message_id: 24 }, now), false);
    assert.equal(await readRecentTelegramDelivery(admin.id, now), 'delivered');
    assert.equal(await readRecentTelegramDelivery(outsider.id, now), 'none');
    const later = new Date(now.valueOf() + 6 * 60_000);
    assert.equal(await readRecentTelegramDelivery(admin.id, later), 'none');
    assert.equal(await recordTelegramDelivery(outbound, later), false);
    assert(authorized.permission_context.scopes.includes('admin:registrations:read'));
    assert(!authorized.permission_context.scopes.includes('media:generate'));
    assert(!authorized.permission_context.scopes.includes('media:edit'));
    assert.equal(await readTelegramDailyRegistrations({ ...request(6), chat_id: chat_id + 1 }, now), null);

    const report = await readTelegramDailyRegistrations(request(6), now);
    assert(report);
    assert.deepEqual(report.data, {
      date: '2026-11-19', timezone: 'Europe/Sofia', window_start: start.toISOString(), window_end: end.toISOString(), total: before + 2,
    });
    assert(!JSON.stringify(report).includes(admin.email));
    assert.equal(await readTelegramDailyRegistrations(request(6), now), null);

    const attachment = {
      ...request(6), file_name: 'Синтетичен.txt', mime_type: 'text/plain' as const,
      content_base64: Buffer.from('Синтетично съдържание.').toString('base64'),
    };
    assert.equal((await readTelegramTextAttachment({ ...attachment, telegram_user_id: telegram_user_id + 1 }, now)).status, 'forbidden');
    assert.equal((await readTelegramTextAttachment(attachment, now)).status, 'ok');
    assert.equal((await readTelegramTextAttachment(attachment, now)).status, 'forbidden');
    const generate = (suffix: number) => ({ ...request(suffix), operation: 'generate_image' as const,
      operation_id: request(suffix).request_id + ':generate_image' });
    const editFile = { file_id: 'telegram-fixture-image', mime_type: 'image/png' as const, file_size: 256 };
    const edit = { ...request(11), operation: 'edit_image' as const, operation_id: request(11).request_id + ':edit_image', media_file: editFile };
    assert.equal(await claimTelegramMediaOperation(generate(6), now), null);
    const generation = await authorize(10, { media_operation: 'generate_image' });
    assert.equal(generation.status, 'authorized');
    assert(generation.permission_context.scopes.includes('media:generate'));
    assert(!generation.permission_context.scopes.includes('media:edit'));
    assert.equal(await claimTelegramMediaOperation({ ...generate(10), chat_id: chat_id + 1 }, now), null);
    const concurrent = await Promise.all([claimTelegramMediaOperation(generate(10), now), claimTelegramMediaOperation(generate(10), now)]);
    assert.equal(concurrent.filter((reply) => reply?.status === 'claimed').length, 1);
    assert.equal(concurrent.find(Boolean)?.operation, 'generate_image');
    const editing = await authorize(11, { media_operation: 'edit_image', media_file: editFile });
    assert.equal(editing.status, 'authorized');
    assert(editing.permission_context.scopes.includes('media:edit'));
    assert.deepEqual(editing.media_file, editFile);
    assert.equal(await claimTelegramMediaOperation(generate(11), now), null);
    assert.equal(await claimTelegramMediaOperation({ ...edit, media_file: { ...editFile, file_id: 'other-file' } }, now), null);
    assert.equal(await claimTelegramMediaOperation({ ...edit, media_file: { ...editFile, mime_type: 'image/jpeg' } }, now), null);
    assert.equal(await claimTelegramMediaOperation({ ...edit, media_file: { ...editFile, file_size: 257 } }, now), null);
    const editClaim = await claimTelegramMediaOperation(edit, now);
    assert.deepEqual(editClaim?.media_file, editFile);
    assert.equal(await claimTelegramMediaOperation(edit, now), null);
    const consumed = await prisma.telegramUpdate.findUniqueOrThrow({ where: { updateId: BigInt(updateBase + 11) } });
    assert.equal(consumed.mediaFileId, null);
    assert(consumed.mediaClaimedAt);
    assert.equal((await authorize(12, { media_operation: 'generate_image' })).status, 'authorized');
    assert.equal(await claimTelegramMediaOperation(generate(12), new Date(now.valueOf() + 6 * 60_000)), null);

    assert.equal((await authorize(7)).status, 'authorized');
    assert.equal(await recordTelegramDelivery({ ...request(7), message_id: 23 }, now), false);
    assert.equal(await readTelegramDailyRegistrations(request(7), new Date(now.valueOf() + 6 * 60_000)), null);
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'USER' } });
    assert.equal(await readTelegramDailyRegistrations(request(7), now), null);
    assert.equal(await claimTelegramMediaOperation(generate(12), now), null);
    assert.equal((await authorize(8)).status, 'unlinked');
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
    await revokeTelegramPairing(admin.id);
    assert.equal(await readRecentTelegramDelivery(admin.id, now), 'none');
    assert.equal(await recordTelegramDelivery(outbound, now), false);
    assert.equal(await readTelegramDailyRegistrations(request(7), now), null);
    assert.equal(await claimTelegramMediaOperation(generate(12), now), null);
    assert.equal((await authorize(9)).status, 'unlinked');
    console.log('Isolated PostgreSQL pairing, replay/concurrency, same-chat authorization, admin count boundaries, attachment, exact-file single-use media claims, expiry, demotion and revocation checks passed.');
  } finally {
    await prisma.telegramUpdate.deleteMany({
      where: { updateId: { gte: BigInt(updateBase), lte: BigInt(updateBase + 12) } },
    });
    await prisma.user.deleteMany({ where: { id: { in: rowIds } } });
    await prisma.$disconnect();
  }
}

async function main() {
  contractChecks();
  if (process.argv.includes('--with-database')) await databaseChecks();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
