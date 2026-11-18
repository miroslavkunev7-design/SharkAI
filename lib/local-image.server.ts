const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const maxOutputBytes = 5 * 1024 * 1024;
const serviceUnavailable = 'Локалният доставчик за изображения е недостъпен.';

export class LocalImageError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'LocalImageError';
  }
}

function localImageProvider() {
  const endpoint = process.env.SHARKAI_IMAGE_WORKER_URL?.trim();
  const token = process.env.SHARKAI_IMAGE_WORKER_TOKEN?.trim();
  if (!endpoint || !token) return null;
  try {
    const url = new URL(endpoint);
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((!localHttp && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return { url, headers: { Authorization: `Bearer ${token}` } };
  } catch {
    return null;
  }
}

export async function hasLocalImageProvider(): Promise<boolean> {
  const provider = localImageProvider();
  if (!provider) return false;
  try {
    const response = await fetch(new URL('/health', provider.url), {
      headers: provider.headers,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(1200),
    });
    await response.body?.cancel();
    return response.status === 204 && response.headers.get('x-sharkai-image-worker') === '1';
  } catch {
    return false;
  }
}

export async function runLocalImage({ prompt, file, signal }: {
  prompt: string;
  file?: { data: Buffer; mimeType: string };
  signal?: AbortSignal;
}): Promise<{ data: Buffer; mimeType: 'image/png' }> {
  const provider = localImageProvider();
  if (!provider) throw new LocalImageError(serviceUnavailable, 503);
  const timeout = AbortSignal.timeout(155_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(new URL('/images', provider.url), {
      method: 'POST',
      headers: { ...provider.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, image: file?.data.toString('base64'), mimeType: file?.mimeType }),
      cache: 'no-store',
      redirect: 'error',
      signal: requestSignal,
    });
  } catch {
    signal?.throwIfAborted();
    if (timeout.aborted) throw new LocalImageError('Доставчикът за изображения не приключи навреме.', 504);
    throw new LocalImageError(serviceUnavailable, 503);
  }
  if (response.status !== 200 || response.headers.get('content-type') !== 'image/png' || !response.body) {
    await response.body?.cancel();
    if (response.status === 413) throw new LocalImageError('Изображението надвишава размера за редактиране.', 413);
    if (response.status === 422) throw new LocalImageError('Локалният модел не може да обработи входа.', 422);
    if (response.status === 429) throw new LocalImageError('Доставчикът обработва друго изображение. Опитай отново.', 429);
    if (response.status === 502) throw new LocalImageError('Локалният модел не успя да създаде изображение.', 502);
    if (response.status === 504) throw new LocalImageError('Доставчикът за изображения не приключи навреме.', 504);
    throw new LocalImageError(serviceUnavailable, 503);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxOutputBytes) {
        await reader.cancel();
        throw new LocalImageError('Локалният доставчик върна прекалено голям файл.', 502);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof LocalImageError) throw error;
    if (timeout.aborted) throw new LocalImageError('Доставчикът за изображения не приключи навреме.', 504);
    throw new LocalImageError('Локалният доставчик върна непълен файл.', 502);
  } finally {
    reader.releaseLock();
  }
  const data = Buffer.concat(chunks, total);
  if (data.length < 33 || !data.subarray(0, 8).equals(pngSignature) || data.toString('ascii', 12, 16) !== 'IHDR') {
    throw new LocalImageError('Локалният доставчик не върна валидно PNG изображение.', 502);
  }
  return { data, mimeType: 'image/png' };
}
