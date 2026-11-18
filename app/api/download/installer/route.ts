import { NextResponse } from 'next/server';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { getInstallerInfo } from '@/lib/installer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const info = getInstallerInfo();
  if (!info) return NextResponse.json({ error: 'Инсталаторът за тази версия още не е достъпен.' }, { status: 404 });
  if (info.source === 'external') return NextResponse.redirect(info.url, 302);

  const file = createReadStream(path.join(process.cwd(), 'release', info.name));
  return new Response(Readable.toWeb(file) as ReadableStream<Uint8Array>, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${info.name}"`,
      'Content-Length': String(info.size),
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
