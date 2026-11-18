import { NextRequest, NextResponse } from 'next/server';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getSession } from '@/lib/auth';
import { getInstallerInfo } from '@/lib/installer';
import cases from '@/scripts/test-cases.json';

export const runtime = 'nodejs';
export const maxDuration = 300;

const RESULTS_FILE = path.join(process.cwd(), '.test-results.json');
const TEST_RUNNER = path.join(process.cwd(), 'scripts', 'test-suite.cjs');

async function hasRunner() {
  if (process.env.VERCEL) return false;
  try {
    await access(TEST_RUNNER);
    return true;
  } catch {
    return false;
  }
}

async function results() {
  try { return JSON.parse(await readFile(RESULTS_FILE, 'utf-8')); }
  catch { return null; }
}

export async function GET() {
  if ((await getSession())?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Само за администратор.' }, { status: 403 });
  }

  const installer = getInstallerInfo();
  return NextResponse.json({
    results: await results(),
    runnerAvailable: await hasRunner(),
    installer: installer ? { ...installer, available: true } : { available: false },
  });
}

function runTests(testId?: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const args = testId ? [TEST_RUNNER, `--id=${testId}`] : [TEST_RUNNER];
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, TEST_BASE: process.env.TEST_BASE || 'http://localhost:3847' },
      timeout: 270_000,
      windowsHide: true,
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (data: Buffer) => { output = (output + data.toString()).slice(-3000); });
    }
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

export async function POST(req: NextRequest) {
  if ((await getSession())?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Само за администратор.' }, { status: 403 });
  }
  const input = await req.json().catch(() => null);
  const testId = input?.testId;
  if (!input || typeof input !== 'object' || (testId !== undefined && !cases.some(({ id }) => id === testId))) {
    return NextResponse.json({ error: 'Непозната проверка.' }, { status: 400 });
  }

  if (!(await hasRunner())) {
    return NextResponse.json({ error: 'Тестовият runner не е наличен в тази среда.' }, { status: 503 });
  }
  try {
    const { code, output } = await runTests(testId);
    return NextResponse.json({ ok: code === 0, output, results: await results() });
  } catch {
    return NextResponse.json({ error: 'Тестовият runner не е наличен в тази среда.' }, { status: 503 });
  }
}
