'use client';

import { useEffect, useState } from 'react';
import { useChatVoice } from './chat-voice';

export function useChatMedia(enabled: boolean, report: (error: string) => void) {
  const [camera, setCamera] = useState(false);
  const [screen, setScreen] = useState(false);
  const voice = useChatVoice(enabled, report);
  useEffect(() => {
    setCamera(!!navigator.mediaDevices?.getUserMedia);
    setScreen(!!navigator.mediaDevices?.getDisplayMedia);
  }, []);
  return { ...voice, camera, screen };
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
