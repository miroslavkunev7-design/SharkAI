import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { getImageJobStatus, ImageJobError, updateImageJob } from '@/lib/image-jobs';

export const runtime = 'nodejs';
export const maxDuration = 180;

type Context = { params: Promise<{ id: string }> };
const headers = { 'Cache-Control': 'private, no-store' };

async function respond(context: Context, request?: NextRequest) {
  try {
    const user = await getSession();
    if (!user) throw new ImageJobError('Влез в акаунта си.', 401);
    const { id } = await context.params;
    if (!z.string().uuid().safeParse(id).success) throw new ImageJobError('Задачата за изображение не е намерена.', 404);
    if (!request) return NextResponse.json({ job: await getImageJobStatus(id, user.id) }, { headers });
    const action = z.object({ action: z.enum(['cancel', 'retry']) }).safeParse(await request.json().catch(() => null));
    if (!action.success) throw new ImageJobError('Невалидно действие.');
    return NextResponse.json({ job: await updateImageJob(id, user.id, action.data.action) }, { headers });
  } catch (error) {
    if (error instanceof ImageJobError) return NextResponse.json({ error: error.message, ...(error.code && { code: error.code }) }, { status: error.status, headers });
    console.error('Image job route failed:', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json({ error: 'Статусът на изображението не може да се зареди.' }, { status: 500, headers });
  }
}

export function GET(_request: NextRequest, context: Context) {
  return respond(context);
}

export function POST(request: NextRequest, context: Context) {
  return respond(context, request);
}
