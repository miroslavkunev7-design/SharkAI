import {
  maxSpokenText, maxVoiceInput, synthesizeVoice, transcribeVoice, voiceCapabilities, voiceMimes, VoiceError,
} from './chat-voice.server';
import { saveUpload } from './uploads';

export type VoiceFileTool = 'audio-transcribe' | 'audio-synthesize';

type Language = 'bg' | 'en';

type VoiceFileInput = {
  session: { id: string };
  prompt: string;
  file?: { data: Buffer; mimeType: string };
  contextText?: string;
  signal?: AbortSignal;
  voice?: Awaited<ReturnType<typeof voiceCapabilities>>;
};

const transcribeCommand = /^(?:транскрибира(?:й|ш)|transcribe)(?!\p{L})/iu;
const speakCommand = /^(?:озвучиш?|прочет(?:и|еш) на глас|прочет(?:и|еш) (?:предишния|последния) (?:ти )?отговор на глас|създай (?:wav|аудио)|read aloud|read (?:the )?(?:previous|last) (?:assistant )?(?:answer|reply|response) aloud|synthesize (?:speech|wav))(?!\p{L})/iu;
const transcriptionRequest = /^(?:транскрибира(?:й|ш)|transcribe)(?: (?:прикаченото аудио|прикачения запис|аудио(?:то)?|запис(?:а)?|файл(?:а)?|(?:the |this )?(?:attached )?(?:audio(?: file)?|recording|clip|file)))?(?: (?:на|in) (български|английски|bulgarian|english|bg|en)| (?:с автоматично разпознаване|with automatic language detection))?$/iu;
const spokenText = /^(?:озвучиш?(?: текста)?|прочет(?:и|еш) на глас|създай (?:wav|аудио)|read aloud|speak|synthesize (?:speech|wav)) (?:на|in) (български|английски|bulgarian|english|bg|en)\s*:\s*([\s\S]*)$/iu;
const previousAnswer = /^(?:(?:озвучиш?|прочет(?:и|еш) на глас) (?:предишния|последния) (?:ти )?отговор|прочет(?:и|еш) (?:предишния|последния) (?:ти )?отговор на глас|read (?:the )?(?:previous|last) (?:assistant )?(?:answer|reply|response) aloud) (?:на|in) (български|английски|bulgarian|english|bg|en)$/iu;

function command(prompt: string) {
  return prompt.trim().replace(/^(?:моля|please)[\s,]+/iu, '')
    .replace(/^(?:може(?:ш)? ли да|(?:can|could|would) you)\s+/iu, '');
}

function language(value: string): Language {
  return /^(?:bg|bulgarian|български)$/iu.test(value) ? 'bg' : 'en';
}

export function inferVoiceFileTool(prompt: string): VoiceFileTool | undefined {
  const request = command(prompt);
  if (transcribeCommand.test(request)) return 'audio-transcribe';
  if (speakCommand.test(request) || spokenText.test(request)) return 'audio-synthesize';
}

function transcriptionLanguage(prompt: string): Language | 'auto' {
  const request = command(prompt).replace(/[.!?]+$/u, '').trimEnd().replace(/\s+/gu, ' ');
  const match = transcriptionRequest.exec(request);
  if (!match) throw new VoiceError('Посочи „Транскрибирай аудиото“ или добави „на български“ или „на английски“ като език на записа.', 422);
  return match[1] ? language(match[1]) : 'auto';
}

function speechInput(prompt: string, contextText?: string) {
  const request = command(prompt);
  const literal = spokenText.exec(request);
  const earlier = literal ? undefined : previousAnswer.exec(request.replace(/[.!?]+$/u, '').trimEnd());
  const selected = literal?.[1] ?? earlier?.[1];
  if (!selected) throw new VoiceError('Посочи „Озвучи на български: Текст“ или „Озвучи предишния отговор на английски“.', 422);
  const text = (literal?.[2] ?? contextText)?.trim();
  if (!text) throw new VoiceError(earlier ? 'В разговора няма предишен отговор за озвучаване.' : 'Въведи текст за озвучаване.', 422);
  if (text.length > maxSpokenText) throw new VoiceError(`Озвучаването поддържа до ${maxSpokenText} знака. Съкрати текста или озвучи отделен откъс.`, 413);
  if (text.includes('\0')) throw new VoiceError('Текстът съдържа неподдържан управляващ знак.', 422);
  return { language: language(selected), text };
}

export async function runVoiceFileTool(action: VoiceFileTool, { session, file, prompt, contextText, signal, voice }: VoiceFileInput) {
  const operationSignal = signal ?? new AbortController().signal;
  operationSignal.throwIfAborted();
  let result: { text: string; filename: string; mimeType: 'text/plain' | 'audio/wav'; bytes: Buffer };

  if (action === 'audio-transcribe') {
    const fromLanguage = transcriptionLanguage(prompt);
    if (!file || !voiceMimes.some((mime) => mime === file.mimeType)) {
      throw new VoiceError('Прикачи запис във формат WAV, WebM, Ogg или MP4 аудио.', 415);
    }
    if (file.data.length > maxVoiceInput) throw new VoiceError('Аудиофайлът надхвърля 2 MiB.', 413);
    if (!file.data.length) throw new VoiceError('Аудиофайлът е празен.', 422);
    const capability = voice ?? await voiceCapabilities();
    operationSignal.throwIfAborted();
    if (!capability.transcription || !capability.completeClip) {
      throw new VoiceError('Няма конфигурирано пълно разпознаване на приложени аудиофайлове.', 503);
    }
    const text = await transcribeVoice(file.data, file.mimeType, fromLanguage, operationSignal, { completeClip: true });
    result = { text, filename: 'SharkAI-транскрипция.txt', mimeType: 'text/plain', bytes: Buffer.from(text, 'utf8') };
  } else {
    const input = speechInput(prompt, contextText);
    const { speech } = voice ?? await voiceCapabilities();
    operationSignal.throwIfAborted();
    if (!speech.includes(input.language)) {
      throw new VoiceError(input.language === 'bg' ? 'Няма конфигуриран български глас.' : 'Няма конфигуриран английски глас.', 503);
    }
    const bytes = await synthesizeVoice(input.text, input.language, operationSignal);
    result = {
      text: input.language === 'bg' ? 'Озвучаването на български е готово.' : 'Озвучаването на английски е готово.',
      filename: `SharkAI-озвучаване-${input.language}.wav`, mimeType: 'audio/wav', bytes,
    };
  }

  operationSignal.throwIfAborted();
  const { id, mimeType } = await saveUpload(result.bytes, result.mimeType, session.id);
  const url = `/api/upload/${id}`;
  return { id, status: 'completed' as const, text: result.text, url, artifact: { url, uploadId: id, mimeType, filename: result.filename } };
}
