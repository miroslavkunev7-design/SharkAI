import { z } from 'zod';
import { LocalDocumentError } from './chat-documents.server';

const outputSchema = z.object({ lines: z.array(z.string().max(12_000)).max(36) }).strict();
const maxResponseBytes = 64 * 1024;

function provider() {
  const url = process.env.SHARKAI_TRANSLATION_WORKER_URL?.trim();
  const token = process.env.SHARKAI_TRANSLATION_WORKER_TOKEN?.trim();
  if (!url || !token) return null;
  try {
    const target = new URL(url);
    const loopback = target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);
    if ((!loopback && target.protocol !== 'https:') || target.username || target.password
      || target.pathname !== '/' || target.search || target.hash) return null;
    return { target, token };
  } catch {
    return null;
  }
}

export function hasLocalBulgarianTranslator() {
  return provider() !== null;
}

export async function localBulgarianTranslatorReady() {
  const service = provider();
  if (!service) return false;
  try {
    const response = await fetch(new URL('/health', service.target), {
      headers: { Authorization: `Bearer ${service.token}` },
      signal: AbortSignal.timeout(1200), cache: 'no-store', redirect: 'error',
    });
    await response.body?.cancel();
    return response.status === 204 && response.headers.get('x-sharkai-translation-worker') === '1';
  } catch {
    return false;
  }
}

export async function translateToBulgarianLocally(lines: string[], sourceLanguage: 'en' | 'auto', signal?: AbortSignal) {
  const service = provider();
  if (!service) return null;
  const deadline = AbortSignal.timeout(20_000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const response = await fetch(new URL('/translate', service.target), {
      method: 'POST',
      headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceLanguage, targetLanguage: 'bg', lines }),
      signal: requestSignal, cache: 'no-store', redirect: 'error',
    });
    if (response.headers.get('x-sharkai-translation-worker') !== '1' || !response.ok || !response.body) {
      await response.body?.cancel();
      if (response.status === 422 && response.headers.get('x-sharkai-translation-worker') === '1') return null;
      throw new LocalDocumentError('Локалният доставчик за превод временно не е достъпен.', response.status === 429 ? 429 : 503);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxResponseBytes) {
          await reader.cancel();
          throw new LocalDocumentError('Локалният превод надвишава допустимия размер.', 502);
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const parsed = outputSchema.safeParse(JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')));
    if (!parsed.success) throw new LocalDocumentError('Локалният доставчик върна непълен превод.', 502);
    return parsed.data.lines;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof LocalDocumentError) throw error;
    if (deadline.aborted) throw new LocalDocumentError('Локалният превод не приключи навреме.', 504);
    if (error instanceof SyntaxError) throw new LocalDocumentError('Локалният доставчик върна непълен превод.', 502);
    throw new LocalDocumentError('Локалният доставчик за превод временно не е достъпен.', 503);
  }
}
