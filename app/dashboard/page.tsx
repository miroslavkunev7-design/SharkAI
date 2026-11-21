'use client';
import { announceSessionChange } from '../session-boundary';

import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowRight, ArrowUpRight, CarFront, Code2, Download, FolderOpen, Gauge,
  ImageIcon, LayoutDashboard, LoaderCircle, Menu, MessageSquare, Mic, Plus,
  Search, Settings, ShoppingBag, Sparkles, TrendingUp, Upload, Users, Wallet, X,
} from 'lucide-react';
import { Logo } from '@/components/Logo';
import {
  AGENTS, FEATURES, STUDIO_AGENT_ACTIONS, STUDIO_AGENT_DEPENDENCIES,
  SUPREME_BRAIN, getFeature, getStudioFeatureAvailability,
} from '@/lib/agents';
import { isTerminalStudioStatus, TRACKED_STUDIO_RUNS, type AgentRunActivity } from '@/lib/studio-activity';
import { accountPlanLabel, hasLifetimeUltra, type AccountPlan } from '../account-plan';
import { MemorySettings } from './memory-settings';
import { InvestmentLab } from './investment-lab';
import { Commerce } from './commerce';
import './workspace.css';

const VIEWS = {
  overview: { label: 'Обзор', icon: LayoutDashboard, href: '/dashboard' },
  chat: { label: 'Шарк агент', icon: MessageSquare, href: '/chat' },
  studio: { label: 'Студио', icon: Code2, href: '/dashboard?view=studio' },
  agents: { label: 'Архив на агентите', icon: Users, href: '/dashboard?view=agents' },
  automotive: { label: 'Автомобили', icon: CarFront, href: '/dashboard?view=automotive' },
  investments: { label: 'Инвестиции', icon: TrendingUp, href: '/dashboard?view=investments' },
  commerce: { label: 'Магазин и препродажба', icon: ShoppingBag, href: '/dashboard?view=commerce' },
  settings: { label: 'Настройки', icon: Settings, href: '/dashboard?view=settings' },
};

type View = keyof typeof VIEWS;
const DESTINATIONS = { ...VIEWS, wallet: { label: 'Портфейл', icon: Wallet, href: '/wallet' } };
const NAV_GROUPS = [
  { label: 'Работно пространство', ids: ['overview', 'chat', 'studio'] },
  { label: 'Финанси и търговия', ids: ['wallet', 'investments', 'commerce'] },
  { label: 'Още', ids: ['automotive', 'settings'] },
] as const;
const WORKSPACE_SCENES: Record<keyof typeof DESTINATIONS, string> = {
  overview: 'overview', chat: 'assistant', studio: 'studio', agents: 'team', wallet: 'wallet',
  investments: 'markets', commerce: 'commerce', automotive: 'automotive', settings: 'settings',
};
const ROLE_SCENES: Record<string, string> = {
  eye: 'assistant', layout: 'studio', server: 'connections', database: 'archive',
  cloud: 'workspace', shield: 'security', zap: 'performance', check: 'verification',
  bug: 'diagnostics', wrench: 'tools', rocket: 'health', brain: 'models',
  palette: 'products', search: 'analytics', code: 'documents',
};
const MODULES = [
  { view: 'chat', description: 'Разговори и работа с файлове.' },
  { view: 'studio', description: 'Проекти от описание и скрийншоти.' },
  { view: 'wallet', description: 'Сметки, карти и движения в Wise.' },
  { view: 'investments', description: 'Пазарни графики, стратегии и инвестиционни цели.' },
  { view: 'commerce', description: 'Поръчки, оперативен капитал и реализиран марж.' },
  { view: 'automotive', description: 'Автомобилни материали и диагностика.' },
] as const;
const PROJECT_STATUS: Record<string, string> = {
  ANALYZING: 'Анализира се', BUILDING: 'Създават се файлове', RUNNING: 'Изпълнява се',
  TESTING: 'Проверява се', FIXING: 'Коригира се', DEPLOYING: 'Подготвя се',
  COMPLETED: 'Завършен', FAILED: 'Неуспешен',
};
const BUILD_METHODS: Record<string, string> = {
  reference: 'Начален проект по визуална референция', provider: 'Код от AI доставчик',
  scaffold: 'Начален проект от локален генератор', document: 'Документ от описание',
};
const STUDIO_LABELS: Record<string, string> = {
  'screenshot-website': 'Сайт по скрийншот', 'screenshot-mobile': 'Flutter основа по скрийншот',
  'screenshot-desktop': 'Electron основа по скрийншот', 'screenshot-saas': 'Уеб табло по скрийншот',
  'screenshot-game': 'Canvas интерфейс по скрийншот', 'prompt-software': 'Уеб проект от описание',
  'voice-software': 'Уеб проект от диктовка', 'db-gen': 'Начална схема за база данни',
  'api-gen': 'Начален REST API проект', 'ai-docs': 'Markdown документ от описание',
};
const STUDIO_FEATURES = FEATURES.filter(({ id }) => !getStudioFeatureAvailability(id));
const AGENT_STATUS: Record<AgentRunActivity, string> = {
  running: 'Изпълнява се', completed: 'Завършено', failed: 'Неуспешно', unknown: 'Непотвърден статус',
};

type User = AccountPlan & { name: string | null; email?: string; role: string };
type Project = { id: string; name: string; type: string; status: string; statusUnknown?: boolean; createdAt: string };
type AgentExecution = { id: string; agentName: string; activity: AgentRunActivity; output: string | null };
type ProjectDetail = {
  project: Project & { description: string | null; analysis?: { understanding?: string; buildMethod?: string; feature?: string; runSemantics?: string } | null };
  files: string[];
  fileCount: number;
  agents: AgentExecution[];
  previewUrl: string | null;
  downloadUrl: string | null;
};
type Projects = { projects: Project[]; user: User | null; summary?: { total: number; completed: number; active: number } };
type UploadResult = { uploadId: string; previewUrl: string | null; uploadKind: string; name: string };
type BillingStatus = { period: { currentPeriodStart: string | null; currentPeriodEnd: string | null } | null };

async function json<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Заявката не беше успешна.');
  return data as T;
}

function signIn(href: string) {
  return `/login?next=${encodeURIComponent(href)}`;
}

function ProjectStatus({ project }: { project: Project }) {
  const tone = project.statusUnknown ? 'unknown' : project.status.toLowerCase();
  const label = project.statusUnknown ? 'Непотвърден статус' : PROJECT_STATUS[project.status] || project.status;
  return <span className={`module-status module-status-${tone}`}>{label}</span>;
}

function RoleStatus({ status }: { status: AgentRunActivity }) {
  return <span className={`module-status module-status-${status}`}>{AGENT_STATUS[status]}</span>;
}

function WorkspaceNav({ view, onNavigate }: { view: View; onNavigate?: () => void }) {
  return (
    <nav className="module-nav" aria-label="Работно пространство">
      {NAV_GROUPS.map(({ label, ids }) => (
        <div key={label} className="module-nav-group" role="group" aria-label={label}>
          <span className="module-nav-caption" aria-hidden="true">{label}</span>
          {ids.map((key) => {
            const item = DESTINATIONS[key];
            return <Link key={key} href={item.href} aria-current={view === key ? 'page' : undefined}
              onClick={onNavigate} title={item.label}>
              <item.icon size={19} aria-hidden="true" /><span>{item.label}</span>
            </Link>;
          })}
        </div>
      ))}
    </nav>
  );
}

function WorkspaceBrand({ mobile = false }: { mobile?: boolean }) {
  return (
    <Link href="/" className={`module-brand${mobile ? ' module-mobile-brand' : ''}`} aria-label="SharkAI начало">
      <Logo size={mobile ? 'sm' : 'md'} />
      <span className="module-wordmark" aria-hidden="true">Shark<span>AI</span></span>
    </Link>
  );
}

function Banner({ view, children }: { view: View; children?: ReactNode }) {
  const { icon: Icon, label } = VIEWS[view];
  return (
    <section className="ice-section module-banner" data-scene={WORKSPACE_SCENES[view]} data-scene-tone="light">
      <div>
        <Icon size={24} aria-hidden="true" />
        <h1>{label}</h1>
        {children && <p>{children}</p>}
      </div>
    </section>
  );
}

function WorkspaceSearch({ projects }: { projects: Project[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [term, setTerm] = useState('');
  const query = term.trim().normalize('NFKC').toLocaleLowerCase('bg');
  const entries = [
    ...Object.values(DESTINATIONS).map(({ label, href, icon }) => ({ label, href, icon })),
    ...projects.map(({ name, id }) => ({ label: name, href: `/dashboard?project=${encodeURIComponent(id)}`, icon: FolderOpen })),
  ].filter(({ label }) => label.normalize('NFKC').toLocaleLowerCase('bg').includes(query));

  function open() {
    dialog.current?.showModal();
    field.current?.focus();
  }

  return (
    <>
      <button className="module-utility-button" type="button" aria-label="Търси в работното пространство" aria-haspopup="dialog" onClick={open}>
        <Search size={17} />
      </button>
      <dialog ref={dialog} className="ice-section module-search-dialog" data-scene="workspace" data-scene-tone="light" aria-labelledby="module-search-title"
        onClose={() => setTerm('')}
        onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            dialog.current?.close();
          }
        }}>
        <div className="module-search-content">
          <div className="module-heading">
            <h2 id="module-search-title">Търсене</h2>
            <button className="shark-action-secondary" type="button" onClick={() => dialog.current?.close()} aria-label="Затвори търсенето"><X size={17} /></button>
          </div>
          <label className="module-search-field">
            <span className="sr-only">Търси модул или скорошен проект</span>
            <Search size={16} aria-hidden="true" />
            <input type="search" ref={field} placeholder="Модул или скорошен проект" value={term} onChange={(event) => setTerm(event.target.value)} />
          </label>
          {entries.length ? <ul className="module-search-results">
            {entries.map(({ label, href, icon: Icon }) => (
              <li key={href}><Link href={href} onClick={() => dialog.current?.close()}><Icon size={17} aria-hidden="true" /><span>{label}</span><ArrowRight size={15} aria-hidden="true" /></Link></li>
            ))}
          </ul> : <p role="status">Няма съвпадения.</p>}
        </div>
      </dialog>
    </>
  );
}

function ProjectList({ projects, error, isLoading, onRetry }: {
  projects: Project[]; error?: string; isLoading?: boolean; onRetry: () => void;
}) {
  return (
    <section className="ice-section module-panel" data-scene="projects" data-scene-tone="light" aria-labelledby="module-projects-title">
      <div className="module-heading">
        <h2 id="module-projects-title">Последни проекти</h2>
        <Link className="module-link" href={VIEWS.studio.href}>Студио <ArrowRight size={16} /></Link>
      </div>
      {isLoading ? <p role="status">Зареждане на проектите…</p>
        : error ? <p role="alert">{error} <button type="button" className="module-link" onClick={onRetry}>Опитай отново</button></p>
          : !projects.length ? <p>Тук ще се показват създадените проекти.</p>
            : <ul className="module-project-list">
              {projects.map((project) => (
                <li key={project.id}>
                  <Link href={`/dashboard?project=${encodeURIComponent(project.id)}`}>
                    <FolderOpen size={19} aria-hidden="true" />
                    <span>{project.name}</span>
                    <ProjectStatus project={project} />
                  </Link>
                </li>
              ))}
            </ul>}
    </section>
  );
}

function Overview({ data, loading, error, onRetry }: { data: Projects | null; loading: boolean; error: string; onRetry: () => void }) {
  const projects = data?.projects ?? [];
  const summary = data?.user && !error ? data.summary : null;
  const metrics = [
    { label: 'Проекти', icon: FolderOpen, scene: 'projects', value: summary?.total },
    { label: 'AI роли', icon: Users, scene: 'roles', value: AGENTS.length },
    { label: 'В работа', icon: Gauge, scene: 'activity', value: summary?.active },
    { label: 'Завършени', icon: Sparkles, scene: 'verification', value: summary?.completed },
  ];
  return (
    <>
      <section className="module-overview-hero" data-scene="overview">
        <div className="module-hero-copy">
          <h1>Команден <span>център</span></h1>
          <p>Твоето работно пространство за AI чат, проекти и задачи.</p>
          <div className="module-actions">
            <Link href={VIEWS.chat.href} className="shark-action">Чат с Шарк агент <ArrowRight size={17} aria-hidden="true" /></Link>
            <Link href={VIEWS.studio.href} className="shark-action-secondary">Към Студиото <Code2 size={17} /></Link>
          </div>
        </div>
      </section>
      <dl className="ice-section module-metrics" aria-label="Проекти и AI роли" aria-busy={loading}>
        {metrics.map(({ label, icon: Icon, value, scene }) => (
          <div className="module-metric" key={label} data-scene={scene} data-scene-tone="light">
            <dt><span className="module-metric-icon" aria-hidden="true"><Icon size={19} /></span>{label}</dt>
            <dd>{value ?? <span aria-label={loading ? 'Зареждане' : 'Недостъпни данни'}>{loading ? '…' : '—'}</span>}</dd>
          </div>
        ))}
      </dl>
      <section aria-labelledby="module-cards-title">
        <h2 className="module-section-title" id="module-cards-title">Модули</h2>
        <div className="module-tiles">
          {MODULES.map(({ view, description }) => {
            const { href, label, icon: Icon } = DESTINATIONS[view];
            return (
              <Link key={view} href={href} className="ice-section module-tile" data-scene={WORKSPACE_SCENES[view]} data-scene-tone="light">
                <div><Icon className="module-tile-icon" size={22} aria-hidden="true" /><strong>{label}</strong><p>{description}</p></div>
              </Link>
            );
          })}
        </div>
      </section>
      <ProjectList projects={projects} error={error} isLoading={loading} onRetry={onRetry} />
    </>
  );
}

interface Recognition {
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  start(): void;
  stop(): void;
}

function StudioForm({ featureParam, user, loading, onCreated }: {
  featureParam: string; user: User | null; loading: boolean; onCreated: (id: string) => void;
}) {
  const [featureId, setFeatureId] = useState(featureParam);
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [busyUploading, setBusyUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [speechAvailable, setSpeechAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  const request = useRef<{ payload: string; id: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const recognition = useRef<Recognition | null>(null);
  const feature = getFeature(featureId);
  const needsReference = feature.uploadKinds.includes('image');
  const unavailable = getStudioFeatureAvailability(featureId);

  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    setSpeechAvailable(!!(w.SpeechRecognition || w.webkitSpeechRecognition));
    return () => recognition.current?.stop();
  }, []);

  function dictate() {
    if (recognition.current) { recognition.current.stop(); return; }
    const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    const SpeechRecognition = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    setError('');
    const engine = new SpeechRecognition();
    engine.lang = 'bg-BG';
    engine.onstart = () => setListening(true);
    engine.onend = () => { recognition.current = null; setListening(false); };
    engine.onerror = () => setError('Диктовката прекъсна. Провери разрешението за микрофона.');
    engine.onresult = (event) => {
      const text = event.results[0]?.[0]?.transcript;
      if (text) setPrompt((previous) => [previous, text].filter(Boolean).join(' '));
    };
    recognition.current = engine;
    try { engine.start(); } catch { engine.onerror(); engine.onend(); }
  }

  function removeUpload() {
    setUpload(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  async function uploadFile(file: File) {
    setBusyUploading(true);
    setError('');
    setUpload(null);
    const form = new FormData();
    form.append('file', file);

    try {
      const data = await json<Omit<UploadResult, 'name'>>('/api/upload', { method: 'POST', body: form });
      setUpload({ ...data, name: file.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Качването прекъсна.');
      if (fileInput.current) fileInput.current.value = '';
    } finally {
      setBusyUploading(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || busyUploading || unavailable || !user || (needsReference && !upload) || (!upload && !prompt.trim())) return;
    setError('');
    setSaving(true);
    const body = {
      name: name.trim() || prompt.trim().slice(0, 70) || upload?.name || 'Нов проект',
      description: prompt.trim(),
      type: feature.projectType,
      inputType: feature.inputType,
      featureId,
      uploadId: upload?.uploadId,
      uploadKind: upload?.uploadKind,
    };
    const payload = JSON.stringify(body);
    if (request.current?.payload !== payload) request.current = { payload, id: crypto.randomUUID() };
    try {
      const data = await json<{ project: Project }>('/api/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, requestId: request.current.id }),
      });
      onCreated(data.project.id);
      request.current = null;
      removeUpload();
      setName('');
      setPrompt('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Проектът не стартира.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="module-columns">
      <section className="ice-section module-panel module-panel--form" data-scene="studio" data-scene-tone="light">
        <div className="module-heading"><h2>Нов проект</h2></div>
        {loading ? <p role="status">Зареждане на акаунта…</p> : !user ? (
          <>
            <p>Влез в акаунта си, за да качиш референция и запазиш проект.</p>
            <Link className="shark-action" href={signIn(`/dashboard?feature=${encodeURIComponent(featureParam)}`)}>Вход <ArrowRight size={16} /></Link>
          </>
        ) : (
          <form className="module-form" onSubmit={submit}>
            <div className="module-fields">
              <label>Име на проекта <input value={name} onChange={(event) => setName(event.target.value)} maxLength={70} placeholder="Моят проект" /></label>
              <label>Тип на проекта
                <select onChange={(event) => { setFeatureId(event.target.value); removeUpload(); setError(''); }} value={featureId} disabled={busyUploading || saving}>
                  {unavailable && <option value={featureId}>{feature.title}</option>}
                  {STUDIO_FEATURES.map(({ id, title }) => <option key={id} value={id}>{STUDIO_LABELS[id] ?? title}</option>)}
                </select>
              </label>
            </div>
            {unavailable && <p role="status">{unavailable}</p>}
            {needsReference && !unavailable && (
              <div className="module-upload">
                <input ref={fileInput} type="file" className="sr-only" id="studio-reference" accept="image/png,image/jpeg,image/webp"
                  disabled={busyUploading || saving}
                  onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadFile(file); }} />
                <label htmlFor="studio-reference">
                  {busyUploading ? <LoaderCircle size={22} className="animate-spin" /> : <Upload size={22} />}
                  {busyUploading ? 'Качване…' : upload?.name || 'Избери референтно изображение'}
                  <small>PNG, JPG или WebP</small>
                </label>
                {upload && <button type="button" onClick={removeUpload} className="module-link"><X size={17} /> Премахни файла</button>}
              </div>
            )}
            <label>Описание
              <textarea required={!needsReference} value={prompt} onChange={(event) => setPrompt(event.target.value)}
                maxLength={4000} rows={4} placeholder="Какво трябва да съдържа проектът?" />
            </label>
            {featureId === 'voice-software' && (speechAvailable
              ? <button type="button" className="shark-action-secondary" onClick={dictate}><Mic size={17} />{listening ? 'Спри диктовката' : 'Диктувай описание'}</button>
              : <p>Диктовката изисква браузър с поддръжка на разпознаване на реч.</p>)}
            {error && <p className="module-error" role="alert">{error}</p>}
            <button type="submit" className="shark-action"
              disabled={!!unavailable || saving || busyUploading || (needsReference ? !upload : !prompt.trim())}>
              {saving ? <LoaderCircle size={17} className="animate-spin" /> : <Plus size={17} />}
              {saving ? 'Проектът стартира…' : 'Създай проект'}
            </button>
            <details className="module-disclosure" data-scene="tools" data-scene-tone="light">
              <summary>Липсващи инструменти в Студиото</summary>
              <ul>{FEATURES.filter(({ id }) => getStudioFeatureAvailability(id)).map(({ id, title }) => <li key={id}><strong>{title}</strong><p>{getStudioFeatureAvailability(id)}</p></li>)}</ul>
            </details>
          </form>
        )}
      </section>
      <section className="ice-section module-panel" data-scene="documents" data-scene-tone="light">
        <div className="module-heading"><h2>Визуална референция</h2></div>
        <div className={`module-upload-preview${upload?.previewUrl ? '' : ' module-upload-preview--empty'}`}>
          {upload?.previewUrl
            ? <Image src={upload.previewUrl} alt="Качена визуална референция" width={800} height={450} unoptimized />
            : <div><ImageIcon size={27} /><p>{needsReference ? 'Каченото изображение ще се покаже тук.' : 'Този тип проект използва описание.'}</p></div>}
        </div>
      </section>
    </div>
  );
}

function Result({ detail, error, onRetry }: { detail: ProjectDetail | null; error: string; onRetry: () => void }) {
  const agents = detail?.project.analysis?.runSemantics === TRACKED_STUDIO_RUNS || BUILD_METHODS[detail?.project.analysis?.buildMethod || '']
    ? detail?.agents ?? []
    : [];
  const active = agents.find(({ activity }) => activity === 'running');
  const awaiting = detail?.project.statusUnknown || !!error;
  return (
    <section className="ice-section module-panel" data-scene="projects" data-scene-tone="light" aria-labelledby="studio-result">
      <div className="module-heading">
        <h2 id="studio-result">{detail?.project.name || 'Резултат от Студиото'}</h2>
        {detail && <span role="status"><ProjectStatus project={awaiting ? { ...detail.project, statusUnknown: !isTerminalStudioStatus(detail.project.status) } : detail.project} /></span>}
      </div>
      {error && <p className="module-error" role="alert">{error} <button type="button" className="module-link" onClick={onRetry}>Провери отново</button></p>}
      {!detail && !error && <p role="status"><LoaderCircle size={17} className="inline animate-spin" /> Зареждане на проекта…</p>}
      {detail?.project.status === 'FAILED' && <p role="alert">Студиото не завърши проекта. Прегледай входа и създай нов проект при нужда.</p>}
      {detail?.project.statusUnknown && !error && <p className="module-copy">Сървърът не е потвърдил скорошно изпълнение. <button type="button" className="module-link" onClick={onRetry}>Провери отново</button></p>}
      {active && !awaiting && <p className="module-copy" role="status">{active.agentName} изпълнява задачата.</p>}
      {detail?.project.analysis?.understanding && <p className="module-copy">{detail.project.analysis.understanding}</p>}
      {detail?.project.status === 'COMPLETED' && (
        <>
          <p className="module-copy">{detail.fileCount ? `Запазени файлове: ${detail.fileCount}.` : 'Архивът на този проект е недостъпен.'} {BUILD_METHODS[detail.project.analysis?.buildMethod || '']}</p>
          <div className="module-actions">
            {detail.previewUrl && <a href={detail.previewUrl} target="_blank" rel="noopener noreferrer" className="shark-action-secondary">Преглед <ArrowUpRight size={17} /></a>}
            {detail.downloadUrl && <a href={detail.downloadUrl} download className="shark-action">Изтегли ZIP <Download size={17} /></a>}
          </div>
          {detail.files.length > 0 && (
            <details className="module-disclosure" data-scene="documents" data-scene-tone="light">
              <summary>Файлове</summary>
              <ul className="module-file-list">{detail.files.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
            </details>
          )}
        </>
      )}
      {agents.length > 0 && (
        <details className="module-disclosure" data-scene="activity" data-scene-tone="light" open={agents.some(({ activity }) => activity !== 'completed') || undefined}>
          <summary>Резултати от изпълнението</summary>
          <ul>{agents.map(({ id, activity, agentName, output }) => (
            <li key={id}>
              <div className="module-receipt-heading"><strong>{agentName}</strong><RoleStatus status={awaiting && activity === 'running' ? 'unknown' : activity} /></div>
              {output && <p>{output}</p>}
            </li>
          ))}</ul>
        </details>
      )}
    </section>
  );
}

type AgentReceipt = {
  id: string; agentId: string; activity: AgentRunActivity;
  output: string | null; startedAt: string | null; createdAt: string; project: { id: string; name: string };
};

function Agents({ user, loading }: { user: User | null; loading: boolean }) {
  const [runs, setRuns] = useState<AgentReceipt[] | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const section = window.location.hash.slice(1);
    if (section === 'supreme-brain' || section === 'agent-roles') {
      document.getElementById(section)?.scrollIntoView();
    }
  }, []);
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        if (document.visibilityState !== 'visible') return;
        const data = await json<{ runs: AgentReceipt[] }>('/api/projects/agents', { signal: controller.signal });
        if (!controller.signal.aborted) {
          setRuns(data.runs);
          setError('');
        }
      } catch {
        if (!controller.signal.aborted) setError('Изпълненията не се обновиха.');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 5000);
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [user, reload]);
  const receipts = new Map(runs?.map((run) => [run.agentId, run]));
  function receipt(agentId: string) {
    const run = receipts.get(agentId);
    return run ? (
      <div className="module-agent-receipt">
        <RoleStatus status={error && run.activity === 'running' ? 'unknown' : run.activity} />
        {run.output && <p>{run.output}</p>}
        <Link className="module-link" href={`/dashboard?project=${encodeURIComponent(run.project.id)}`}>{run.project.name} <ArrowUpRight size={14} /></Link>
        <time dateTime={run.startedAt ?? run.createdAt}>{run.startedAt ? 'Начало' : 'Записано'} {new Intl.DateTimeFormat('bg-BG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(run.startedAt ?? run.createdAt))}</time>
      </div>
    ) : null;
  }
  return (
    <>
      <Banner view="agents">
        Задачи в Студиото и последни резултати от твоите проекти.
        {' '}<Link className="module-link" href={VIEWS.chat.href}>Чат с Шарк агент <ArrowRight size={14} aria-hidden="true" /></Link>
      </Banner>
      <section className="ice-section module-panel module-brain-panel" id="supreme-brain" data-scene="assistant" data-scene-tone="light" aria-labelledby="supreme-brain-title">
        <div className="module-heading">
          <div className="module-brain"><Logo size="md" /><div><h2 id="supreme-brain-title">{SUPREME_BRAIN.name}</h2><p>{SUPREME_BRAIN.description}</p></div></div>
        </div>
        <div className="module-brain-actions">
          <Link className="shark-action" href="/dashboard?feature=screenshot-website">Проект по скрийншот <ArrowRight size={16} aria-hidden="true" /></Link>
          <Link className="module-link" href="/dashboard?feature=prompt-software">Проект от описание <ArrowRight size={16} aria-hidden="true" /></Link>
        </div>
        {receipt(SUPREME_BRAIN.id)}
      </section>
      <section id="agent-roles" aria-labelledby="module-agents-title">
        <div className="module-heading">
          <h2 id="module-agents-title">Специализирани роли</h2>
          {user && <button type="button" className="module-link" onClick={() => setReload((value) => value + 1)}>Обнови резултатите</button>}
        </div>
        {user && !runs && !error && <p className="module-agents-status" role="status">Зареждане на изпълненията…</p>}
        {user && runs?.length === 0 && !error && <p className="module-agents-status">Резултатите от изпълнените роли ще се появят тук след стартиране на проект.</p>}
        {!user && !loading && <p className="module-agents-status"><Link href={signIn(VIEWS.agents.href)}>Влез, за да видиш изпълненията от твоите проекти.</Link></p>}
        {error && <p className="module-agents-status module-error" role="alert">{error}</p>}
        <ul className="module-agents">
          {AGENTS.map((agent) => {
            const action = STUDIO_AGENT_ACTIONS[agent.id];
            return (
              <li key={agent.id} className="ice-section module-panel module-role-card"
                data-scene={ROLE_SCENES[agent.icon] ?? 'team'} data-scene-tone="light">
                <div className="module-role-heading">
                  <span className="module-agent-icon" aria-hidden="true"><Users size={18} /></span>
                  <div>
                    <strong>{agent.name}</strong><p>{action?.description ?? STUDIO_AGENT_DEPENDENCIES[agent.id]}</p>
                    {action && <Link className="module-link" href={`/dashboard?feature=${action.featureId}`}>Отвори задача <ArrowRight size={14} /></Link>}
                    {agent.id === 'agent-14' && <Link className="module-link" href="/chat">Към чата <ArrowRight size={14} /></Link>}
                  </div>
                </div>
                {receipt(agent.id)}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

function Account({ user, loading, error }: { user: User | null; loading: boolean; error: string }) {
  const router = useRouter();
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [billingError, setBillingError] = useState('');
  const [logoutError, setLogoutError] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const lifetime = !!user && hasLifetimeUltra(user);
  useEffect(() => {
    if (!user || lifetime) return;
    const request = new AbortController();
    void json<BillingStatus>('/api/payments/status', { signal: request.signal })
      .then(setBilling).catch(() => { if (!request.signal.aborted) setBillingError('Периодът на абонамента не можа да се зареди.'); });
    return () => request.abort();
  }, [user, lifetime]);

  async function logout() {
    setSigningOut(true);
    setLogoutError('');
    try {
      await json('/api/auth/logout', { method: 'POST' });
      announceSessionChange();
      router.push('/login');
      router.refresh();
    } catch {
      setLogoutError('Изходът не беше успешен. Опитай отново.');
      setSigningOut(false);
    }
  }

  const formatter = new Intl.DateTimeFormat('bg-BG', { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <>
      <Banner view="settings">Акаунт, права и абонамент.</Banner>
      <section className="ice-section module-panel module-profile" data-scene="profile" data-scene-tone="light">
        <div className="module-heading"><h2>Профил</h2></div>
        {loading ? <p role="status">Зареждане на профила…</p> : error ? <p role="alert">{error}</p> : !user
          ? <Link className="shark-action" href={signIn(VIEWS.settings.href)}>Вход <ArrowRight size={17} /></Link>
          : (
            <>
              <dl className="module-account">
                {user.name && <div><dt>Име</dt><dd>{user.name}</dd></div>}
                {user.email && <div><dt>Имейл</dt><dd>{user.email}</dd></div>}
                <div><dt>План</dt><dd>{accountPlanLabel(user)}</dd></div>
                <div><dt>Роля</dt><dd>{user.role === 'ADMIN' ? 'Администратор' : 'Потребител'}</dd></div>
                {!lifetime && billing?.period?.currentPeriodStart && <div><dt>Начало на периода</dt><dd><time dateTime={billing.period.currentPeriodStart}>{formatter.format(new Date(billing.period.currentPeriodStart))}</time></dd></div>}
                {!lifetime && billing?.period?.currentPeriodEnd && <div><dt>Край на периода</dt><dd><time dateTime={billing.period.currentPeriodEnd}>{formatter.format(new Date(billing.period.currentPeriodEnd))}</time></dd></div>}
              </dl>
              {!lifetime && billingError && <p role="alert" className="module-error">{billingError}</p>}
              <div className="module-actions">
                {user.role === 'ADMIN' ? <Link className="shark-action-secondary" href="/admin#settings">Административни настройки</Link>
                  : <Link className="shark-action-secondary" href="/pricing">Планове</Link>}
                <button className="shark-action-secondary" type="button" onClick={logout} disabled={signingOut}>{signingOut ? 'Излизане…' : 'Изход'}</button>
              </div>
              {logoutError && <p role="alert" className="module-error">{logoutError}</p>}
            </>
          )}
      </section>
      {user && <MemorySettings />}
      <details className="module-disclosure" data-scene="archive" data-scene-tone="light"><summary>Архив на агентите</summary>
        <Link className="module-link" href={VIEWS.agents.href}>Специализирани роли и предишни изпълнения <ArrowUpRight size={14}/></Link>
      </details>
    </>
  );
}

function Automotive() {
  return (
    <>
      <section className="ice-section module-banner module-banner-automotive" data-scene="automotive" data-scene-tone="light">
        <div><CarFront size={26} /><h1>Автомобили</h1><p>Автомобилни изображения от проектните материали на SharkAI.</p></div>
        <Image src="/assets/image-1.png" className="module-car" alt="Сребрист автомобил от проектните материали на SharkAI" width={420} height={420} />
      </section>
      <div className="module-columns">
        <section className="ice-section module-panel module-note module-diagnostics" data-scene="diagnostics" data-scene-tone="light">
          <div className="module-heading"><h2>Диагностика</h2></div>
          <p>Няма свързан източник за VIN, OBD диагностичен адаптер или интерактивен 3D модел.</p>
        </section>
        <figure className="ice-section module-panel module-engine" data-scene="tools" data-scene-tone="light">
          <figcaption><strong>Двигател</strong><span>Изображение от проектните материали</span></figcaption>
          <Image src="/assets/image-2.png" alt="Изображение на червен и сребрист двигател" width={320} height={320} />
        </figure>
      </div>
    </>
  );
}

function DashboardContent() {
  const router = useRouter();
  const params = useSearchParams();
  const projectId = params.get('project');
  const featureParam = params.get('feature');
  const viewParam = params.get('view');
  const view: View = projectId || featureParam ? 'studio'
    : viewParam && Object.hasOwn(VIEWS, viewParam) && viewParam !== 'chat' ? viewParam as View : 'overview';
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<Projects | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [details, setDetails] = useState<ProjectDetail | null>(null);
  const [projectError, setProjectError] = useState('');
  const [reload, setReload] = useState(0);

  const fetchProjects = useCallback(async (signal?: AbortSignal) => {
    setError('');
    try {
      setData(await json<Projects>('/api/projects', { signal }));
    } catch {
      if (!signal?.aborted) setError('Проектите и профилът не можаха да се заредят.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const request = new AbortController();
    void fetchProjects(request.signal);
    return () => request.abort();
  }, [fetchProjects]);

  useEffect(() => {
    if (view !== 'overview' || !data?.summary?.active) return;
    const request = new AbortController();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void fetchProjects(request.signal);
    }, 10_000);
    return () => { request.abort(); clearInterval(timer); };
  }, [view, data?.summary?.active, fetchProjects]);

  const hasUser = Boolean(data?.user);
  const userEmail = data?.user?.email;

  useEffect(() => {
    setDetails(null);
    setProjectError('');
    if (!projectId || !hasUser) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await json<ProjectDetail>(`/api/projects/${encodeURIComponent(projectId!)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setDetails(result);
        if (isTerminalStudioStatus(result.project.status) || result.project.statusUnknown) {
          void fetchProjects(controller.signal);
        } else {
          timer = setTimeout(poll, 1600);
        }
      } catch (err) {
        if (!controller.signal.aborted) setProjectError(err instanceof Error ? err.message : 'Статусът е недостъпен.');
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [projectId, userEmail, hasUser, reload, fetchProjects]);

  function created(id: string) {
    router.push(`/dashboard?project=${encodeURIComponent(id)}`);
    void fetchProjects();
  }

  return (
    <div className="module-workspace" data-ultra-view={view}>
      <a className="module-skip" href="#workspace-content">Към съдържанието</a>
      <aside className="module-sidebar ice-section ice-section--dark" data-scene={WORKSPACE_SCENES[view]}>
        <WorkspaceBrand />
        <WorkspaceNav view={view} />
        <Link className="module-sidebar-account" href={data?.user ? VIEWS.settings.href : signIn('/dashboard')}>
          <Settings size={18} /><span>{data?.user?.name || data?.user?.email || 'Вход'}</span>
        </Link>
      </aside>
      <div className="module-main">
        <header className="module-topbar" data-scene="workspace">
          <button type="button" className="module-menu module-utility-button" onClick={() => dialog.current?.showModal()} aria-label="Отвори менюто" aria-haspopup="dialog"><Menu size={18} /></button>
          <WorkspaceBrand mobile />
          <span className="module-breadcrumb"><Link href="/dashboard">Работно пространство</Link><span aria-hidden="true">/</span><strong>{VIEWS[view].label}</strong></span>
          <div className="module-header-actions">
            <Link className="module-agent-shortcut module-utility-button" href={VIEWS.chat.href} aria-label="Чат с Шарк агент" title="Чат с Шарк агент">
              <MessageSquare size={18} aria-hidden="true" />
            </Link>
            <WorkspaceSearch projects={data?.projects ?? []} />
            <Link className="module-account-puck" href={data?.user ? VIEWS.settings.href : signIn('/dashboard')}>
              <span aria-hidden="true" />{data?.user ? accountPlanLabel(data.user, 'План ') : 'Вход'}
            </Link>
          </div>
        </header>
        <main id="workspace-content" className="module-content" tabIndex={-1}>
          {view === 'overview' && <Overview data={data} loading={loading} error={error} onRetry={() => void fetchProjects()} />}
          {view === 'studio' && <>
            <Banner view="studio">Създай проект от описание или визуална референция.</Banner>
            {error && <p className="module-error" role="alert">{error} <button type="button" className="module-link" onClick={() => void fetchProjects()}>Опитай отново</button></p>}
            {projectId && data?.user && <Result detail={details} error={projectError} onRetry={() => setReload((value) => value + 1)} />}
            {projectId && !loading && !data?.user && <section className="ice-section module-panel" data-scene="profile" data-scene-tone="light">
              <div className="module-heading"><h2>Проект</h2></div>
              <p>Влез в акаунта си, за да отвориш проекта.</p>
              <Link className="shark-action" href={signIn(`/dashboard?project=${encodeURIComponent(projectId)}`)}>Вход <ArrowRight size={17} /></Link>
            </section>}
            <StudioForm key={featureParam ?? 'screenshot-website'} featureParam={featureParam ?? 'screenshot-website'} user={data?.user ?? null} loading={loading} onCreated={created} />
            {data?.user && <ProjectList projects={data.projects} onRetry={() => void fetchProjects()} />}
          </>}
          {view === 'agents' && <Agents user={data?.user ?? null} loading={loading} />}
          {view === 'automotive' && <Automotive />}
          {view === 'commerce' && <><Banner view="commerce" /><Commerce signInHref={signIn(VIEWS.commerce.href)} /></>}
          {view === 'investments' && <InvestmentLab ownerKey={data?.user?.email} />}
          {view === 'settings' && <Account user={data?.user ?? null} loading={loading} error={error} />}
        </main>
      </div>
      <dialog ref={dialog} className="module-drawer ice-section ice-section--dark" data-scene={WORKSPACE_SCENES[view]} aria-label="Навигация" onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
        <div className="module-drawer-content">
          <div className="module-drawer-head">
            <WorkspaceBrand />
            <button type="button" className="shark-action-secondary" aria-label="Затвори менюто" onClick={() => dialog.current?.close()}><X size={22} /></button>
          </div>
          <WorkspaceNav view={view} onNavigate={() => dialog.current?.close()} />
        </div>
      </dialog>
    </div>
  );
}

export default function DashboardPage() {
  return <Suspense fallback={<main className="module-content" role="status">Зареждане на работното пространство…</main>}><DashboardContent /></Suspense>;
}
