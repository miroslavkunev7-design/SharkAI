import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';

export async function GET() {
  const releaseDir = path.join(process.cwd(), 'release');
  if (!fs.existsSync(releaseDir)) {
    return NextResponse.json(
      { error: 'Installer not built. Run: npm run electron:build' },
      { status: 404 }
    );
  }

  const files = fs.readdirSync(releaseDir);
  const installer = files.find((f) => f.endsWith('.exe') && /setup/i.test(f));
  if (!installer) {
    return NextResponse.json({ error: 'SharkAI-Setup.exe not found in release/' }, { status: 404 });
  }

  const filePath = path.join(releaseDir, installer);
  const buffer = fs.readFileSync(filePath);

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${installer}"`,
      'Content-Length': String(buffer.length),
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
