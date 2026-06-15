import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { hasAIProvider, getChatModel } from '@/lib/ai/config';
import { generateText } from 'ai';

export const maxDuration = 30;

export async function POST() {
  const session = await getSession();
  if (session?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Само за админ' }, { status: 403 });
  }

  if (!(await hasAIProvider())) {
    return NextResponse.json({
      ok: false,
      error: 'Платен AI не е включен или липсва API ключ',
    }, { status: 400 });
  }

  const model = await getChatModel();
  if (!model) {
    return NextResponse.json({ ok: false, error: 'Няма наличен AI модел' }, { status: 400 });
  }

  try {
    const { text } = await generateText({
      model,
      prompt: 'Reply with exactly: SharkAI API OK',
      maxOutputTokens: 20,
    });
    return NextResponse.json({ ok: true, reply: text.trim() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'API test failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
