import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { listChatTools } from '@/lib/chat-tools.server';

export const runtime = 'nodejs';

export async function GET() {
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    const session = await getSession();
    return NextResponse.json({ tools: await listChatTools(session) }, { headers });
  } catch (error) {
    console.error('Tool discovery failed:', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json({ error: 'Инструментите временно не могат да се заредят.' }, { status: 503, headers });
  }
}
