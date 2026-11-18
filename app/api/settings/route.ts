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
  if (session?.role === 'ADMIN') return NextResponse.json({ ...settings, isAdmin: true });

  return NextResponse.json({
    ...settings,
    openai: { hasKey: settings.openai.hasKey, preview: null },
    anthropic: { hasKey: settings.anthropic.hasKey, preview: null },
    isAdmin: false,
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (session?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Само за администратор.' }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Невалидни настройки.' }, { status: 400 });
  const { openaiKey, anthropicKey, paidAIEnabled } = body;
  if (openaiKey !== undefined && (typeof openaiKey !== 'string' || openaiKey.trim().length < 20)) {
    return NextResponse.json({ error: 'Невалиден OpenAI ключ.' }, { status: 400 });
  }
  if (anthropicKey !== undefined && (typeof anthropicKey !== 'string' || anthropicKey.trim().length < 20)) {
    return NextResponse.json({ error: 'Невалиден Anthropic ключ.' }, { status: 400 });
  }
  if (paidAIEnabled !== undefined && typeof paidAIEnabled !== 'boolean') {
    return NextResponse.json({ error: 'Невалидна настройка за AI.' }, { status: 400 });
  }

  if (openaiKey) await setOpenAIKey(openaiKey);
  if (anthropicKey) await setAnthropicKey(anthropicKey);
  if (typeof paidAIEnabled === 'boolean') await setPaidAIMode(paidAIEnabled);

  clearAIKeyCache();
  return NextResponse.json({ ok: true, ...await getAISettings() });
}
