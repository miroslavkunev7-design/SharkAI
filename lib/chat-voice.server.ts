import { z } from 'zod';

export const voiceMimes = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/x-wav'] as const;
export const maxVoiceInput = 2 * 1024 * 1024;
export const maxSpokenText = 1000;
const maxVoiceOutput = 4 * 1024 * 1024;

const languages = z.enum(['bg', 'en']);
const voiceCapability = z.object({ transcription: z.boolean(), speech: z.array(languages).max(2) });
const noVoice = { transcription: false, speech: [] as ('bg' | 'en')[] };

export class VoiceError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function worker() {
  const configured = process.env.SHARKAI_VOICE_WORKER_URL?.trim();
  const token = process.env.SHARKAI_VOICE_WORKER_TOKEN?.trim();
  if (!configured || !token) return null;
  try {
    const url = new URL(configured);
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((!local && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return { url, token };
  } catch { return null; }
}

async function requestWorker(path: string, options: RequestInit = {}, clientSignal?: AbortSignal, timeout = 30_000) {
  const service = worker();
  if (!service) throw new VoiceError('Липсва конфигуриран сървър за разпознаване и озвучаване.', 503);
  const deadline = AbortSignal.timeout(timeout);
  const signal = clientSignal ? AbortSignal.any([deadline, clientSignal]) : deadline;
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${service.token}`);
  let response: Response;
  try {
    response = await fetch(new URL(path, service.url), { ...options, headers, signal, cache: 'no-store', redirect: 'error' });
  } catch {
    clientSignal?.throwIfAborted();
    if (deadline.aborted) throw new VoiceError('Гласовата заявка отне твърде много време.', 504);
    throw new VoiceError('Сървърът за глас временно е недостъпен.', 503);
  }
  if (response.headers.get('x-sharkai-voice-worker') !== '1' || response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 413) throw new VoiceError('Записът надхвърля допустимия размер.', 413);
    if (response.status === 422) throw new VoiceError('В записа няма разпознаваема реч или форматът не се поддържа.', 422);
    if (response.status === 429) throw new VoiceError('Гласовата услуга обработва друга заявка. Опитай отново.', 429);
    if (response.status === 504) throw new VoiceError('Гласовата заявка отне твърде много време.', 504);
    throw new VoiceError('Сървърът за глас временно е недостъпен.', 503);
  }
  return response;
}

export async function boundedVoiceBody(body: ReadableStream<Uint8Array> | null, maximum: number) {
  if (!body) throw new VoiceError('Липсва аудио или текст за обработка.', 422);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new VoiceError('Гласовата заявка надхвърля допустимия размер.', 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!length) throw new VoiceError('Липсва аудио или текст за обработка.', 422);
  return Buffer.concat(chunks, length);
}

export async function voiceCapabilities() {
  try {
    const response = await requestWorker('/health', {}, undefined, 1800);
    return voiceCapability.parse(JSON.parse((await boundedVoiceBody(response.body, 1024)).toString('utf8')));
  } catch { return noVoice; }
}

export async function transcribeVoice(data: Buffer, mime: string, language: 'bg' | 'en' | 'auto', signal: AbortSignal) {
  const response = await requestWorker('/transcribe', {
    method: 'POST', body: new Uint8Array(data), headers: { 'Content-Type': mime, 'X-SharkAI-Language': language },
  }, signal);
  const transcript = z.object({ text: z.string().trim().min(1).max(6000) })
    .safeParse(JSON.parse((await boundedVoiceBody(response.body, 24_000)).toString('utf8')));
  if (!transcript.success) throw new VoiceError('Гласовата услуга не върна разпознат текст.', 502);
  return transcript.data.text;
}

export async function synthesizeVoice(text: string, language: 'bg' | 'en', signal: AbortSignal) {
  const response = await requestWorker('/speak', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, language }),
  }, signal);
  const wav = await boundedVoiceBody(response.body, maxVoiceOutput);
  if (response.headers.get('content-type') !== 'audio/wav' || wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new VoiceError('Сървърът не върна валиден звук.', 502);
  }
  return wav;
}
