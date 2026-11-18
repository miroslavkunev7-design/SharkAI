import sharp from 'sharp';

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const maxOutputBytes = 5 * 1024 * 1024;
const serviceUnavailable = 'Локалният доставчик за изображения е недостъпен.';

const instructionPrefix = /^(?:(?:please|моля)[,\s]+)?(?:(?:edit|revise|modify)\s+(?:this|the|attached)\s+(?:image|photo|picture)|(?:редактирай|промени)\s+(?:снимката|изображението|картинката))\s*[:,–—-]\s*/iu;
const sameScenePrefix = /^(?:make\s+the\s+same|keep\s+the\s+same|запази\s+(?:същата|същия|същото))\s+/iu;
const physicalBook = /\b(?:notebook|sketchbook|mockup|spiral[- ]bound|open book|book on|printed on)\b|тефтер|скицник|отворена книга|макет/iu;
const timeOfDay = /\s+(?:at|under|with)\s+((?:[a-z][a-z-]{0,24} ){0,4}(?:sunset|sunrise|golden hour|blue hour))(?=[,.!?]|$)/iu;
const preserveFrame = /\b(?:keep|preserve)\s+(?:(?:the|its)\s+)?(?:same |existing )?(?:composition|framing|layout)\b|запази\s+(?:(?:същата|същото)\s+)?(?:композицията|кадъра|оформлението)/iu;
const transformFrame = /\b(?:restyle|redraw|reimagine)\b|\b(?:turn|transform|convert)\s+(?:(?:the|this)\s+)?(?:image|photo|picture|it)\s+into\b|(?:прерисувай|преобразувай)|превърни\s+(?:я|го|изображението|снимката)\s+в/iu;
const sunsetLighting = /\b(?:at|under|with|in)\s+(?:(?:a|an|the|vivid|bright|soft|deep)\s+){0,3}(?:orange|amber|golden|warm)\s+sunset\b|(?:при|със?|на|към)\s+(?:яр(?:ък|ко)\s+)?(?:оранжев|кехлибарен|златист|топъл)\s+залез/iu;
const rejectSunset = /\b(?:avoid|without|no|not)\s+(?:a\s+|an\s+|any\s+)?(?:(?:orange|amber|golden|warm)\s+)?sunset\b|без\s+(?:(?:оранжев|кехлибарен|златист|топъл)\s+)?залез/iu;

export function localImageEditMode(instruction: string) {
  return transformFrame.test(instruction) && !preserveFrame.test(instruction) ? 'transform' : 'preserve';
}

export function wantsSunsetLighting(instruction: string) {
  return localImageEditMode(instruction) === 'preserve' && sunsetLighting.test(instruction) && !rejectSunset.test(instruction);
}

/** Shift blue-dominant light while retaining edges, luminance differences and the source frame. */
export async function applySunsetLighting(input: Buffer) {
  const { data, info: { width, height, channels } } = await sharp(input, { limitInputPixels: 512 * 512 })
    .toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += channels) {
    const red = data[i], green = data[i + 1], blue = data[i + 2];
    if (blue <= green || blue <= red) continue;
    const blend = Math.min(1, (blue - red) / 86) * Math.min(1, (blue - green) / 40);
    const lightness = red * .2126 + green * .7152 + blue * .0722;
    const warmRed = Math.min(255, lightness * 1.38 + 27);
    const warmGreen = Math.min(255, lightness * .96 + 12);
    const warmBlue = lightness * .44 + 9;
    data[i] = Math.round(red + (warmRed - red) * blend);
    data[i + 1] = Math.round(green + (warmGreen - green) * blend);
    data[i + 2] = Math.round(blue + (warmBlue - blue) * blend);
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

/** Image-to-image models read a caption, including words that refer to physical objects. */
export function describeLocalImageEdit(instruction: string) {
  const source = instruction.trim();
  let prompt = source.replace(instructionPrefix, '').replace(sameScenePrefix, '');
  if (!physicalBook.test(prompt)) {
    prompt = prompt.replace(/\b(?:children['’]s )?book illustration\b/giu, 'illustration')
      .replace(/илюстрация за (?:детска )?книга/giu, 'илюстрация');
  }
  const lighting = prompt.match(timeOfDay);
  if (lighting) prompt = `${lighting[1]}, ${prompt.replace(timeOfDay, '')}`;
  return prompt.trim() || source;
}

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
      body: JSON.stringify({
        prompt: file ? describeLocalImageEdit(prompt) : prompt,
        image: file?.data.toString('base64'), mimeType: file?.mimeType,
        edit: file ? { mode: localImageEditMode(prompt) } : undefined,
      }),
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
  let data: Buffer = Buffer.concat(chunks, total);
  if (data.length < 33 || !data.subarray(0, 8).equals(pngSignature) || data.toString('ascii', 12, 16) !== 'IHDR') {
    throw new LocalImageError('Локалният доставчик не върна валидно PNG изображение.', 502);
  }
  if (file && wantsSunsetLighting(prompt)) {
    data = await applySunsetLighting(data).catch(() => {
      throw new LocalImageError('Цветовата обработка не можа да се приложи към резултата.', 502);
    });
    signal?.throwIfAborted();
  }
  return { data, mimeType: 'image/png' };
}
