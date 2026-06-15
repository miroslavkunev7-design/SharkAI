import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getInstallerInfo } from '@/lib/installer';

export const runtime = 'nodejs';

export async function GET() {
  const info = getInstallerInfo();

  if (!info) {
    return NextResponse.json(
      { error: 'Installer not available. Run: npm run electron:build or set INSTALLER_DOWNLOAD_URL' },
      { status: 404 }
    );
  }

  if (info.source === 'external') {
    return NextResponse.redirect(info.url, 302);
  }

  const filePath = path.join(process.cwd(), 'release', info.name);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: 'Installer file missing' }, { status: 404 });
  }

  const buffer = fs.readFileSync(filePath);

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${info.name}"`,
      'Content-Length': String(buffer.length),
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
