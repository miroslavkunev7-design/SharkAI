import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { validateUpload } from './uploads';

type Language = 'eng' | 'bul';
type DocumentTools = { ocrLanguages: Language[]; pdfText: boolean; pdfOcr: boolean };
type Probe = DocumentTools & { languageFiles: Array<[Language, string]> };
const none: Probe = { ocrLanguages: [], pdfText: false, pdfOcr: false, languageFiles: [] };
const maxInputBytes = 12 * 1024 * 1024;
const maxImagePixels = 16_000_000;
const maxTextBytes = 192 * 1024;
const maxPdfPages = 10;
const maxScannedPages = 3;
const maxRenderedSide = 2400;
const maxWorkers = 2;
const languages: Language[] = ['eng', 'bul'];
const tesseract = '/usr/bin/tesseract';
const pdfInfo = '/usr/bin/pdfinfo';
const pdfToText = '/usr/bin/pdftotext';
const pdfToPng = '/usr/bin/pdftoppm';
let activeWorkers = 0;
let availability: { timestamp: number; result: Promise<Probe> } | undefined;

export class LocalDocumentError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}

function isolatedCommand(
  executable: string, args: string[], { input, signal, maxBuffer = maxTextBytes, languageFiles = [] }: {
    input?: Buffer; signal?: AbortSignal; maxBuffer?: number; languageFiles?: Probe['languageFiles'];
  } = {},
) {
  signal?.throwIfAborted();
  const trainingData = languageFiles.flatMap(([language, file]) => ['--ro-bind', file, `/tessdata/${language}.traineddata`]);
  const trainingOptions = trainingData.length ? ['--dir', '/tessdata', ...trainingData, '--setenv', 'TESSDATA_PREFIX', '/tessdata'] : [];
  return new Promise<Buffer>((resolve, reject) => {
    const child = execFile('/usr/bin/bwrap', [
      '--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--new-session', '--clearenv', '--cap-drop', 'ALL',
      '--ro-bind', executable, executable, '--ro-bind', '/usr/bin/prlimit', '/usr/bin/prlimit',
      '--ro-bind-try', '/usr/lib', '/usr/lib', '--ro-bind-try', '/usr/lib64', '/usr/lib64',
      '--ro-bind-try', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
      '--ro-bind-try', '/usr/share/fonts', '/usr/share/fonts', '--ro-bind-try', '/usr/share/fontconfig', '/usr/share/fontconfig',
      '--ro-bind-try', '/usr/share/poppler', '/usr/share/poppler', '--ro-bind-try', '/usr/share/tesseract-ocr', '/usr/share/tesseract-ocr',
      '--ro-bind-try', '/etc/fonts', '/etc/fonts', '--dev', '/dev', '--proc', '/proc',
      '--size', '33554432', '--tmpfs', '/tmp', '--chdir', '/tmp', '--setenv', 'HOME', '/tmp',
      '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'OMP_THREAD_LIMIT', '1', ...trainingOptions,
      '/usr/bin/prlimit', '--as=805306368', '--cpu=6', '--fsize=8388608', '--core=0', '--nproc=32', '--nofile=64', '--', executable, ...args,
    ], { encoding: 'buffer', maxBuffer, timeout: 8_000, killSignal: 'SIGKILL', signal, env: { NODE_ENV: 'production' } }, (error, stdout) => {
      if (error?.killed && error.signal === 'SIGKILL') reject(new LocalDocumentError('Локалното разчитане отне твърде много време.', 504));
      else if (error) reject(error);
      else resolve(stdout);
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

async function probeTools(): Promise<Probe> {
  if (process.platform !== 'linux') return none;
  const directory = process.env.SHARKAI_OCR_TESSDATA_DIR;
  const languageFiles: Probe['languageFiles'] = [];
  if (directory && path.isAbsolute(directory)) {
    for (const language of languages) {
      const file = path.join(directory, `${language}.traineddata`);
      const metadata = await stat(file).catch(() => null);
      if (metadata?.isFile() && metadata.size > 0 && metadata.size <= 24 * 1024 * 1024) languageFiles.push([language, file]);
    }
  }
  const [availableText, availableInfo, availableRender, detectedLanguages] = await Promise.all([
    isolatedCommand(pdfToText, ['-v']).then(() => true, () => false),
    isolatedCommand(pdfInfo, ['-v']).then(() => true, () => false),
    isolatedCommand(pdfToPng, ['-v']).then(() => true, () => false),
    isolatedCommand(tesseract, ['--list-langs'], { languageFiles }).then((result) => result.toString('utf8'), () => ''),
  ]);
  const ocrLanguages = languages.filter((language) => detectedLanguages.split(/\r?\n/).includes(language));
  const pdfText = availableText && availableInfo;
  return { languageFiles, ocrLanguages, pdfText, pdfOcr: pdfText && availableRender && ocrLanguages.length > 0 };
}

function capabilities() {
  if (!availability || Date.now() - availability.timestamp > 60_000) {
    availability = { timestamp: Date.now(), result: probeTools().catch(() => none) };
  }
  return availability.result;
}

export async function getLocalDocumentTools(): Promise<DocumentTools> {
  const { ocrLanguages, pdfText, pdfOcr } = await capabilities();
  return { ocrLanguages, pdfText, pdfOcr };
}

export function isLocalExtractionRequest(prompt: string) {
  return !/(?:преведи|превод|обобщи|обобщение|резюме|анализирай|тълкувай|обясни|\b(?:translat\w*|summari[sz]\w*|summary|analy[sz]\w*|explain|interpret)\b)/iu.test(prompt);
}

function selectLanguages(prompt: string, installed: Language[]) {
  const explicit = languages.filter((language) => language === 'bul'
    ? /(?:на български|кирилица|\bbulgarian\b)/iu.test(prompt)
    : /(?:на английски|\benglish\b)/iu.test(prompt));
  if (explicit.some((language) => !installed.includes(language))) {
    throw new LocalDocumentError('За избрания език липсва обучен файл на Tesseract. Поддържаните езици са английски и български.', 503);
  }
  if (explicit.length) return explicit;
  if (installed.includes('bul') && /\p{Script=Cyrillic}/u.test(prompt)) return ['bul', ...installed.filter((language) => language !== 'bul')];
  return installed;
}

async function recognizeImage(image: Buffer, installed: Probe, prompt: string, signal: AbortSignal, pdf = false) {
  const picked = selectLanguages(prompt, installed.ocrLanguages);
  if (!picked.length) throw new LocalDocumentError('Липсва локален Tesseract OCR в изолирана среда.', 503);
  const result = await isolatedCommand(tesseract, ['stdin', 'stdout', '-l', picked.join('+'), '--psm', pdf ? '3' : '6'], {
    input: image, signal, languageFiles: installed.languageFiles,
  });
  return result.toString('utf8').trim();
}

async function extractPdf(input: Buffer, installed: Probe, prompt: string, signal: AbortSignal) {
  if (!installed.pdfText) throw new LocalDocumentError('Липсва локален Poppler в изолирана среда.', 503);
  const info = (await isolatedCommand(pdfInfo, ['-'], { input, signal })).toString('utf8');
  const pageCounts = [...info.matchAll(/^Pages:\s*([0-9]+)\s*$/gm)];
  const pages = pageCounts.length === 1 ? Number(pageCounts[0][1]) : 0;
  if (pages < 1 || pages > maxPdfPages) throw new LocalDocumentError(`Локалното разчитане поддържа PDF документи до ${maxPdfPages} страници.`);

  const extracted = (await isolatedCommand(pdfToText, ['-layout', '-enc', 'UTF-8', '-f', '1', '-l', String(pages), '-', '-'], { input, signal }))
    .toString('utf8').split('\f');
  const results = Array.from({ length: pages }, (_, page) => extracted[page]?.trim() || '');
  const unread = results.flatMap((text, index) => text ? [] : [index + 1]);
  if (unread.length && installed.pdfOcr) {
    if (unread.length > maxScannedPages) throw new LocalDocumentError(`Локалният OCR обработва до ${maxScannedPages} страници без текстов слой.`);
    for (const page of unread) {
      const png = await isolatedCommand(pdfToPng, [
        '-f', String(page), '-l', String(page), '-singlefile', '-gray', '-scale-to', String(maxRenderedSide), '-png', '-',
      ], { input, signal, maxBuffer: 8 * 1024 * 1024 });
      if (!validateUpload(png, 'image/png')) throw new LocalDocumentError(`Сканираната страница ${page} не може да се разчете.`);
      results[page - 1] = await recognizeImage(png, installed, prompt, signal, true);
    }
  }
  if (!results.some(Boolean)) {
    if (!installed.pdfOcr) throw new LocalDocumentError('PDF няма текстов слой. Липсва локална среда за OCR на сканирани страници.', 503);
    return '';
  }
  return pages === 1 ? results[0] : results.map((text, index) => `Страница ${index + 1}\n${text || '[Няма разчетен текст]'}`).join('\n\n');
}

export async function readLocalDocument({ file, prompt, signal }: {
  file: { data: Buffer; mimeType: string }; prompt: string; signal?: AbortSignal;
}) {
  signal?.throwIfAborted();
  if (file.data.length > maxInputBytes) throw new LocalDocumentError('Избери изображение или PDF файл до 12 MB.', 413);
  if (!['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'application/pdf'].includes(file.mimeType)
    || !validateUpload(file.data, file.mimeType)) throw new LocalDocumentError('Прикачи валидно изображение или PDF документ.', 415);
  const installed = await capabilities();
  const timeout = AbortSignal.timeout(26_000);
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
  abort.throwIfAborted();
  if (activeWorkers >= maxWorkers) throw new LocalDocumentError('Всички локални OCR процеси са заети. Опитай отново след малко.', 503);
  activeWorkers += 1;
  try {
    let text: string;
    if (file.mimeType === 'application/pdf') {
      text = await extractPdf(file.data, installed, prompt, abort);
    } else {
      const image = await sharp(file.data, { limitInputPixels: maxImagePixels, autoOrient: true }).timeout({ seconds: 4 })
        .resize({ width: 3600, height: 3600, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      abort.throwIfAborted();
      text = await recognizeImage(image, installed, prompt, abort);
    }
    if (!text) throw new LocalDocumentError('Не е разпознат четлив текст. Опитай с по-ясна снимка или PDF с текст.');
    if (Buffer.byteLength(text, 'utf8') > maxTextBytes) throw new LocalDocumentError('Разчетеният текст надхвърля допустимия размер.');
    return { text, status: 'completed' as const };
  } catch (error) {
    signal?.throwIfAborted();
    if (timeout.aborted) throw new LocalDocumentError('Локалното разчитане отне твърде много време.', 504);
    if (error instanceof LocalDocumentError) throw error;
    throw new LocalDocumentError('Файлът не може да се разчете в локалната среда. Провери формата и ограниченията за размер.');
  } finally {
    activeWorkers -= 1;
  }
}
