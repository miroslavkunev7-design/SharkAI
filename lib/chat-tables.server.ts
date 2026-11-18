import { execFile } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { supportsLocalTableAnalysis } from './table-request.mjs';
import { saveUpload, validateUpload } from './uploads';

export { supportsLocalTableAnalysis };

const maxInputBytes = 4 * 1024 * 1024;
const maxOutputBytes = 1 * 1024 * 1024;
const maxWorkers = 2;
const csvMime = 'text/csv';
const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const dependencies = [
  'csv-parse', 'saxes', 'xmlchars', 'yauzl', 'pend',
  'sharp', 'detect-libc', 'semver', '@img',
];
const workerModules = ['table-worker.mjs', 'table-request.mjs', 'bounded-zip.mjs'];
let activeWorkers = 0;
let probe: { timestamp: number; result: Promise<boolean> } | undefined;

export class LocalTableError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}

function runWorker(input?: Buffer, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const root = process.cwd();
  const code = workerModules.flatMap((name) => ['--ro-bind', path.join(root, 'lib', name), `/app/lib/${name}`]);
  const packages = dependencies.flatMap((name) => ['--ro-bind-try', path.join(root, 'node_modules', name), `/app/node_modules/${name}`]);
  const system = ['/usr/lib', '/usr/lib64', '/lib', '/lib64', '/usr/share/fonts', '/usr/share/fontconfig', '/etc/fonts']
    .flatMap((name) => ['--ro-bind-try', name, name]);

  return new Promise<string>((resolve, reject) => {
    const child = execFile('/usr/bin/bwrap', [
      '--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--new-session', '--clearenv', '--cap-drop', 'ALL',
      ...system, ...code, ...packages,
      '--ro-bind', process.execPath, '/runtime/node', '--ro-bind', '/usr/bin/prlimit', '/runtime/prlimit',
      '--dev', '/dev', '--proc', '/proc', '--size', '33554432', '--tmpfs', '/tmp', '--chdir', '/tmp',
      '--setenv', 'HOME', '/tmp', '--setenv', 'XDG_CACHE_HOME', '/tmp', '--setenv', 'LANG', 'C.UTF-8',
      '--setenv', 'UV_THREADPOOL_SIZE', '2', '--setenv', 'VIPS_CONCURRENCY', '1',
      '/runtime/prlimit', '--as=2147483648', '--cpu=8', '--nproc=96', '--nofile=64', '--fsize=1048576', '--core=0',
      '--', '/runtime/node', '--max-old-space-size=120', '--max-semi-space-size=12', '/app/lib/table-worker.mjs',
      ...(input ? [] : ['--probe']),
    ], { encoding: 'utf8', maxBuffer: maxOutputBytes * 2, timeout: 10_000, killSignal: 'SIGKILL', signal, env: { NODE_ENV: 'production' } }, (error, stdout) => {
      if (error?.killed && error.signal === 'SIGKILL') reject(new LocalTableError('Табличният анализ отне твърде много време.', 504));
      else if (error) reject(error);
      else resolve(stdout);
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

export function hasIsolatedTableWorker(): Promise<boolean> {
  if (process.platform !== 'linux') return Promise.resolve(false);
  if (!probe || Date.now() - probe.timestamp > 60_000) {
    probe = {
      timestamp: Date.now(),
      result: runWorker().then((output) => JSON.parse(output)?.ready === true).catch(() => false),
    };
  }
  return probe.result;
}

const outcome = z.union([
  z.object({ result: z.object({
    text: z.string().min(1).max(16_000),
    mimeType: z.enum([csvMime, 'image/png']),
    filename: z.enum(['sharkai-table-summary.csv', 'sharkai-chart.png']),
    artifact: z.string().min(1).max(Math.ceil(maxOutputBytes / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  }) }),
  z.object({ failure: z.object({ message: z.string().min(1).max(280), status: z.union([z.literal(413), z.literal(422)]) }) }),
]);

export async function runLocalTableAnalysis({
  file, prompt, userId, signal,
}: {
  file: { data: Buffer; mimeType: string };
  prompt: string;
  userId: string;
  signal?: AbortSignal;
}) {
  signal?.throwIfAborted();
  if (!supportsLocalTableAnalysis(prompt)) {
    throw new LocalTableError('Локалната справка поддържа сума, средно, минимум, максимум, празни клетки и графика по стойности. За друго изчисление използвай разширения анализ.');
  }
  if (file.data.length > maxInputBytes) throw new LocalTableError('Локалният анализ приема таблици до 4 MB.', 413);
  if (![csvMime, xlsxMime].includes(file.mimeType)) throw new LocalTableError('Прикачи CSV или XLSX файл.');
  if (!(await hasIsolatedTableWorker())) {
    throw new LocalTableError('Липсва изолирана Linux среда за локален анализ на таблици.', 503);
  }
  signal?.throwIfAborted();
  if (activeWorkers >= maxWorkers) throw new LocalTableError('Локалните процеси за таблици са заети. Опитай отново след малко.', 503);

  activeWorkers += 1;
  let output;
  try {
    const frame = Buffer.from(JSON.stringify({ prompt, mimeType: file.mimeType }) + '\n');
    const stdout = await runWorker(Buffer.concat([frame, file.data]), signal);
    const parsed = outcome.safeParse(JSON.parse(stdout));
    if (!parsed.success) throw new LocalTableError('Изолираната среда не върна валиден табличен резултат.', 502);
    if ('failure' in parsed.data) throw new LocalTableError(parsed.data.failure.message, parsed.data.failure.status);
    output = parsed.data.result;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof LocalTableError) throw error;
    throw new LocalTableError('Изолираният табличен процес прекъсна. Провери формата и размера на файла.', 502);
  } finally {
    activeWorkers -= 1;
  }

  signal?.throwIfAborted();
  const content = Buffer.from(output.artifact, 'base64');
  if (content.length > maxOutputBytes || !validateUpload(content, output.mimeType)) {
    throw new LocalTableError('Изолираната среда не върна валиден CSV или PNG файл.', 502);
  }
  const saved = await saveUpload(content, output.mimeType, userId);
  const url = `/api/upload/${saved.id}`;
  return { id: saved.id, text: output.text, url, artifact: { url, mimeType: saved.mimeType, filename: output.filename } };
}
