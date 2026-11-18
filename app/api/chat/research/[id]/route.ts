import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { getResearchStatus, ResearchInputError, updateResearch } from '@/lib/research';

export const runtime = 'nodejs';
export const maxDuration = 60;

type Context = { params: Promise<{ id: string }> };
const headers = { 'Cache-Control': 'private, no-store' };

async function respond(context: Context, request?: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: 'Влез в акаунта си.' }, { status: 401, headers });
    const { id } = await context.params;
    if (!z.string().uuid().safeParse(id).success) throw new ResearchInputError('Проучването не е намерено.', 404);
    if (!request) return NextResponse.json({ job: await getResearchStatus(id, user.id) }, { headers });
    const input = z.object({ action: z.enum(['cancel', 'retry']) }).safeParse(await request.json().catch(() => null));
    if (!input.success) throw new ResearchInputError('Невалидно действие.');
    return NextResponse.json({ job: await updateResearch(id, user.id, input.data.action) }, { headers });
  } catch (error) {
    if (error instanceof ResearchInputError) return NextResponse.json({ error: error.message }, { status: error.status, headers });
    console.error('Research status failed:', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json({ error: 'Статусът на проучването не може да се зареди.' }, { status: 500, headers });
  }
}

export function GET(_req: NextRequest, context: Context) {
  return respond(context);
}

export function PATCH(req: NextRequest, context: Context) {
  return respond(context, req);
}
