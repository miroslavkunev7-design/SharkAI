import { NextResponse } from 'next/server';
import packageInfo from '@/package.json';
import { buildRevision, desktopWebRevision } from '@/lib/build-revision';

export function GET() {
  const commit = buildRevision();
  return NextResponse.json({ ok: true, version: packageInfo.version, ...(commit && { commit }), revision: desktopWebRevision() }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
