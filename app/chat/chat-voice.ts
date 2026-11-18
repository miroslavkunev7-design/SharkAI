'use client';

import { useEffect, useRef, useState } from 'react';

type VoiceAction = 'dictation' | 'conversation';
type Language = 'auto' | 'bg' | 'en';
type SpeechLanguage = Exclude<Language, 'auto'>;
type Recording = { action: VoiceAction; controller: AbortController; recorder?: MediaRecorder; stream?: MediaStream; timer?: number };
type Playback = { controller: AbortController; source?: AudioBufferSourceNode };
type Capabilities = { transcription: boolean; speech: SpeechLanguage[] };

const endpoint = '/api/chat/voice';
const recorderTypes = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
const noCapabilities: Capabilities = { transcription: false, speech: [] };

function audioContextClass() {
  const browser = window as Window & { webkitAudioContext?: typeof AudioContext };
  return window.AudioContext ?? browser.webkitAudioContext;
}

function disposeRecording(work: Recording) {
  window.clearTimeout(work.timer);
  work.controller.abort();
  if (work.recorder) {
    work.recorder.onstop = null;
    work.recorder.ondataavailable = null;
    work.recorder.onerror = null;
    if (work.recorder.state !== 'inactive') work.recorder.stop();
  }
  work.stream?.getTracks().forEach((track) => track.stop());
}

function disposePlayback(playback: Playback) {
  playback.controller.abort();
  if (!playback.source) return;
  playback.source.onended = null;
  playback.source.stop();
  playback.source.disconnect();
}

function recordingProblem(error: unknown) {
  if (!(error instanceof DOMException)) return 'Микрофонът не успя да създаде аудиозапис.';
  if (['NotAllowedError', 'SecurityError'].includes(error.name)) return 'Достъпът до микрофона е отказан. Разреши го от настройките на браузъра и системата.';
  if (error.name === 'NotFoundError') return 'Няма наличен микрофон. Свържи микрофон и опитай отново.';
  if (error.name === 'NotReadableError') return 'Микрофонът е недостъпен. Провери дали не се използва от друго приложение.';
  return 'Записът от микрофона не може да се стартира.';
}

async function requestVoice(query: string, body: BodyInit, contentType: string, signal: AbortSignal) {
  const response = await fetch(`${endpoint}?${query}`, { method: 'POST', body, headers: { 'Content-Type': contentType }, signal });
  if (!response.ok) {
    const envelope = await response.json().catch(() => null);
    throw new Error(envelope?.error || 'Гласовата услуга не можа да завърши.');
  }
  return response;
}

export function useChatVoice(enabled: boolean, report: (error: string) => void) {
  const [codec, setCodec] = useState('');
  const [playbackSupported, setPlaybackSupported] = useState(false);
  const [capabilities, setCapabilities] = useState<Capabilities>(noCapabilities);
  const [checking, setChecking] = useState(false);
  const [language, setLanguage] = useState<Language>('auto');
  const [listening, setListening] = useState<VoiceAction | null>(null);
  const [recordStage, setRecordStage] = useState<'permission' | 'recording' | 'transcribing' | null>(null);
  const [speechStage, setSpeechStage] = useState<'preparing' | 'playing' | null>(null);
  const recording = useRef<Recording | null>(null);
  const playback = useRef<Playback | null>(null);
  const audio = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof MediaRecorder !== 'undefined') {
      setCodec(recorderTypes.find((type) => MediaRecorder.isTypeSupported(type)) || '');
    }
    setPlaybackSupported(!!audioContextClass());
    return () => {
      const activeRecording = recording.current;
      const activePlayback = playback.current;
      recording.current = null;
      playback.current = null;
      if (activeRecording) disposeRecording(activeRecording);
      if (activePlayback) disposePlayback(activePlayback);
      if (audio.current && audio.current.state !== 'closed') void audio.current.close().catch(() => {});
      audio.current = null;
    };
  }, []);

  useEffect(() => {
    setCapabilities(noCapabilities);
    if (!enabled || !codec) { setChecking(false); return; }
    setChecking(true);
    const controller = new AbortController();
    fetch(endpoint, { cache: 'no-store', signal: controller.signal }).then(async (response) => {
      if (response.ok && !controller.signal.aborted) setCapabilities(await response.json() as Capabilities);
    }).catch(() => {}).finally(() => {
      if (!controller.signal.aborted) setChecking(false);
    });
    return () => controller.abort();
  }, [enabled, codec]);

  function stopListening() {
    const active = recording.current;
    recording.current = null;
    if (active) disposeRecording(active);
    setListening(null);
    setRecordStage(null);
  }

  function stopSpeaking() {
    const active = playback.current;
    playback.current = null;
    if (active) disposePlayback(active);
    setSpeechStage(null);
  }

  async function listen(action: VoiceAction, onText: (text: string) => void) {
    const active = recording.current;
    if (active) {
      if (active.action === action && active.recorder?.state === 'recording') active.recorder.stop();
      else stopListening();
      return;
    }
    if (!codec || !capabilities.transcription) return;
    if (action === 'conversation') {
      const Context = audioContextClass();
      if (!Context) return;
      try {
        audio.current ??= new Context();
        void audio.current.resume().catch(() => report('Браузърът не разрешава възпроизвеждане на звук.'));
      } catch { report('Браузърът не може да възпроизведе гласовия отговор.'); return; }
    }
    const work: Recording = { action, controller: new AbortController() };
    recording.current = work;
    setListening(action);
    setRecordStage('permission');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: action === 'conversation', autoGainControl: false }, video: false,
      });
      if (recording.current !== work) { stream.getTracks().forEach((track) => track.stop()); return; }
      work.stream = stream;
      const recorder = new MediaRecorder(stream, { mimeType: codec, audioBitsPerSecond: 64000 });
      work.recorder = recorder;
      const chunks: Blob[] = [];
      recorder.ondataavailable = ({ data }) => { if (data.size) chunks.push(data); };
      recorder.onerror = () => { if (recording.current === work) { stopListening(); report('Записът от микрофона е прекъснат.'); } };
      recorder.onstop = async () => {
        window.clearTimeout(work.timer);
        stream.getTracks().forEach((track) => track.stop());
        if (recording.current !== work) return;
        setRecordStage('transcribing');
        try {
          const type = recorder.mimeType || codec;
          const blob = new Blob(chunks, { type });
          const result = await requestVoice(`action=transcribe&language=${language}`, blob, type, work.controller.signal);
          const decoded: { text?: string } = await result.json();
          if (!decoded.text?.trim()) throw new Error('Не беше разпозната реч.');
          if (recording.current === work) { stopListening(); onText(decoded.text.trim()); }
        } catch (error) {
          if (recording.current === work) {
            stopListening();
            report(error instanceof Error ? error.message : 'Записът не можа да се разчете.');
          }
        }
      };
      recorder.start();
      setRecordStage('recording');
      work.timer = window.setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 15_000);
    } catch (error) {
      if (recording.current === work) { stopListening(); report(recordingProblem(error)); }
    }
  }

  async function speak(text: string) {
    const context = audio.current;
    if (!text.trim() || !context || context.state === 'closed') return;
    stopSpeaking();
    const narration = text.replace(/```[\s\S]*?```/g, '').replace(/https?:\/\/\S+/g, '').replace(/[*_#`]+/g, '').replace(/\s+/g, ' ').trim();
    if (!narration) { report('Отговорът няма текст за озвучаване.'); return; }
    const target: SpeechLanguage = /\p{Script=Cyrillic}/u.test(narration) ? 'bg' : 'en';
    if (!capabilities.speech.includes(target)) { report('За езика на отговора няма инсталиран глас.'); return; }
    const current: Playback = { controller: new AbortController() };
    playback.current = current;
    setSpeechStage('preparing');
    try {
      const clip = narration.length <= 1000 ? narration : narration.slice(0, 1000).replace(/\s+\S*$/, '');
      const response = await requestVoice('action=speak', JSON.stringify({ text: clip, language: target }), 'application/json', current.controller.signal);
      const decoded = await context.decodeAudioData(await response.arrayBuffer());
      if (playback.current !== current) return;
      if (context.state !== 'running') throw new Error('Възпроизвеждането на звук е блокирано от браузъра.');
      const source = context.createBufferSource();
      source.buffer = decoded;
      source.connect(context.destination);
      source.onended = () => {
        if (playback.current !== current) return;
        playback.current = null;
        source.disconnect();
        setSpeechStage(null);
        if (narration.length > 1000) report('Озвучена е първата част. Целият отговор е в разговора.');
      };
      source.start();
      current.source = source;
      setSpeechStage('playing');
    } catch (error) {
      if (playback.current === current) {
        stopSpeaking();
        report(error instanceof Error ? error.message : 'Отговорът не можа да се озвучи.');
      }
    }
  }

  const dictationReason = !enabled ? 'Влез, за да използваш диктовка.'
    : !codec ? 'Нужен е защитен браузър с достъп до микрофон и аудиозапис.'
      : checking ? 'Проверявам услугата за разпознаване…'
        : !capabilities.transcription ? 'Липсва достъпна услуга за разпознаване на реч.' : '';
  const voiceReason = dictationReason || (!playbackSupported ? 'Браузърът не поддържа аудиовъзпроизвеждане.'
    : !capabilities.speech.length ? 'Липсва инсталиран глас за отговора.' : '');

  return {
    language, setLanguage, dictation: !dictationReason, voice: !voiceReason, dictationReason, voiceReason,
    listening, recordStage, speaking: !!speechStage, speechStage, listen, stopListening, speak, stopSpeaking,
  };
}
