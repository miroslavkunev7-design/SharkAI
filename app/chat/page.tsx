'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { Logo } from '@/components/Logo';
import {
  Send, ImageIcon, Loader2, Brain, Sparkles,
  LayoutDashboard, Shield, Settings, X, Rocket,
} from 'lucide-react';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  imageUrl?: string;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingDeep, setLoadingDeep] = useState(false);
  const [thinkingLabel, setThinkingLabel] = useState('Мисля...');
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [user, setUser] = useState<{ name: string; role: string; plan: string } | null>(null);
  const [aiMode, setAiMode] = useState<'ai' | 'local'>('local');
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const scrollDown = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    fetch('/api/chat').then((r) => r.json()).then((d) => {
      if (d.messages?.length) {
        setMessages(d.messages.map((m: { id: string; role: string; content: string; imagePath?: string }) => ({
          id: m.id,
          role: m.role as 'user' | 'assistant',
          content: m.content,
          imageUrl: m.imagePath ? `/api/upload/${m.imagePath}` : undefined,
        })));
      } else {
        setMessages([{
          id: 'welcome',
          role: 'assistant',
          content: 'Здравей! Аз съм Supreme Brain — говорим за **всичко**: ежедневие, чувства, наука, работа, хобита, технологии, или просто „как си".\n\nНяма ограничения — питай каквото искаш. Ако поискаш код или проект, казваш и 15-те агента работят.',
        }]);
      }
    });
    fetch('/api/projects').then((r) => r.json()).then((d) => {
      if (d.user) setUser({ ...d.user, role: d.user.role || 'USER' });
    });
    setAiMode('local');
  }, []);

  useEffect(() => { scrollDown(); }, [messages, scrollDown]);

  async function uploadImage(file: File) {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    if (!res.ok) {
      alert('Грешка при качване на снимка');
      return null;
    }
    const data = await res.json();
    setUploadId(data.uploadId);
    setImagePreview(data.previewUrl);
    return data.uploadId as string;
  }

  async function startBuildFromChat(text: string, imgId?: string | null, featureId?: string) {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: text.slice(0, 50) || 'Chat Project',
        description: text || 'Проект от Supreme Brain чат',
        type: 'website',
        inputType: imgId ? 'screenshot' : 'prompt',
        featureId: featureId || (imgId ? 'screenshot-website' : 'prompt-software'),
        uploadId: imgId,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const projectId = data.project.id as string;
    setMessages((prev) => [...prev, {
      id: `build-${Date.now()}`,
      role: 'assistant',
      content: `🚀 Генерирам код и ZIP 1:1… Проект \`${projectId.slice(0, 8)}\``,
    }]);
    return projectId;
  }

  async function pollBuildAndNotify(projectId: string) {
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await fetch(`/api/projects/${projectId}`);
      if (!res.ok) continue;
      const data = await res.json();
      if (data.project.status === 'COMPLETED') {
        setMessages((prev) => [...prev, {
          id: `done-${Date.now()}`,
          role: 'assistant',
          content: `✅ Готово! ${data.fileCount} файла.\nPreview: ${data.previewUrl}\nDownload ZIP: ${data.downloadUrl}`,
        }]);
        return;
      }
      if (data.project.status === 'FAILED') {
        setMessages((prev) => [...prev, {
          id: `fail-${Date.now()}`,
          role: 'assistant',
          content: '❌ Генерацията не успя. Опитай отново в Studio.',
        }]);
        return;
      }
    }
  }

  function isInstantMessage(text: string) {
    const t = text.trim().toLowerCase();
    if (!t) return true;
    if (t.length < 18 && !t.includes('?')) return true;
    return /^(здрав|привет|как си|какво става|благодар|thanks|hello|hi|hey|чао|ок|да|не|хаха|лол|lol|йо|yo)$/i.test(t);
  }

  async function sendMessage() {
    if (!input.trim() && !uploadId) return;
    const userMsg: Message = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: input.trim() || '📷 [снимка]',
      imageUrl: imagePreview || undefined,
    };
    setMessages((prev) => [...prev, userMsg]);
    const text = input.trim();
    const currentUpload = uploadId;
    setInput('');
    const instant = isInstantMessage(text) && !currentUpload;
    setLoadingDeep(!instant);
    setThinkingLabel(instant ? '...' : text.length > 100 ? 'Анализирам...' : 'Мисля...');
    setLoading(true);

    const history = [...messages, userMsg]
      .filter((m) => m.id !== 'welcome')
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history, uploadId: currentUpload }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = await res.json();
      setMessages((prev) => [...prev, {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: data.content || 'Няма отговор.',
      }]);
      if (data.mode) setAiMode(data.mode);

      const explicitBuild = /^давай|започни|генерирай сега|build now|start now|направи го|пусни build/i.test(text);
      const shouldBuild = data.suggestBuild || explicitBuild;

      if (shouldBuild && (currentUpload || text.length > 3)) {
        const pid = await startBuildFromChat(
          data.buildPrompt || text || 'Проект от чат',
          currentUpload,
          data.featureId
        );
        if (pid) pollBuildAndNotify(pid);
      }
    } catch {
      setMessages((prev) => [...prev, {
        id: `err-${Date.now()}`,
        role: 'assistant',
        content: 'Възникна грешка. Опитай отново.',
      }]);
    } finally {
      setLoading(false);
      setUploadId(null);
      setImagePreview(null);
    }
  }

  const isAdmin = user?.role === 'ADMIN';

  return (
    <div className="min-h-screen bg-shark-black flex flex-col">
      <header className="glass border-b border-white/5 shrink-0">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Logo size="sm" />
            <div>
              <span className="font-display font-bold gradient-text">Supreme Brain</span>
              <p className="text-xs text-white/40">
                Свободен разговор за всичко
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/dashboard" className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1">
              <LayoutDashboard className="w-3 h-3" /> Studio
            </Link>
            {isAdmin && (
              <>
                <Link href="/admin" className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1">
                  <Shield className="w-3 h-3" /> Admin
                </Link>
                <Link href="/admin#settings" className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1">
                  <Settings className="w-3 h-3" />
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
          {messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                msg.role === 'user'
                  ? 'bg-shark-gradient text-white'
                  : 'glass text-white/90'
              }`}>
                {msg.role === 'assistant' && (
                  <div className="flex items-center gap-1 mb-2 text-shark-cyan text-xs">
                    <Brain className="w-3 h-3" /> Supreme Brain
                  </div>
                )}
                {msg.imageUrl && (
                  <img src={msg.imageUrl} alt="" className="max-h-40 rounded-lg mb-2 object-contain" />
                )}
                <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.content}</p>
              </div>
            </div>
          ))}
          {loading && loadingDeep && (
            <div className="flex justify-start">
              <div className="glass rounded-2xl px-4 py-3 flex items-center gap-2 text-sm text-white/50">
                <Loader2 className="w-4 h-4 animate-spin text-shark-cyan" /> {thinkingLabel}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="shrink-0 border-t border-white/5 glass p-4">
        <div className="max-w-3xl mx-auto">
          {imagePreview && (
            <div className="relative inline-block mb-3">
              <img src={imagePreview} alt="" className="h-20 rounded-lg border border-shark-cyan/30" />
              <button onClick={() => { setUploadId(null); setImagePreview(null); }} className="absolute -top-2 -right-2 bg-red-500 rounded-full p-1">
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
          <div className="flex gap-2">
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) await uploadImage(f);
            }} />
            <button onClick={() => fileRef.current?.click()} className="btn-secondary p-3 shrink-0" title="Качи снимка">
              <ImageIcon className="w-5 h-5" />
            </button>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), sendMessage())}
              placeholder="Питай за всичко — как си, съвет, наука, работа, идеи…"
              className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-shark-cyan/50"
              disabled={loading}
            />
            <button onClick={sendMessage} disabled={loading || (!input.trim() && !uploadId)} className="btn-primary p-3 shrink-0">
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
            </button>
          </div>
          <p className="text-xs text-white/30 mt-2 text-center flex items-center justify-center gap-1">
            <Sparkles className="w-3 h-3" />
            Свободен чат за всичко · Build с 15 агенти когато кажеш „давай"
            <Rocket className="w-3 h-3" />
          </p>
        </div>
      </div>
    </div>
  );
}
