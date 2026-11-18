import { NextResponse } from 'next/server';
import packageInfo from '@/package.json';

export function GET() {
  const commit = [process.env.VERCEL_GIT_COMMIT_SHA, process.env.SHARKAI_BUILD_REVISION]
    .map((value) => value?.trim().toLowerCase())
    .find((value) => value && /^[0-9a-f]{40}$/.test(value));
  return NextResponse.json({ ok: true, version: packageInfo.version, ...(commit && { commit }) });
}
