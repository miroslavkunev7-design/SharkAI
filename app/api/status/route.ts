import { NextResponse } from 'next/server';
import packageInfo from '@/package.json';

export function GET() {
  return NextResponse.json({ ok: true, version: packageInfo.version });
}
