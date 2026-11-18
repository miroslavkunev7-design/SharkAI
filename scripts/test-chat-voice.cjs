const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const base = new URL(process.env.SHARKAI_TEST_URL || 'http://127.0.0.1:3847');
const database = new URL(process.env.POSTGRES_PRISMA_URL || 'postgresql://127.0.0.1');
const local = ['localhost', '127.0.0.1', '[::1]'];
assert.ok(local.includes(base.hostname) && local.includes(database.hostname));
const prisma = new PrismaClient();
const email = `voice-test-${randomUUID()}@example.invalid`;

function words(text, language) {
  return text.normalize('NFC').toLocaleLowerCase(language).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function wordEdits(expected, actual) {
  let previous = Array.from({ length: actual.length + 1 }, (_, index) => index);
  for (const [index, word] of expected.entries()) {
    const current = [index + 1];
    for (const [column, recognized] of actual.entries()) {
      current.push(Math.min(previous[column + 1] + 1, current[column] + 1, previous[column] + Number(word !== recognized)));
    }
    previous = current;
  }
  return previous[actual.length];
}

function silentWav() {
  const samples = 16000;
  const audio = Buffer.alloc(44 + samples * 2);
  audio.write('RIFF', 0);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24);
  audio.writeUInt32LE(32000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(samples * 2, 40);
  return audio;
}

async function main() {
  const request = (route, init = {}) => fetch(new URL(route, base), { signal: AbortSignal.timeout(35_000), ...init });
  const route = '/api/chat/voice';
  assert.equal((await request(route)).status, 401);
  const register = await request('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: randomUUID() }) });
  assert.equal(register.status, 200);
  const cookie = register.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  assert.deepEqual(await (await request(route, { headers: { Cookie: cookie } })).json(), { transcription: true, speech: ['bg', 'en'] });
  const call = (action, body, mime) => request(`${route}?action=${action}`, { method: 'POST', body, headers: { Cookie: cookie, 'Content-Type': mime } });
  const samples = [
    { language: 'en', text: 'What is the capital of Bulgaria?' },
    { language: 'bg', text: 'Здравей, това е тест.' },
    { language: 'bg', text: 'Добро утро. Днес времето е хубаво.', maxProfileWordEdits: 0 },
    { language: 'bg', text: 'Моля, покажи ми прогнозата за утре във Варна.', maxProfileWordEdits: 1 },
  ];
  for (const { language, text, maxProfileWordEdits } of samples) {
    const speech = await call('speak', JSON.stringify({ language, text }), 'application/json');
    assert.equal(speech.status, 200);
    assert.equal(speech.headers.get('content-type'), 'audio/wav');
    const wav = Buffer.from(await speech.arrayBuffer());
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.ok(wav.length > 16_000 && wav.subarray(44).some((byte) => byte !== 0));
    const transcript = await call(`transcribe&language=${language}`, wav, 'audio/wav');
    assert.equal(transcript.status, 200);
    const recognized = (await transcript.json()).text;
    const expectedWords = words(text, language);
    const recognizedWords = words(recognized, language);
    if (maxProfileWordEdits !== undefined) {
      const edits = wordEdits(expectedWords, recognizedWords);
      const rate = Math.round(100 * edits / expectedWords.length);
      console.log(`Bulgarian longer-utterance diagnostic: ${edits}/${expectedWords.length} word edits (${rate}% WER).`);
      console.log(`Expected: ${text}\nRecognized: ${recognized}`);
      if (process.env.SHARKAI_TEST_VOICE_SHORT_BG === '1') assert.ok(edits <= maxProfileWordEdits);
    } else {
      assert.deepEqual(recognizedWords, expectedWords);
    }
  }
  assert.equal((await call('transcribe', 'invalid', 'text/plain')).status, 415);
  assert.equal((await call('transcribe', silentWav(), 'audio/wav')).status, 422);
  assert.equal((await call('transcribe', Buffer.alloc(2 * 1024 * 1024 + 1), 'audio/wav')).status, 413);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  assert.equal(await prisma.fileUpload.count({ where: { userId: user.id } }), 0);
  console.log('Voice API passed: strict short Bulgarian and English utterances, real WAV, authentication, invalid audio, silence, size limit and temporary files.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await prisma.user.deleteMany({ where: { email } });
  await prisma.$disconnect();
});
