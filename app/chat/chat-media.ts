'use client';

import { useEffect, useRef, useState } from 'react';

type VoiceAction = 'dictation' | 'conversation';
interface RecognitionEvent { results: ArrayLike<ArrayLike<{ transcript: string }>> }
interface Recognition {
  lang: string;
  start: () => void;
  abort: () => void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

function recognitionClass() {
  const speechWindow = window as SpeechWindow;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

export function useChatMedia(report: (error: string) => void) {
  const [dictation, setDictation] = useState(false);
  const [voice, setVoice] = useState(false);
  const [camera, setCamera] = useState(false);
  const [screen, setScreen] = useState(false);
  const [listening, setListening] = useState<VoiceAction | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const recognition = useRef<Recognition | null>(null);

  useEffect(() => {
    const speechInput = !!recognitionClass();
    setDictation(speechInput);
    setVoice(speechInput && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window);
    setCamera(!!navigator.mediaDevices?.getUserMedia);
    setScreen(!!navigator.mediaDevices?.getDisplayMedia);
    return () => {
      if (recognition.current) {
        recognition.current.onend = null;
        recognition.current.onerror = null;
        recognition.current.abort();
      }
      window.speechSynthesis?.cancel();
    };
  }, []);

  function stopListening() {
    const listener = recognition.current;
    recognition.current = null;
    if (listener) {
      listener.onend = null;
      listener.onerror = null;
      listener.onresult = null;
      listener.abort();
    }
    setListening(null);
  }

  function listen(action: VoiceAction, onText: (text: string) => void) {
    const SpeechRecognition = recognitionClass();
    if (!SpeechRecognition) return;
    if (recognition.current) {
      stopListening();
      return;
    }
    const listener = new SpeechRecognition();
    recognition.current = listener;
    listener.lang = 'bg-BG';
    listener.onresult = (event) => {
      const text = Array.from(event.results, (result) => result[0]?.transcript || '').join(' ').trim();
      if (text) onText(text);
    };
    listener.onend = () => {
      if (recognition.current === listener) {
        recognition.current = null;
        setListening(null);
      }
    };
    listener.onerror = ({ error }) => {
      if (error === 'aborted') return;
      report(error === 'not-allowed' || error === 'service-not-allowed'
        ? 'Браузърът или системата не разрешава достъп до микрофона.'
        : error === 'no-speech' ? 'Не беше разпозната реч. Опитай отново.'
          : 'Разпознаването на реч е недостъпно в момента.');
    };
    try {
      listener.start();
      setListening(action);
    } catch {
      stopListening();
      report('Микрофонът не може да се стартира.');
    }
  }

  function stopSpeaking() {
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }

  function speak(text: string) {
    if (!voice || !text.trim()) return;
    stopSpeaking();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'bg-BG';
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = (event) => {
      setSpeaking(false);
      if (!['canceled', 'interrupted'].includes(event.error)) report('Системният глас не може да прочете този отговор.');
    };
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  }

  return { dictation, voice, camera, screen, listening, speaking, listen, stopListening, speak, stopSpeaking };
}

export async function captureFrame(video: HTMLVideoElement, name: string) {
  if (!video.videoWidth || !video.videoHeight) throw new Error('Изображението все още не е готово.');
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 1920 / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Браузърът не може да обработи изображението.');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blob) throw new Error('Заснемането не успя.');
  return new File([blob], name, { type: blob.type });
}
