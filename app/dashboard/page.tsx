'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Logo } from '@/components/Logo';
import {
  Upload, Mic, Video, MessageSquare, Play, Loader2,
  FolderOpen, Sparkles, ArrowLeft, ExternalLink, Download,
  CheckCircle2, FileCode, Brain, X, ImageIcon,
  Monitor, Smartphone, Laptop, Cloud, Gamepad2, Figma, FileText,
  Database, Code2, Bug, Rocket, BookOpen, Shield,
} from 'lucide-react';
import { AGENTS, AUTONOMOUS_LOOP, FEATURES, getFeature, type Feature } from '@/lib/agents';

const featureIcons: Record<string, React.ElementType> = {
  monitor: Monitor, smartphone: Smartphone, laptop: Laptop, cloud: Cloud,
  gamepad: Gamepad2, message: MessageSquare, mic: Mic, video: Video,
  figma: Figma, file: FileText, database: Database, api: Code2,
  bug: Bug, code: Code2, rocket: Rocket, book: BookOpen, check: CheckCircle2, shield: Shield,
};

interface Project {
  id: string;
  name: string;
  type: string;
  status: string;
  qualityScore: number;
  createdAt: string;
}

interface AgentRun {
  agentId: string;
  agentName: string;
  output: string;
  status: string;
}

interface ProjectAnalysis {
  understanding: string;
  feature?: string;
  featureTitle?: string;
  sections: string[];
  colors: string[];
}

interface ProjectDetail {
  project: Project & { analysis?: ProjectAnalysis | null };
  files: string[];
  fileCount: number;
  agents: AgentRun[];
  previewUrl: string | null;
  downloadUrl: string | null;
}

function DashboardContent() {
  const searchParams = useSearchParams();
  const initialFeature = searchParams.get('feature') || 'screenshot-website';

  const [selectedFeature, setSelectedFeature] = useState<Feature>(getFeature(initialFeature));
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeDetail, setActiveDetail] = useState<ProjectDetail | null>(null);
  const [activeLoop, setActiveLoop] = useState(-1);
  const [completedAgents, setCompletedAgents] = useState<string[]>([]);
  const [user, setUser] = useState<{ name: string; plan: string; role?: string } | null>(null);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [uploadKind, setUploadKind] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const f = searchParams.get('feature');
    if (f) setSelectedFeature(getFeature(f));
  }, [searchParams]);

  function startVoiceInput() {
    const w = window as unknown as Record<string, unknown>;
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR || typeof SR !== 'function') {
      alert('Гласов вход — използвай Chrome или Edge.');
      return;
    }
    const rec = new (SR as new () => {
      lang: string; interimResults: boolean;
      onstart: (() => void) | null; onend: (() => void) | null;
      onresult: ((e: { results: { [i: number]: { [j: number]: { transcript: string } } } }) => void) | null;
      start: () => void;
    })();
    rec.lang = 'bg-BG';
    rec.interimResults = false;
    rec.onstart = () => setListening(true);
    rec.onend = () => setListening(false);
    rec.onresult = (e) => {
      const text = e.results[0]?.[0]?.transcript;
      if (text) setPrompt((p) => (p ? `${p} ${text}` : text));
    };
    rec.start();
  }

  const acceptUpload = selectedFeature.uploadKinds.includes('image')
    ? 'image/png,image/jpeg,image/webp'
    : selectedFeature.uploadKinds.includes('video')
      ? 'video/mp4,video/webm'
      : selectedFeature.uploadKinds.includes('pdf')
        ? 'application/pdf'
        : selectedFeature.uploadKinds.includes('figma')
          ? 'application/json,image/png,image/jpeg'
          : 'image/*,video/*,application/pdf,application/json';

  async function handleFileUpload(file: File): Promise<string | null> {
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: form });
      if (!res.ok) throw new Error('Upload failed');
      const data = await res.json();
      setUploadId(data.uploadId);
      setUploadKind(data.uploadKind);
      setUploadPreview(data.previewUrl || `📎 ${file.name}`);
      return data.uploadId as string;
    } catch {
      alert('Грешка при качване (макс 25MB).');
      return null;
    }
  }

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects');
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects || []);
        if (data.user) setUser(data.user);
      }
    } catch { /* */ }
  }, []);

  const pollProject = useCallback(async (projectId: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}`);
      if (!res.ok) return;
      const data = await res.json();
      setActiveDetail(data);

      const statusToStep: Record<string, number> = {
        ANALYZING: 0, BUILDING: 1, RUNNING: 2, TESTING: 3,
        FIXING: 5, DEPLOYING: 7, COMPLETED: 7, FAILED: -1,
      };
      setActiveLoop(statusToStep[data.project.status] ?? 0);

      if (data.agents?.length) {
        setCompletedAgents(data.agents.map((a: AgentRun) => a.agentName));
      }

      if (data.project.status === 'COMPLETED' || data.project.status === 'FAILED') {
        if (pollRef.current) clearInterval(pollRef.current);
        setLoading(false);
        setActiveLoop(AUTONOMOUS_LOOP.length - 1);
        fetchProjects();
      }
    } catch { /* */ }
  }, [fetchProjects]);

  useEffect(() => {
    fetchProjects();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchProjects]);

  async function startGenerate(forcedUploadId?: string) {
    const id = forcedUploadId || uploadId;
    const needsUpload = !selectedFeature.uploadKinds.includes('none');
    if (!prompt.trim() && !id && needsUpload) return;
    if (!prompt.trim() && selectedFeature.uploadKinds.includes('none') && !id) return;

    setLoading(true);
    setActiveLoop(0);
    setCompletedAgents([]);
    setActiveDetail(null);

    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: prompt.slice(0, 50) || selectedFeature.title,
          description: prompt || selectedFeature.subtitle,
          type: selectedFeature.projectType,
          inputType: selectedFeature.inputType,
          featureId: selectedFeature.id,
          uploadId: id,
          uploadKind,
        }),
      });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setActiveProjectId(data.project.id);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => pollProject(data.project.id), 800);
      await pollProject(data.project.id);
    } catch {
      setLoading(false);
      alert('Генерацията не стартира.');
    }
  }

  const isComplete = activeDetail?.project.status === 'COMPLETED';
  const needsFile = !selectedFeature.uploadKinds.includes('none');

  return (
    <div className="min-h-screen bg-shark-black">
      <header className="glass border-b border-white/5 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-white/50 hover:text-white"><ArrowLeft className="w-5 h-5" /></Link>
            <Logo size="sm" />
            <span className="font-display font-bold gradient-text">SharkAI Studio</span>
          </div>
          <div className="flex items-center gap-3">
            {user && <span className="text-sm text-white/50 hidden sm:block">{user.name} · <span className="text-shark-cyan">{user.plan}</span></span>}
            <Link href="/chat" className="btn-secondary text-sm py-2 px-4">Chat</Link>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="mb-6">
          <h2 className="font-display text-lg font-bold mb-3 flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-shark-cyan" /> 18 Features — Multi-Agent
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 max-h-48 overflow-y-auto pr-1">
            {FEATURES.map((f) => {
              const Icon = featureIcons[f.icon] || Code2;
              const active = selectedFeature.id === f.id;
              return (
                <button
                  key={f.id}
                  onClick={() => { setSelectedFeature(f); setUploadId(null); setUploadPreview(null); }}
                  className={`text-left p-3 rounded-xl text-xs transition-all ${active ? 'bg-shark-gradient text-white ring-2 ring-shark-cyan/50' : 'glass hover:bg-white/10'}`}
                >
                  <Icon className="w-4 h-4 mb-1 opacity-80" />
                  <p className="font-medium leading-tight">{f.title}</p>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <div className="glass rounded-2xl p-6">
              <h3 className="font-semibold text-shark-cyan mb-1">{selectedFeature.title}</h3>
              <p className="text-sm text-white/50 mb-4">{selectedFeature.subtitle}</p>

              <input
                ref={fileInputRef}
                type="file"
                accept={acceptUpload}
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const id = await handleFileUpload(file);
                    if (id && needsFile) await startGenerate(id);
                  }
                }}
              />

              {uploadPreview ? (
                <div className="relative mb-4 rounded-xl overflow-hidden border border-shark-cyan/30 p-3 bg-black/30">
                  {uploadPreview.startsWith('/') ? (
                    <img src={uploadPreview} alt="" className="w-full max-h-40 object-contain" />
                  ) : (
                    <p className="text-sm text-shark-cyan">{uploadPreview}</p>
                  )}
                  <button onClick={() => { setUploadPreview(null); setUploadId(null); }} className="absolute top-2 right-2 p-1 bg-black/70 rounded-full">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : needsFile ? (
                <div onClick={() => fileInputRef.current?.click()} className="border-2 border-dashed border-white/20 rounded-xl p-5 text-center hover:border-shark-cyan/50 cursor-pointer mb-4">
                  <Upload className="w-7 h-7 mx-auto mb-2 text-shark-cyan" />
                  <p className="text-sm text-white/60">Качи файл за {selectedFeature.title}</p>
                </div>
              ) : null}

              <div className="relative mb-4">
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Опиши проекта на български или английски…"
                  className="w-full h-28 bg-white/5 border border-white/10 rounded-xl p-4 pr-14 text-white placeholder:text-white/30 focus:outline-none focus:border-shark-cyan/50 resize-none"
                />
                {(selectedFeature.inputType === 'voice' || selectedFeature.inputType === 'prompt') && (
                  <button type="button" onClick={startVoiceInput} className={`absolute right-3 bottom-3 p-2 rounded-xl ${listening ? 'bg-red-500/80 animate-pulse' : 'bg-shark-gradient'}`}>
                    <Mic className="w-5 h-5" />
                  </button>
                )}
              </div>

              <button onClick={() => startGenerate()} disabled={loading || (!prompt.trim() && !uploadId)} className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50">
                {loading ? <><Loader2 className="w-5 h-5 animate-spin" /> Multi-Agent Build…</> : <><Play className="w-5 h-5" /> Generate with 15 Agents</>}
              </button>
            </div>

            {(loading || activeDetail) && (
              <div className="glass rounded-2xl p-6">
                <h3 className="font-semibold mb-4 text-shark-cyan flex items-center gap-2">
                  {isComplete ? <><CheckCircle2 className="w-5 h-5 text-green-400" /> Ready</> : <>Autonomous Loop</>}
                </h3>
                <div className="flex flex-wrap gap-2 mb-4">
                  {AUTONOMOUS_LOOP.map((step, i) => (
                    <div key={step.step} className={`px-3 py-1.5 rounded-lg text-xs ${i <= activeLoop ? 'bg-shark-gradient text-white' : 'bg-white/5 text-white/30'}`}>
                      {step.label}
                    </div>
                  ))}
                </div>

                {activeDetail?.project.analysis?.understanding && (
                  <div className="bg-shark-blue/10 border border-shark-cyan/20 rounded-xl p-4 mb-4">
                    <p className="text-xs text-shark-cyan font-semibold mb-2 flex items-center gap-1"><Brain className="w-4 h-4" /> Supreme Brain</p>
                    <p className="text-sm text-white/80">{activeDetail.project.analysis.understanding}</p>
                    {activeDetail.project.analysis.featureTitle && (
                      <p className="text-xs text-white/40 mt-2">Feature: {activeDetail.project.analysis.featureTitle}</p>
                    )}
                  </div>
                )}

                {completedAgents.length > 0 && (
                  <div className="mb-4 max-h-40 overflow-y-auto space-y-1">
                    {completedAgents.map((name, i) => (
                      <p key={i} className="text-xs text-green-400/80 font-mono">✓ {name}</p>
                    ))}
                  </div>
                )}

                {isComplete && activeDetail && (
                  <div className="space-y-4">
                    <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4">
                      <p className="text-green-400 font-medium">✓ {activeDetail.fileCount} files · {activeDetail.project.qualityScore.toFixed(0)}%</p>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      {activeDetail.previewUrl && (
                        <a href={activeDetail.previewUrl} target="_blank" rel="noopener noreferrer" className="btn-primary text-sm py-2 px-4 flex items-center gap-2">
                          <ExternalLink className="w-4 h-4" /> Preview
                        </a>
                      )}
                      {activeDetail.downloadUrl && (
                        <a href={activeDetail.downloadUrl} download className="btn-primary text-sm py-2 px-4 flex items-center gap-2">
                          <Download className="w-4 h-4" /> Download ZIP
                        </a>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {activeDetail.files.slice(0, 20).map((f) => (
                        <span key={f} className="text-xs bg-white/5 px-2 py-0.5 rounded font-mono text-shark-cyan">{f}</span>
                      ))}
                      {activeDetail.files.length > 20 && <span className="text-xs text-white/40">+{activeDetail.files.length - 20} more</span>}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="space-y-6">
            <div className="glass rounded-2xl p-5">
              <h3 className="font-semibold mb-3 text-sm">15 Agents</h3>
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {AGENTS.map((a) => {
                  const done = completedAgents.includes(a.name);
                  return (
                    <div key={a.id} className={`p-2 rounded-lg text-xs ${done ? 'bg-green-500/10 border border-green-500/20' : 'bg-white/5'}`}>
                      <p className="font-medium text-shark-cyan">{a.id} · {a.name}</p>
                      <p className="text-white/40">{a.description}</p>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="glass rounded-2xl p-5">
              <h3 className="font-semibold mb-3 flex items-center gap-2"><FolderOpen className="w-4 h-4" /> Projects</h3>
              {projects.length === 0 ? (
                <p className="text-sm text-white/40">No projects yet</p>
              ) : (
                <div className="space-y-2">
                  {projects.slice(0, 6).map((p) => (
                    <button key={p.id} onClick={() => { setActiveProjectId(p.id); pollProject(p.id); }} className="w-full text-left bg-white/5 rounded-lg p-2 hover:bg-white/10 text-sm">
                      <span className="truncate block">{p.name}</span>
                      <span className="text-xs text-white/40">{p.status} · {p.qualityScore.toFixed(0)}%</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-shark-black flex items-center justify-center text-white/50">Loading Studio…</div>}>
      <DashboardContent />
    </Suspense>
  );
}
