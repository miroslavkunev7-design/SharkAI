import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { getResearch } from '@/lib/research';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: 'Влез, за да изтеглиш отчета.' }, { status: 401 });
  const { id } = await params;
  const report = z.string().uuid().safeParse(id).success ? await getResearch(id, user.id) : null;
  if (!report || report.status !== 'COMPLETED' || !report.report) {
    return NextResponse.json({ error: 'Отчетът не е достъпен.' }, { status: 404 });
  }
  return new NextResponse(report.report, { headers: {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Disposition': `attachment; filename="SharkAI-Research-${id}.md"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  } });
}
