import assert from 'node:assert/strict';
import { SHARK_ASSISTANT_TEXT_LIMIT, sendSharkChatMessage } from '../lib/shark-assistant.server';

async function main() {
  process.env.SHARKAI_N8N_AGENT_KEY = 'synthetic-shark-key';
  const signal = new AbortController().signal;
  const request = { userId: 'owner', conversationId: 'conversation', requestId: 'request', message: 'Здравей', signal };
  const calls: { owner: string; conversation: string; message: string }[] = [];
  let mismatch = false;
  const send: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://imotinadezhda.app.n8n.cloud/webhook/shark-ai/module-1/webhook');
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('X-Shark-Agent-Key'), 'synthetic-shark-key');
    assert.equal(headers.get('X-Shark-Finance-Grant'), null);
    assert.equal(headers.get('X-Shark-Commerce-Grant'), null);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.channel, 'webhook');
    assert.equal(body.request_id, request.requestId);
    assert.deepEqual(body.attachments, []);
    assert.deepEqual(body.permission_context, { scopes: ['module:read'] });
    calls.push({ owner: body.user_id, conversation: body.conversation_id, message: body.message });
    return Response.json({ status: 'ok', channel: 'webhook', request_id: mismatch ? 'wrong-request' : body.request_id, reply: 'Здравейте' });
  };
  const entry = (role: string, content: string, extra = {}) => ({ role, content, imagePath: null, attachmentMime: null, toolResult: null, ...extra });
  const previous = [entry('user', 'Предишен въпрос'), entry('assistant', 'Предишен отговор')];

  assert.deepEqual(await sendSharkChatMessage({ ...request, history: [] }, send), { status: 'ok', reply: 'Здравейте' });
  assert.equal(calls[0].message, request.message);

  await sendSharkChatMessage({ ...request, history: [
    entry('user', 'Стара заявка'), entry('assistant', 'Стар резултат', { toolResult: { toolId: 'fixture' } }), ...previous,
  ] }, send);
  assert.deepEqual(JSON.parse(calls[1].message.split('\n')[1]), {
    previous_turns: [{ user: 'Предишен въпрос', assistant: 'Предишен отговор' }], current_message: request.message,
  });
  assert.equal(calls[1].conversation, calls[0].conversation);

  await sendSharkChatMessage({ ...request, userId: 'another-owner', history: [] }, send);
  assert.notEqual(calls[2].conversation, calls[0].conversation);
  assert.equal(calls[2].owner, 'another-owner');

  await sendSharkChatMessage({
    ...request, history: [...previous, entry('user', 'Частен файл', { imagePath: 'private-file' }), entry('assistant', 'Съдържание')],
  }, send);
  assert.equal(calls[3].message, request.message);

  const long = 'a'.repeat(SHARK_ASSISTANT_TEXT_LIMIT);
  await sendSharkChatMessage({ ...request, message: long, history: previous }, send);
  assert.equal(calls[4].message, long);
  assert.equal(await sendSharkChatMessage({ ...request, message: long + 'a', history: [] }, send), null);
  assert.equal(calls.length, 5);

  const turns = Array.from({ length: 4 }, (_, i) => [entry('user', 'Въпрос ' + i), entry('assistant', 'Отговор ' + i)]).flat();
  await sendSharkChatMessage({ ...request, history: turns }, send);
  assert.equal(JSON.parse(calls[5].message.split('\n')[1]).previous_turns.length, 3);
  assert(!calls[5].message.includes('Въпрос 0'));

  await sendSharkChatMessage({ ...request, history: [entry('user', 'x'.repeat(5_000)), entry('assistant', 'Отговор')] }, send);
  assert.equal(calls[6].message, request.message);

  mismatch = true;
  assert.equal(await sendSharkChatMessage({ ...request, history: [] }, send), null);
  assert.equal(await sendSharkChatMessage({ ...request, history: [] }, async () => { throw new TypeError('transport'); }), null);
  await assert.rejects(() => sendSharkChatMessage({ ...request, signal: AbortSignal.abort(), history: [] }, send), { name: 'AbortError' });
  assert.equal(calls.length, 8);
  console.log('Shark Assistant transport, context bounds, owner isolation, fallback and cancellation passed.');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
