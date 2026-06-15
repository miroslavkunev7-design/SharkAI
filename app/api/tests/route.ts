import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

export const runtime = 'nodejs';
export const maxDuration = 300;

const RESULTS_FILE = path.join(process.cwd(), '.test-results.json');
const RELEASE_DIR = path.join(process.cwd(), 'release');

function findInstaller(): string | null {
  if (!fs.existsSync(RELEASE_DIR)) return null;
  const exe = fs.readdirSync(RELEASE_DIR).find((f) => f.endsWith('.exe') && /setup/i.test(f));
  return exe ? path.join(RELEASE_DIR, exe) : null;
}

export async function GET() {
  let data = null;
  if (fs.existsSync(RESULTS_FILE)) {
    try {
      data = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
    } catch { /* */ }
  }

  const installer = findInstaller();
  const installerName = installer ? path.basename(installer) : null;
  const installerSize = installer ? fs.statSync(installer).size : 0;

  return NextResponse.json({
    results: data,
    installer: installer
      ? { available: true, name: installerName, size: installerSize, url: '/api/download/installer' }
      : { available: false, hint: 'Run npm run electron:build' },
  });
}

function runTests(testId?: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const args = ['scripts/test-suite.cjs'];
    if (testId) args.push(`--id=${testId}`);

    const child = spawn('node', args, {
      cwd: process.cwd(),
      env: { ...process.env, TEST_BASE: process.env.TEST_BASE || 'http://localhost:3847' },
      shell: true,
    });

    let output = '';
    child.stdout?.on('data', (d) => { output += d.toString(); });
    child.stderr?.on('data', (d) => { output += d.toString(); });
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const testId = body.testId as string | undefined;

  const { code, output } = await runTests(testId);

  let data = null;
  if (fs.existsSync(RESULTS_FILE)) {
    try {
      data = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
    } catch { /* */ }
  }

  return NextResponse.json({
    ok: code === 0,
    output: output.slice(-3000),
    results: data,
  });
}
