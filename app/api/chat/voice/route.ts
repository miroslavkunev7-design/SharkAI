import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession } from '@/lib/auth';
import {
  boundedVoiceBody, maxSpokenText, maxVoiceInput, synthesizeVoice, transcribeVoice, voiceCapabilities, VoiceError, voiceMimes,
} from '@/lib/chat-voice.server';

export const runtime = 'nodejs';
export const maxDuration = 45;
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

export async function GET() {
  if (!await getSession()) return NextResponse.json({ error: 'Влез, за да използваш гласовите функции.' }, { status: 401, headers });
  return NextResponse.json(await voiceCapabilities(), { headers });
}

export async function POST(req: NextRequest) {
  try {
    if (!await getSession()) throw new VoiceError('Влез, за да използваш гласовите функции.', 401);
    const action = req.nextUrl.searchParams.get('action');
    const mime = req.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (action === 'transcribe') {
      if (!mime || !voiceMimes.some((type) => type === mime)) throw new VoiceError('Форматът на аудиото не се поддържа.', 415);
      const language = z.enum(['auto', 'bg', 'en']).safeParse(req.nextUrl.searchParams.get('language') || 'auto');
      if (!language.success) throw new VoiceError('Невалиден език за разпознаване.', 400);
      const data = await boundedVoiceBody(req.body, maxVoiceInput);
      return NextResponse.json({ text: await transcribeVoice(data, mime, language.data, req.signal) }, { headers });
    }
    if (action === 'speak') {
      if (mime !== 'application/json') throw new VoiceError('Въведи текст за озвучаване.', 415);
      const data = await boundedVoiceBody(req.body, 6000);
      const input = z.object({ text: z.string().trim().min(1).max(maxSpokenText), language: z.enum(['bg', 'en']) })
        .safeParse(JSON.parse(data.toString('utf8')));
      if (!input.success) throw new VoiceError('Невалиден текст или език за озвучаване.', 400);
      const audio = await synthesizeVoice(input.data.text, input.data.language, req.signal);
      return new NextResponse(new Uint8Array(audio), { headers: { ...headers, 'Content-Type': 'audio/wav' } });
    }
    throw new VoiceError('Непознато гласово действие.', 400);
  } catch (error) {
    if (req.signal.aborted) return NextResponse.json({ error: 'Гласовата заявка е прекъсната.' }, { status: 499, headers });
    const status = error instanceof VoiceError ? error.status : error instanceof SyntaxError ? 400 : 502;
    const message = error instanceof VoiceError ? error.message : 'Гласовата заявка не можа да завърши.';
    return NextResponse.json({ error: message }, { status, headers });
  }
}
