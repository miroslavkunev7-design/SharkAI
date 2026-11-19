import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  currencyMinorDigits, displayMinor, parseDecimalMinor, targetCalendar, walletSettingsBody,
  type WalletSettingsInput,
} from '../lib/wallet-investments-contract';
import { sendWalletAgentRequest } from '../lib/wallet-investments-agent';

const target = {
  period: 'month' as const, days: null, amount_minor: null, return_bps: 250, start_date: '2026-01-31',
};
const input: WalletSettingsInput = {
  currency: 'EUR', authorized_amount_minor: '9007199254740993', ai_access: 'analysis_only',
  target, instrument_code: 'EUNL.DE', strategy_label: 'Избран подход',
};
const secret = () => randomBytes(32).toString('hex');

function contractChecks() {
  assert.equal(currencyMinorDigits('EUR'), 2);
  assert.equal(currencyMinorDigits('JPY'), 0);
  assert.equal(currencyMinorDigits('ZZZ'), null);
  assert.equal(parseDecimalMinor('90071992547409,93', 2), '9007199254740993');
  assert.equal(parseDecimalMinor('1.234', 2), null);
  assert.equal(parseDecimalMinor('0,00', 2), null);
  assert.equal(parseDecimalMinor('92233720368547758,08', 2), null);
  assert.equal(displayMinor(null, 'EUR'), 'Недостъпно');
  assert.equal(displayMinor('-1', 'EUR'), '−0,01 EUR');
  assert.deepEqual(targetCalendar(target), { target_date: '2026-02-28', horizon_days: 28 });
  assert.equal(targetCalendar({ ...target, start_date: '2026-02-29' }), null);
  assert.deepEqual(targetCalendar({ ...target, period: 'days', days: 31 }), { target_date: '2026-03-03', horizon_days: 31 });
  assert(walletSettingsBody.safeParse(input).success);
  assert(!walletSettingsBody.safeParse({ ...input, authorized_amount_minor: '2.50' }).success);
  assert(!walletSettingsBody.safeParse({ ...input, currency: null }).success);
  assert(!walletSettingsBody.safeParse({ ...input, user_id: 'forged', live_orders_enabled: true }).success);
  assert(!walletSettingsBody.safeParse({ ...input, target: { ...target, amount_minor: '50' } }).success);
  assert(walletSettingsBody.safeParse({ ...input, target: { ...target, return_bps: null } }).success);
}

async function transportChecks() {
  const key = process.env.SHARKAI_N8N_AGENT_KEY = secret();
  process.env.SHARKAI_WALLET_STATUS_SERVICE_SECRET = secret();
  process.env.SHARKAI_WALLET_STATUS_GRANT_SECRET = secret();
  let sendCounter = 0;
  let replyMode: 'matched' | 'mismatched' | 'unavailable' = 'matched';
  let expectAnalysis = true;
  let shopAllowed=false;
  const shoppingGrant=secret();
  const commerceAccess=async()=>shopAllowed?shoppingGrant:null;
  const send: typeof fetch = async (outbound, init) => {
    sendCounter++;
    assert.equal(outbound, 'https://imotinadezhda.app.n8n.cloud/webhook/shark-ai/module-1/webhook');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('X-Shark-Agent-Key'), key);
    assert.equal(Boolean(headers.get('X-Shark-Finance-Grant')), expectAnalysis);
    assert.equal(headers.get('X-Shark-Commerce-Grant'),shopAllowed?shoppingGrant:null);
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(body).sort(), [
      'attachments', 'channel', 'conversation_id', 'locale', 'message', 'permission_context', 'request_id', 'user_id',
    ]);
    assert.equal(body.user_id, 'synthetic-owner');
    assert.equal(body.channel, 'webhook');
    assert.equal(body.locale, 'bg-BG');
    assert.deepEqual(body.attachments, []);
    assert.deepEqual(body.permission_context.scopes, [...(expectAnalysis?['finance:status:read']:[]),...(shopAllowed?['commerce:analytics:read']:[])]);
    assert(!String(init?.body).includes(shoppingGrant));
    assert(!String(init?.body).includes(key));
    const requestId = replyMode === 'mismatched' ? 'other' : body.request_id;
    if (replyMode === 'unavailable') return Response.json({ status: 'unavailable' }, { status: 503 });
    return Response.json({ status: 'ok', request_id: requestId, channel: 'webhook', reply: 'Синтетичен тест', ignored: 'internal' });
  };
  assert.deepEqual(await sendWalletAgentRequest('synthetic-owner', 'Покажи статуса', 1, send,commerceAccess),
    { status: 'ok', reply: 'Синтетичен тест' });
  expectAnalysis = false;
  assert(await sendWalletAgentRequest('synthetic-owner', 'Въпрос без достъп', null, send,commerceAccess));
  shopAllowed=true;
  assert(await sendWalletAgentRequest('synthetic-owner','Седмична печалба от магазина',null,send,commerceAccess));
  expectAnalysis = true;
  replyMode = 'mismatched';
  assert.equal(await sendWalletAgentRequest('synthetic-owner', 'Покажи статуса', 1, send,commerceAccess), null);
  replyMode = 'unavailable';
  assert.equal(await sendWalletAgentRequest('synthetic-owner', 'Покажи статуса', 1, send,commerceAccess), null);
  delete process.env.SHARKAI_N8N_AGENT_KEY;
  assert.equal(await sendWalletAgentRequest('synthetic-owner', 'Покажи статуса', 1, send), null);
  assert.equal(sendCounter, 5);
}

async function databaseChecks() {
  for (const value of [process.env.POSTGRES_PRISMA_URL, process.env.POSTGRES_URL_NON_POOLING]) {
    const dsn = new URL(value ?? '');
    assert.equal(dsn.hostname, '127.0.0.1');
    assert.equal(dsn.pathname, '/finance_fixture');
  }
  delete process.env.WALLET_PROVIDER;
  const { prisma } = await import('../lib/db');
  const { getWalletSettings, updateWalletSettings, revokeWalletAccess, withBrokerOwnerActivity } = await import('../lib/wallet-investments-server');
  const { signWalletStatusGrant, readWalletStatusGrant } = await import('../lib/wallet-investments-grants');
  const ids: string[] = [];
  const actor = async () => {
    const user = await prisma.user.create({ data: { email: randomUUID() + '@example.invalid', passwordHash: 'fixture' } });
    ids.push(user.id);
    return user;
  };
  try {
    const first = await actor();
    const second = await actor();
    const saved = await updateWalletSettings(first, input);
    assert.equal(saved.settings.authorized_amount_minor, input.authorized_amount_minor);
    assert.equal(saved.settings.target?.target_date, '2026-02-28');
    assert.deepEqual(saved.settings.horizon, {
      period: 'month', days: null, start_date: '2026-01-31', target_date: '2026-02-28', horizon_days: 28,
    });
    assert.equal(saved.wallet.balance_minor, null);
    assert.equal(saved.investments.cash_available_minor, null);
    assert.equal(saved.investments.live_orders_enabled, false);
    assert.equal(saved.forecast.status, 'unavailable');
    assert.equal(await getWalletSettings(second.id), null);
    assert.deepEqual((await withBrokerOwnerActivity(saved, first.id)).broker_activity, {
      status: 'provider_unconfigured', accounts: [],
    });
    const horizonOnly = await updateWalletSettings(first, { ...input, target: { ...target, return_bps: null } });
    assert.equal(horizonOnly.settings.target, null);
    assert.deepEqual(horizonOnly.settings.horizon, saved.settings.horizon);
    assert.equal(horizonOnly.forecast.horizon_days, 28);

    const revision = (await getWalletSettings(first.id))?.accessRevision;
    assert(revision !== undefined);
    const grant = await signWalletStatusGrant(first.id, revision);
    assert(grant);
    const request = (walletGrant: string, token = process.env.SHARKAI_WALLET_STATUS_SERVICE_SECRET, body = '{}') =>
      new Request('https://example.invalid/api/internal/wallet-investments/status', {
        method: 'POST', body, headers: { authorization: 'Bearer ' + token, 'X-Shark-Finance-Grant': walletGrant },
      });
    const allowed = await readWalletStatusGrant(request(grant));
    assert.equal(allowed.status, 200);
    const status = await allowed.json();
    assert.equal(status.status,'ok');
    assert.equal(status.source,'shark-ai-backend');
    assert.deepEqual(status.entitlement, { plan: 'FREE', source: 'shark-ai-backend' });
    assert.equal('broker_activity' in status, false);
    assert.equal((await readWalletStatusGrant(request(grant, 'wrong'))).status, 403);
    assert.equal((await readWalletStatusGrant(request(grant, undefined, JSON.stringify({ user_id: second.id })))).status, 400);
    assert.equal((await readWalletStatusGrant(request(grant + 'a'))).status, 403);
    await prisma.user.update({where:{id:first.id},data:{role:'ADMIN'}});
    const chatId = BigInt(1_000_000_000 + Math.floor(Math.random()*1_000_000_000));
    const binding = await prisma.telegramBinding.create({data:{
      id:randomUUID(),userId:first.id,conversationId:randomUUID(),chatId,telegramUserId:chatId,
    }});
    const { authorizeTelegramUpdate } = await import('../lib/telegram-server');
    const update = {update_id:Number(chatId),chat_id:Number(chatId),telegram_user_id:Number(chatId)};
    const telegram = await authorizeTelegramUpdate(update);
    assert(telegram.status === 'authorized' && telegram.finance_grant);
    assert(telegram.permission_context.scopes.includes('finance:status:read'));
    assert.equal((await readWalletStatusGrant(request(telegram.finance_grant))).status,200);
    assert.equal((await authorizeTelegramUpdate(update)).status,'duplicate_update');
    await prisma.telegramBinding.delete({where:{id:binding.id}});
    assert.equal((await readWalletStatusGrant(request(telegram.finance_grant))).status,403);

    const revoked = await revokeWalletAccess(first);
    assert.equal(revoked.settings.ai_access, 'off');
    assert.equal((await readWalletStatusGrant(request(grant))).status, 403);
    await updateWalletSettings(first, input);
    assert.equal((await readWalletStatusGrant(request(grant))).status, 403);
    console.log('Isolated PostgreSQL actor scope, precise values, provider-unconfigured, scoped grant and revocation passed.');
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  }
}

async function main() {
  contractChecks();
  await transportChecks();
  if (process.argv.includes('--with-database')) await databaseChecks();
  console.log('Wallet + Investments money, target validation and mocked W01 transport passed.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
