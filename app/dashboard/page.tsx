'use client';

import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowRight, ArrowUpRight, CarFront, CircleHelp, Code2, Download, FolderOpen, Gauge,
  ImageIcon, LayoutDashboard, LoaderCircle, Menu, MessageSquare, Mic, Plus,
  Settings, Sparkles, TrendingUp, Upload, Users, X,
} from 'lucide-react';
import { Logo } from '@/components/Logo';
import { AGENTS, FEATURES, SUPREME_BRAIN, getFeature, getStudioFeatureAvailability } from '@/lib/agents';
import './workspace.css';

const VIEWS = {
  overview: { label: 'Обзор', icon: LayoutDashboard, href: '/dashboard' },
  chat: { label: 'AI чат', icon: MessageSquare, href: '/chat' },
  studio: { label: 'Студио', icon: Code2, href: '/dashboard?view=studio' },
  agents: { label: 'AI агенти', icon: Users, href: '/dashboard?view=agents' },
  automotive: { label: 'Автомобили', icon: CarFront, href: '/dashboard?view=automotive' },
  investments: { label: 'Инвестиции', icon: TrendingUp, href: '/dashboard?view=investments' },
  settings: { label: 'Настройки', icon: Settings, href: '/dashboard?view=settings' },
};

type View = keyof typeof VIEWS;
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
const TERMINAL = ['COMPLETED', 'FAILED'];

type User = { name: string | null; email?: string; plan: string; role: string };
type Project = { id: string; name: string; type: string; status: string; createdAt: string };
type ProjectDetail = {
  project: Project & { description: string | null; analysis?: { understanding?: string; buildMethod?: string; feature?: string } | null };
  files: string[];
  fileCount: number;
  agents: Array<{ id: string; agentName: string; status: string; output: string | null }>;
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

function WorkspaceNav({ view, onNavigate }: { view: View; onNavigate?: () => void }) {
  return (
    <nav className="module-nav" aria-label="Работно пространство">
      {Object.entries(VIEWS).map(([key, item]) => (
        <Link key={key} href={item.href} aria-current={view === key ? 'page' : undefined}
          onClick={onNavigate} title={item.label}>
          <item.icon size={19} aria-hidden="true" /><span>{item.label}</span>
        </Link>
      ))}
    </nav>
  );
}

function Banner({ view, children }: { view: View; children?: ReactNode }) {
  const { icon: Icon, label } = VIEWS[view];
  return (
    <section className={`shark-glass module-banner module-banner-${view}`}>
      <div>
        <Icon size={24} aria-hidden="true" />
        <h1>{label}</h1>
        {children && <p>{children}</p>}
      </div>
    </section>
  );
}

function ProjectList({ projects, error, isLoading, onRetry }: {
  projects: Project[]; error?: string; isLoading?: boolean; onRetry: () => void;
}) {
  return (
    <section className="shark-glass module-panel" aria-labelledby="module-projects-title">
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
                    <small className={`module-status module-status-${project.status.toLowerCase()}`}>{PROJECT_STATUS[project.status] || project.status}</small>
                  </Link>
                </li>
              ))}
            </ul>}
    </section>
  );
}

function Overview({ data, loading, error, onRetry }: { data: Projects | null; loading: boolean; error: string; onRetry: () => void }) {
  const projects = data?.projects ?? [];
  const summary = data?.summary;
  return (
    <>
      <section className="shark-glass module-banner module-overview-hero">
        <div>
          <h1>Команден <span>център</span></h1>
          <p>Разговори, проекти и задачи в работното ти пространство.</p>
          <div className="module-actions">
            <Link href="/chat" className="shark-action">Отвори AI чата <ArrowRight size={17} /></Link>
            <Link href={VIEWS.studio.href} className="shark-action-secondary">Към Студиото <Code2 size={17} /></Link>
          </div>
        </div>
      </section>
      {data?.user && summary && (
        <dl className="module-metrics" aria-label="Състояние на проектите">
          <div className="shark-glass"><dt><FolderOpen aria-hidden="true" /> Проекти</dt><dd>{summary.total}</dd></div>
          <div className="shark-glass"><dt><Gauge aria-hidden="true" /> В работа</dt><dd>{summary.active}</dd></div>
          <div className="shark-glass"><dt><Sparkles aria-hidden="true" /> Завършени</dt><dd>{summary.completed}</dd></div>
        </dl>
      )}
      <section aria-labelledby="module-cards-title">
        <h2 className="module-section-title" id="module-cards-title">Модули</h2>
        <div className="module-tiles">
          {(['chat', 'studio', 'agents'] as const).map((key) => {
            const { href, label, icon: Icon } = VIEWS[key];
            const captions = { chat: 'Разговори, файлове и работни задачи.', studio: 'Проекти от описание и скрийншоти.', agents: 'Роли и резултати от изпълнения.' };
            return (
              <Link key={key} href={href} className={`shark-glass module-tile module-banner-${key}`}>
                <div><Icon size={20} /><ArrowUpRight size={20} /></div>
                <span><strong>{label}</strong><p>{captions[key]}</p></span>
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
      <section className="shark-glass module-panel">
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
            <details className="module-disclosure">
              <summary>Липсващи инструменти в Студиото</summary>
              <ul>{FEATURES.filter(({ id }) => getStudioFeatureAvailability(id)).map(({ id, title }) => <li key={id}><strong>{title}</strong><p>{getStudioFeatureAvailability(id)}</p></li>)}</ul>
            </details>
          </form>
        )}
      </section>
      <section className="shark-glass module-panel">
        <div className="module-heading"><h2>Визуална референция</h2></div>
        <div className="module-upload-preview">
          {upload?.previewUrl
            ? <Image src={upload.previewUrl} alt="Качена визуална референция" width={800} height={450} unoptimized />
            : <div><ImageIcon size={27} /><p>{needsReference ? 'Каченото изображение ще се покаже тук.' : 'Този тип проект използва описание.'}</p></div>}
        </div>
      </section>
    </div>
  );
}

function Result({ detail, error, onRetry }: { detail: ProjectDetail | null; error: string; onRetry: () => void }) {
  return (
    <section className="shark-glass module-panel" aria-labelledby="studio-result">
      <div className="module-heading">
        <h2 id="studio-result">{detail?.project.name || 'Резултат от Студиото'}</h2>
        {detail && <span className={`module-status module-status-${detail.project.status.toLowerCase()}`} role="status">{PROJECT_STATUS[detail.project.status] || detail.project.status}</span>}
      </div>
      {error && <p className="module-error" role="alert">{error} <button type="button" className="module-link" onClick={onRetry}>Провери отново</button></p>}
      {!detail && !error && <p role="status"><LoaderCircle size={17} className="inline animate-spin" /> Зареждане на проекта…</p>}
      {detail?.project.status === 'FAILED' && <p role="alert">Студиото не завърши проекта. Прегледай входа и създай нов проект при нужда.</p>}
      {detail?.project.analysis?.understanding && <p className="module-copy">{detail.project.analysis.understanding}</p>}
      {detail?.project.status === 'COMPLETED' && (
        <>
          <p className="module-copy">{detail.fileCount ? `Запазени файлове: ${detail.fileCount}.` : 'Архивът на този проект е недостъпен.'} {BUILD_METHODS[detail.project.analysis?.buildMethod || '']}</p>
          <div className="module-actions">
            {detail.previewUrl && <a href={detail.previewUrl} target="_blank" rel="noopener noreferrer" className="shark-action-secondary">Преглед <ArrowUpRight size={17} /></a>}
            {detail.downloadUrl && <a href={detail.downloadUrl} download className="shark-action">Изтегли ZIP <Download size={17} /></a>}
          </div>
          {detail.files.length > 0 && (
            <details className="module-disclosure">
              <summary>Файлове</summary>
              <ul className="module-file-list">{detail.files.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
            </details>
          )}
        </>
      )}
      {detail && detail.agents.length > 0 && BUILD_METHODS[detail.project.analysis?.buildMethod || ''] && (
        <details className="module-disclosure">
          <summary>Резултати от изпълнението</summary>
          <ul>{detail.agents.map(({ id, agentName, output }) => <li key={id}><strong>{agentName}</strong>{output && <p>{output}</p>}</li>)}</ul>
        </details>
      )}
    </section>
  );
}

function Agents() {
  return (
    <>
      <Banner view="agents">Ролите, регистрирани в SharkAI.</Banner>
      <section className="shark-glass module-panel">
        <div className="module-heading">
          <div className="module-brain"><Logo size="md" /><div><h2>{SUPREME_BRAIN.name}</h2><p>{SUPREME_BRAIN.description}</p></div></div>
          <Link className="module-link" href={VIEWS.studio.href}>Студио <ArrowRight size={16} /></Link>
        </div>
        <p>Изпълнените роли и резултатите се показват в конкретния проект.</p>
      </section>
      <section aria-labelledby="module-agents-title">
        <h2 className="module-section-title" id="module-agents-title">Специализирани роли</h2>
        <ul className="module-agents">
          {AGENTS.map((agent) => (
            <li key={agent.id} className="shark-glass module-panel">
              <span className="module-agent-icon"><Users size={18} /></span>
              <div><strong>{agent.name}</strong><p>{agent.description}</p></div>
            </li>
          ))}
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
  useEffect(() => {
    if (!user) return;
    const request = new AbortController();
    void json<BillingStatus>('/api/payments/status', { signal: request.signal })
      .then(setBilling).catch(() => { if (!request.signal.aborted) setBillingError('Периодът на абонамента не можа да се зареди.'); });
    return () => request.abort();
  }, [user]);

  async function logout() {
    setSigningOut(true);
    setLogoutError('');
    try {
      await json('/api/auth/logout', { method: 'POST' });
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
      <section className="shark-glass module-panel">
        <div className="module-heading"><h2>Профил</h2></div>
        {loading ? <p role="status">Зареждане на профила…</p> : error ? <p role="alert">{error}</p> : !user
          ? <Link className="shark-action" href={signIn(VIEWS.settings.href)}>Вход <ArrowRight size={17} /></Link>
          : (
            <>
              <dl className="module-account">
                {user.name && <div><dt>Име</dt><dd>{user.name}</dd></div>}
                {user.email && <div><dt>Имейл</dt><dd>{user.email}</dd></div>}
                <div><dt>План</dt><dd>{user.plan}</dd></div>
                <div><dt>Роля</dt><dd>{user.role === 'ADMIN' ? 'Администратор' : 'Потребител'}</dd></div>
                {billing?.period?.currentPeriodStart && <div><dt>Начало на периода</dt><dd><time dateTime={billing.period.currentPeriodStart}>{formatter.format(new Date(billing.period.currentPeriodStart))}</time></dd></div>}
                {billing?.period?.currentPeriodEnd && <div><dt>Край на периода</dt><dd><time dateTime={billing.period.currentPeriodEnd}>{formatter.format(new Date(billing.period.currentPeriodEnd))}</time></dd></div>}
              </dl>
              {billingError && <p role="alert" className="module-error">{billingError}</p>}
              <div className="module-actions">
                {user.role === 'ADMIN' ? <Link className="shark-action-secondary" href="/admin#settings">Административни настройки</Link>
                  : <Link className="shark-action-secondary" href="/pricing">Планове</Link>}
                <button className="shark-action-secondary" type="button" onClick={logout} disabled={signingOut}>{signingOut ? 'Излизане…' : 'Изход'}</button>
              </div>
              {logoutError && <p role="alert" className="module-error">{logoutError}</p>}
            </>
          )}
      </section>
    </>
  );
}

function Automotive() {
  return (
    <>
      <section className="shark-glass module-banner module-banner-automotive">
        <div><CarFront size={26} /><h1>Автомобили</h1><p>Автомобилни изображения от проектните материали на SharkAI.</p></div>
        <Image src="/assets/image-1.png" className="module-car" alt="Сребрист автомобил от проектните материали на SharkAI" width={420} height={420} />
      </section>
      <div className="module-columns">
        <section className="shark-glass module-panel">
          <div className="module-heading"><h2>Диагностика</h2></div>
          <p>Няма свързан източник за VIN, OBD диагностичен адаптер или интерактивен 3D модел.</p>
        </section>
        <figure className="shark-glass module-panel module-engine">
          <Image src="/assets/image-2.png" alt="Изображение на червен и сребрист двигател" width={320} height={320} />
          <figcaption>Двигател от проектните материали</figcaption>
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
    setDetails(null);
    setProjectError('');
    if (!projectId || !data?.user) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await json<ProjectDetail>(`/api/projects/${encodeURIComponent(projectId!)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setDetails(result);
        if (TERMINAL.includes(result.project.status)) {
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
  }, [projectId, data?.user?.email, !!data?.user, reload, fetchProjects]);

  function created(id: string) {
    router.push(`/dashboard?project=${encodeURIComponent(id)}`);
    void fetchProjects();
  }

  return (
    <div className="module-workspace">
      <a className="module-skip" href="#workspace-content">Към съдържанието</a>
      <aside className="module-sidebar shark-glass">
        <Link href="/" className="module-brand"><Logo size="md" /><span>SharkAI</span></Link>
        <WorkspaceNav view={view} />
        <Link className="module-sidebar-account" href={data?.user ? VIEWS.settings.href : signIn('/dashboard')}>
          <Settings size={18} /><span>{data?.user?.name || data?.user?.email || 'Вход'}</span>
        </Link>
      </aside>
      <div className="module-main">
        <header className="module-topbar">
          <button type="button" className="module-menu shark-action-secondary" onClick={() => dialog.current?.showModal()} aria-label="Отвори менюто"><Menu size={22} /></button>
          <Link href="/" className="module-mobile-brand"><Logo size="sm" /></Link>
          <span className="module-breadcrumb"><Link href="/dashboard">Работно пространство</Link><span aria-hidden="true">/</span><strong>{VIEWS[view].label}</strong></span>
          <Link className="module-top-chat shark-action-secondary" href="/chat"><MessageSquare size={17} /> <span>AI чат</span></Link>
        </header>
        <main id="workspace-content" className="module-content" tabIndex={-1}>
          {view === 'overview' && <Overview data={data} loading={loading} error={error} onRetry={() => void fetchProjects()} />}
          {view === 'studio' && <>
            <Banner view="studio">Създай проект от описание или визуална референция.</Banner>
            {error && <p className="module-error" role="alert">{error} <button type="button" className="module-link" onClick={() => void fetchProjects()}>Опитай отново</button></p>}
            {projectId && data?.user && <Result detail={details} error={projectError} onRetry={() => setReload((value) => value + 1)} />}
            {projectId && !loading && !data?.user && <section className="shark-glass module-panel"><p>Влез в акаунта си, за да отвориш проекта.</p><Link className="shark-action" href={signIn(`/dashboard?project=${encodeURIComponent(projectId)}`)}>Вход <ArrowRight size={17} /></Link></section>}
            <StudioForm key={featureParam ?? 'screenshot-website'} featureParam={featureParam ?? 'screenshot-website'} user={data?.user ?? null} loading={loading} onCreated={created} />
            {data?.user && <ProjectList projects={data.projects} onRetry={() => void fetchProjects()} />}
          </>}
          {view === 'agents' && <Agents />}
          {view === 'automotive' && <Automotive />}
          {view === 'investments' && <>
            <Banner view="investments">Състояние на свързания портфейл.</Banner>
            <section className="shark-glass module-panel">
              <div className="module-heading"><h2><CircleHelp size={19} /> Няма свързан източник</h2></div>
              <p>За портфейл, наличности и движения е нужен конфигуриран доставчик с достъп за четене.</p>
            </section>
          </>}
          {view === 'settings' && <Account user={data?.user ?? null} loading={loading} error={error} />}
        </main>
      </div>
      <dialog ref={dialog} className="module-drawer shark-glass" aria-label="Навигация" onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
        <div className="module-drawer-content">
          <div className="module-drawer-head">
            <Link href="/" className="module-brand"><Logo size="md" /><span>SharkAI</span></Link>
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
