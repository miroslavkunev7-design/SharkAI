import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import {
  setOpenAIKey,
  setAnthropicKey,
  setPaidAIMode,
  getAISettings,
} from '@/lib/settings';
import { clearAIKeyCache } from '@/lib/ai/config';

export async function GET() {
  const session = await getSession();
  const settings = await getAISettings();

  return NextResponse.json({
    ...settings,
    isAdmin: session?.role === 'ADMIN',
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (session?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Само за админ' }, { status: 403 });
  }

  const body = await req.json();
  const { openaiKey, anthropicKey, paidAIEnabled } = body;

  if (typeof paidAIEnabled === 'boolean') {
    await setPaidAIMode(paidAIEnabled);
  }

  if (openaiKey && typeof openaiKey === 'string') {
    if (openaiKey.length < 20) {
      return NextResponse.json({ error: 'Невалиден OpenAI ключ' }, { status: 400 });
    }
    await setOpenAIKey(openaiKey);
  }

  if (anthropicKey && typeof anthropicKey === 'string') {
    if (anthropicKey.length < 20) {
      return NextResponse.json({ error: 'Невалиден Anthropic ключ' }, { status: 400 });
    }
    await setAnthropicKey(anthropicKey);
  }

  clearAIKeyCache();
  const settings = await getAISettings();

  return NextResponse.json({ ok: true, ...settings });
}
