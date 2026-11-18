import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { changePersonalMemory, MemoryError, memoryInput, readPersonalMemory } from '@/lib/personal-memory.server';

const headers = { 'Cache-Control': 'private, no-store' };

async function withOwner(run: (userId: string) => Promise<NextResponse>) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Влез, за да управляваш личните бележки.' }, { status: 401, headers });
    return await run(session.id);
  } catch (error) {
    if (error instanceof MemoryError) return NextResponse.json({ error: error.message }, { status: error.status, headers });
    console.error('Personal memory failed:', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json({ error: 'Личните бележки временно са недостъпни.' }, { status: 503, headers });
  }
}

export function GET() {
  return withOwner(async (userId) => NextResponse.json(await readPersonalMemory(userId), { headers }));
}

export function PATCH(req: NextRequest) {
  return withOwner(async (userId) => {
    const input = memoryInput.safeParse(await req.json().catch(() => null));
    if (!input.success) {
      return NextResponse.json({ error: 'Провери текста и действието за личната бележка.' }, { status: 400, headers });
    }
    return NextResponse.json(await changePersonalMemory(userId, input.data), { headers });
  });
}
