'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { Logo } from '@/components/Logo';
import type { ChatTool } from '@/lib/chat-tools';
import { accountPlanLabel } from '../account-plan';
import {
  AppWindow, ArrowDown, ArrowUp, AudioLines, Bell, BriefcaseBusiness, Camera, Check, ChevronDown, Copy, Download, ExternalLink,
  FileText, Folder, Globe2, Image as ImageIcon, LayoutDashboard, LoaderCircle, Menu, MessageSquare,
  Mic, PanelLeftClose, PanelLeftOpen, Paperclip, Pencil, Plus, RotateCcw, ScanLine, ScreenShare,
  Search, Settings, Shield, Sparkles, Square, Table2, X,
} from 'lucide-react';
import { captureFrame, useChatMedia } from './chat-media';
import { readChatResponse } from './chat-response';
import { chatTurnScope, readPendingChatTurn, writePendingChatTurn, type BranchFrom, type ChatRequest } from './chat-turn-draft';
import { Inspector } from './inspector';
import { useReminders, type ReminderInput } from './reminders';
import { ToolReceipt } from './tool-receipt';
import { useChatScroll } from './use-chat-scroll';
import {
  artifactAttachment, artifactDownloadUrl, attachmentInspection, AUDIO_MIME_TYPES, CANVAS_CONTENT_LIMIT, CANVAS_MIME_TYPES, CANVAS_SAVE_PREFIX, messageAttachment, projectInProgress, projectStatusLabel, uploadUrl, type Account, type Attachment, type Conversation,
  type InspectorItem, type Message, type Mode, type Model, type Project,
} from './workspace-types';
import './workspace.css';
import './chat-voice.css';

type Popup = 'tools' | 'model' | 'mode' | 'profile';

interface ChatData {
  messages?: Message[];
  conversations?: Conversation[];
  conversationId?: string | null;
  conversationMode?: Mode;
  projectId?: string | null;
  user?: Account | null;
  capabilities?: { models?: Model[]; reason?: string; sharkAssistant?: boolean };
  error?: string;
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PDF_TYPE = 'application/pdf';
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CSV_TYPE = 'text/csv';
const UPLOAD_TYPES = [...IMAGE_TYPES, PDF_TYPE, DOCX_TYPE, XLSX_TYPE, CSV_TYPE, ...CANVAS_MIME_TYPES, ...AUDIO_MIME_TYPES];
const AUDIO_ACCEPT = '.wav,.ogg,.m4a,.webm,audio/mp4';
const MAX_AUDIO_MB = 2;
const AUDIO_TRANSCRIPTION = 'Транскрибирай аудиото';
const TRANSCRIPTION_LANGUAGES = {
  auto: { label: 'Автоматично', suffix: '' },
  bg: { label: 'Български', suffix: ' на български' },
  en: { label: 'Английски', suffix: ' на английски' },
};
type TranscriptionLanguage = keyof typeof TRANSCRIPTION_LANGUAGES;
const FILE_ACCEPT = `.jpg,.jpeg,.png,.webp,.pdf,.docx,.csv,.xlsx,.txt,.md,.json,${AUDIO_ACCEPT}`;
const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  pdf: PDF_TYPE, docx: DOCX_TYPE, xlsx: XLSX_TYPE, csv: CSV_TYPE,
  txt: 'text/plain', md: 'text/markdown', json: 'application/json',
  wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', webm: 'audio/webm',
};
const INPUT_FILES: Record<string, { types: string[]; accept: string; required: string }> = {
  image: { types: IMAGE_TYPES, accept: '.jpg,.jpeg,.png,.webp', required: 'За този инструмент е нужно изображение.' },
  pdf: { types: [PDF_TYPE], accept: '.pdf', required: 'За този инструмент е нужен PDF файл.' },
  document: { types: [PDF_TYPE, DOCX_TYPE], accept: '.pdf,.docx', required: 'За този инструмент е нужен PDF или DOCX файл.' },
  dataset: { types: [XLSX_TYPE, CSV_TYPE], accept: '.xlsx,.csv', required: 'За този инструмент е нужен CSV или XLSX файл.' },
  textfile: { types: CANVAS_MIME_TYPES, accept: '.txt,.md,.json', required: 'За този инструмент е нужен TXT, Markdown или JSON файл.' },
  audio: { types: AUDIO_MIME_TYPES, accept: AUDIO_ACCEPT, required: 'Прикачи аудио файл във формат WAV, Ogg, M4A или WebM.' },
};
const modeLabel = (mode: Mode) => mode === 'chat' ? 'Чат' : 'Работа';
function takesTranscriptionLanguage(draft: string) {
  const command = draft.trim().replace(/\s+/gu, ' ');
  return !command || /^(?:транскрибирай(?: аудио(?:то)?)?|transcribe(?: (?:the )?audio)?)[.!?]*$/iu.test(command);
}

function userTurn(request: ChatRequest, attachmentMime?: string): Message {
  return { id: request.requestId, role: 'user', content: request.message || 'Прикачен файл', imagePath: request.uploadId, attachmentMime };
}

const suggestions = [
  { label: 'Разгледай една идея', text: 'Помогни ми да развия идея. Какви въпроси ще ми зададеш първо?', icon: Sparkles },
  { label: 'Организирай работата ми', text: 'Помогни ми да подредя задачите си за седмицата. Предложи проста структура.', icon: BriefcaseBusiness },
  { label: 'Подготви ми чернова', text: 'Помогни ми да подготвя чернова. Каква информация ти е нужна за начало?', icon: FileText },
];

function ToolIcon({ tool, size = 17 }: { tool: ChatTool; size?: number }) {
  const id = tool.id;
  const Icon = id.includes('search') ? Globe2 : id.includes('image') ? ImageIcon
    : id.startsWith('audio-') ? AudioLines : id.includes('ocr') ? ScanLine
    : (tool.input === 'dataset' || id.startsWith('spreadsheet-')) ? Table2 : /pdf|document|textfile/.test(tool.input) ? FileText : AppWindow;
  return <Icon size={size} />;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectError, setProjectError] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const [sharkAssistant, setSharkAssistant] = useState(false);
  const [capabilityReason, setCapabilityReason] = useState('');
  const [tools, setTools] = useState<ChatTool[]>([]);
  const [toolsPending, setToolsPending] = useState(true);
  const [toolsError, setToolsError] = useState(false);
  const [selectedTool, setSelectedTool] = useState<ChatTool | null>(null);
  const [transcriptionLanguage, setTranscriptionLanguage] = useState<TranscriptionLanguage>('auto');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('chat');
  const [modeSaving, setModeSaving] = useState(false);
  const [projectContext, setProjectContext] = useState<string | null>(null);
  const [branchFrom, setBranchFrom] = useState<BranchFrom | null>(null);
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [mediaPending, setMediaPending] = useState(false);
  const [optimistic, setOptimistic] = useState<Message | null>(null);
  const [partial, setPartial] = useState('');
  const [problem, setProblem] = useState('');
  const [loadProblem, setLoadProblem] = useState('');
  const [loginRequired, setLoginRequired] = useState(false);
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState('');
  const [small, setSmall] = useState(false);
  const [railVisible, setRailVisible] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [inspector, setInspector] = useState<InspectorItem | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const sendController = useRef<AbortController | null>(null);
  const loadController = useRef<AbortController | null>(null);
  const failedRequest = useRef<ChatRequest | null>(null);
  const failedCanvasRequest = useRef<ChatRequest | null>(null);
  const failedReminderRequest = useRef<ChatRequest | null>(null);
  const mounted = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const railTrigger = useRef<HTMLButtonElement>(null);
  const transcriptionLanguageRef = useRef<HTMLSelectElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const topbarRef = useRef<HTMLElement>(null);
  const composeAreaRef = useRef<HTMLDivElement>(null);
  const cameraDialog = useRef<HTMLDialogElement>(null);
  const cameraVideo = useRef<HTMLVideoElement>(null);
  const cameraStream = useRef<MediaStream | null>(null);
  const inspectorReturnFocus = useRef<HTMLElement | null>(null);
  const inspectorRegion = useRef<HTMLDivElement>(null);
  const media = useChatMedia(!!account, setProblem);

  const reminders = useReminders(account?.email ?? null);
  const reminderTool = tools.find(({ id, available }) => id === 'scheduled-task' && available);
  const isTranscription = selectedTool?.id === 'audio-transcribe';
  const canChooseTranscriptionLanguage = isTranscription && takesTranscriptionLanguage(input);
  const datasetExample = selectedTool?.id === 'dataset-analysis' ? 'Сумирай „Приход“ по „Град“' : null;
  const attachmentPreview = attachment ? attachmentInspection(attachment) : null;
  const modelLabel = 'Шарк агент';
  const voiceUnavailable = media.voiceReason || (!sharkAssistant ? 'Шарк агентът е недостъпен за гласов отговор.' : '');
  const dictationLabel = media.listening === 'dictation' ? (media.recordStage === 'recording' ? 'Приключи диктовката' : 'Отмени диктовката') : 'Диктовка';
  const conversationLabel = media.speaking ? 'Спри озвучаването' : media.listening === 'conversation'
    ? (media.recordStage === 'recording' ? 'Изпрати гласовия запис' : 'Отмени гласовия запис') : 'Гласов разговор';
  const canSend = !!account;
  const pending = loading || sending || uploading || mediaPending || modeSaving;
  const awaitingProjects = projects.some(projectInProgress);
  const showStart = !loading && !loadProblem && messages.length === 0 && !optimistic;
  const { scrollRef, following, followLatest, onScroll } = useChatScroll(!showStart && !loading && !loadProblem);
  const signInHref = `/login?next=${encodeURIComponent(`/chat${typeof window === 'undefined' ? '' : window.location.search}`)}`;


  const loadConversation = useCallback(async (id?: string, draftProjectId?: string) => {
    loadController.current?.abort();
    followLatest();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setLoadProblem('');
    setLoginRequired(false);
    try {
      const query = id ? `?conversationId=${encodeURIComponent(id)}` : '';
      const response = await fetch(`/api/chat${query}`, { signal: controller.signal, cache: 'no-store' });
      const data = await response.json() as ChatData;
      if (!response.ok) {
        if (response.status === 401 && !controller.signal.aborted) setLoginRequired(true);
        throw new Error(data.error || 'Разговорът не може да се зареди.');
      }
      if (controller.signal.aborted) return;
      const recovered = readPendingChatTurn(data.user?.email, chatTurnScope(id, draftProjectId));
      const unsavedConversation = !id && recovered && data.conversationId !== recovered.request.conversationId;
      const selected = data.conversations?.find((item) => item.id === data.conversationId);
      setMessages(draftProjectId || unsavedConversation ? [] : data.messages ?? []);
      setConversations(data.conversations ?? []);
      setConversationId(draftProjectId || unsavedConversation ? null : data.conversationId ?? null);
      setMode(recovered?.request.mode ?? (draftProjectId ? 'work' : data.conversationMode ?? selected?.mode ?? 'chat'));
      setProjectContext(recovered?.request.projectId ?? (unsavedConversation ? null : draftProjectId || data.projectId || selected?.projectId || null));

      setSharkAssistant(data.capabilities?.sharkAssistant === true);
      setCapabilityReason(data.capabilities?.reason || '');
      setAccount(data.user ?? null);
      if (recovered) {
        failedRequest.current = recovered.request;
        setOptimistic(userTurn(recovered.request, recovered.attachment?.mimeType));
        setInput(recovered.input);
        setAttachment(recovered.attachment);
        setSelectedTool(recovered.tool);
        setBranchFrom(recovered.request.branchFrom ?? null);

        if (recovered.stopped) setNotice(recovered.problem);
        else setProblem(recovered.problem);
      }
    } catch (error) {
      if (!controller.signal.aborted) setLoadProblem(error instanceof Error ? error.message : 'Разговорът не може да се зареди.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [followLatest]);

  const loadProjects = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/projects', { cache: 'no-store', signal });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (signal?.aborted) return;
      setProjects(data.projects ?? []);
      setProjectError(false);
    } catch { if (!signal?.aborted) setProjectError(true); }
  }, []);

  const loadTools = useCallback(async () => {
    setToolsPending(true);
    setToolsError(false);
    try {
      const response = await fetch('/api/chat/tools', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      const data = await response.json();
      setTools(data.tools ?? []);
    } catch { setToolsError(true); }
    finally { setToolsPending(false); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const query = new URLSearchParams(window.location.search);
    const id = query.get('conversationId') || undefined;
    void loadConversation(id, !id ? query.get('project') || undefined : undefined);
    void loadProjects();
    void loadTools();
    return () => {
      mounted.current = false;
      loadController.current?.abort();
      sendController.current?.abort();
      cameraStream.current?.getTracks().forEach((track) => track.stop());
    };
  }, [loadConversation, loadProjects, loadTools]);

  useEffect(() => {
    if (!awaitingProjects) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      await loadProjects(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
    }
    timer = setTimeout(poll, 3000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [awaitingProjects, loadProjects]);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 820px)');
    const sync = () => setSmall(query.matches);
    sync();
    query.addEventListener('change', sync);
    const viewport = window.visualViewport;
    const updateHeight = () => shellRef.current?.style.setProperty('--chat-viewport', `${viewport?.height ?? window.innerHeight}px`);
    viewport?.addEventListener('resize', updateHeight);
    updateHeight();
    return () => {
      query.removeEventListener('change', sync);
      viewport?.removeEventListener('resize', updateHeight);
    };
  }, []);

  const closePopup = useCallback((restore = false) => {
    setPopup(null);
    if (restore) triggerRef.current?.focus();
  }, []);

  function togglePopup(id: Popup, trigger: HTMLButtonElement) {
    if (id === popup) { closePopup(); return; }
    triggerRef.current = trigger;
    setPopup(id);
  }

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    closePopup();
    requestAnimationFrame(() => railTrigger.current?.focus());
  }, [closePopup]);

  function closeInspector() {
    setInspector(null);
    requestAnimationFrame(() => inspectorReturnFocus.current?.focus());
  }

  function openInspector(item: InspectorItem) {
    inspectorReturnFocus.current = (popup && triggerRef.current) || document.activeElement as HTMLElement | null;
    setInspector(item);
    setDrawerOpen(false);
    setPopup(null);
    if (small && drawerOpen) inspectorReturnFocus.current = railTrigger.current;
  }

  useEffect(() => {
    const panel = popupRef.current;
    const anchor = triggerRef.current;
    const shell = shellRef.current;
    const topbar = topbarRef.current;
    const composeArea = composeAreaRef.current;
    if (popup !== 'tools' || small || !panel || !anchor || !shell || !topbar || !composeArea) return;
    const measure = () => {
      const space = anchor.getBoundingClientRect().top - topbar.getBoundingClientRect().bottom;
      panel.style.setProperty('--chat-popup-space', `${Math.max(0, space)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    observer.observe(topbar);
    observer.observe(composeArea);
    return () => {
      observer.disconnect();
      panel.style.removeProperty('--chat-popup-space');
    };
  }, [popup, small]);

  useEffect(() => {
    if (popup) popupRef.current?.querySelector<HTMLElement>('button:not(:disabled),a[href]')?.focus({ preventScroll: true });
  }, [popup]);

  useEffect(() => {
    if (small && drawerOpen) railRef.current?.querySelector<HTMLElement>('[data-close-rail]')?.focus();
  }, [small, drawerOpen]);

  useEffect(() => {
    if (inspector) inspectorRegion.current?.querySelector<HTMLElement>('button')?.focus();
  }, [inspector]);

  useEffect(() => {
    function clickOutside(event: PointerEvent) {
      const target = event.target as Node;
      if (target instanceof HTMLElement && target.classList.contains('shark-chat-popup-backdrop')) return;
      if (popup && !popupRef.current?.contains(target) && !triggerRef.current?.contains(target)) closePopup();
    }
    function onKey(event: KeyboardEvent) {
      if (cameraDialog.current?.open) return;
      if (event.key === 'Escape') {
        if (popup) closePopup(true);
        else if (inspector) closeInspector();
        else if (small && drawerOpen) closeDrawer();
      }
      const modal = small ? (popup === 'tools' ? popupRef.current : inspector ? inspectorRegion.current : drawerOpen ? railRef.current : null) : null;
      if (event.key !== 'Tab' || !modal) return;
      const entries = Array.from(modal.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not([type=hidden]):not(:disabled),textarea:not(:disabled),select:not(:disabled),iframe'));
      const first = entries[0];
      const last = entries[entries.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener('pointerdown', clickOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', clickOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [popup, small, drawerOpen, inspector, closeDrawer, closePopup]);

  function updateUrl(id: string | null, project: string | null = null) {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('conversationId', id);
    else url.searchParams.delete('conversationId');
    if (project) url.searchParams.set('project', project);
    else url.searchParams.delete('project');
    window.history.replaceState(null, '', url);
  }

  function clearFailedChatTurn() {
    failedRequest.current = null;
    writePendingChatTurn(null);
    setOptimistic(null);
  }

  function resetDraft() {
    setInput('');
    setAttachment(null);
    setBranchFrom(null);
    setSelectedTool(null);
    setTranscriptionLanguage('auto');
    setInspector(null);
    setProblem('');
    setNotice('');
    clearFailedChatTurn();
    failedCanvasRequest.current = null;
    failedReminderRequest.current = null;
    media.stopListening();
    media.stopSpeaking();
  }

  function newConversation(project?: string) {
    if (sending || uploading || mediaPending) return;
    loadController.current?.abort();
    followLatest();
    setLoading(false);
    setLoadProblem('');
    setLoginRequired(false);
    setMessages([]);
    setConversationId(null);
    setProjectContext(project ?? null);
    if (project) setMode('work');
    resetDraft();
    setDrawerOpen(false);
    closePopup();
    updateUrl(null, project ?? null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function chooseConversation(id: string) {
    if (sending || uploading || mediaPending) return;
    resetDraft();
    setMessages([]);
    updateUrl(id);
    closeDrawer();
    void loadConversation(id);
  }

  async function changeMode(value: Mode) {
    closePopup(popup === 'mode');
    if (value === mode || pending) return;
    media.stopListening();
    if (!conversationId || conversationId === 'legacy') {
      setMode(value);
      if (value === 'chat') setSelectedTool(null);
      return;
    }
    setModeSaving(true);
    setProblem('');
    try {
      const response = await fetch('/api/chat', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, mode: value }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Режимът не можа да се запази.');
      setMode(data.conversationMode);
      if (data.conversationMode === 'chat') setSelectedTool(null);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Режимът не можа да се запази.');
    } finally { setModeSaving(false); }
  }

  async function uploadFile(file: File) {
    const extension = file.name.split('.').pop()?.toLowerCase() || '';
    const mime = MIME_BY_EXTENSION[extension] || (file.type === 'audio/x-wav' ? 'audio/wav' : file.type);
    const allowed = UPLOAD_TYPES.includes(mime);
    const limit = AUDIO_MIME_TYPES.includes(mime) ? MAX_AUDIO_MB : 25;
    if (!allowed || file.size > limit * 1024 * 1024) {
      setProblem(allowed ? `Файлът трябва да бъде до ${limit} MB.` : 'Поддържат се изображения, PDF, DOCX, CSV, XLSX, текстови файлове и аудио във формат WAV, Ogg, M4A или WebM.');
      return;
    }
    setUploading(true);
    setProblem('');
    clearFailedChatTurn();
    try {
      const form = new FormData();
      form.append('file', mime === file.type ? file : new File([file], file.name, { type: mime }));
      const response = await fetch('/api/upload', { method: 'POST', body: form });
      const data = await response.json().catch(() => null);
      if (!response.ok || typeof data?.uploadId !== 'string') {
        throw new Error(data?.error || (response.status === 413 ? 'Файлът надвишава ограничението на сървъра.' : 'Качването не успя.'));
      }
      setAttachment({ id: data.uploadId, previewUrl: data.previewUrl || undefined, name: file.name, mimeType: data.mimeType || mime });
      inputRef.current?.focus();
    } catch (error) { setProblem(error instanceof Error ? error.message : 'Качването не успя.'); }
    finally { setUploading(false); }
  }

  function chooseFile(kind = 'any') {
    closePopup();
    if (!fileRef.current) return;
    fileRef.current.accept = INPUT_FILES[kind]?.accept ?? FILE_ACCEPT;
    fileRef.current.click();
  }

  function closeCamera() {
    if (cameraVideo.current) cameraVideo.current.srcObject = null;
    cameraStream.current?.getTracks().forEach((track) => track.stop());
    cameraStream.current = null;
    setCameraReady(false);
    cameraDialog.current?.close();
  }

  async function openCamera() {
    if (!media.camera || mediaPending) return;
    closePopup();
    setProblem('');
    setMediaPending(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if (!mounted.current || !cameraVideo.current || !cameraDialog.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      cameraStream.current = stream;
      cameraVideo.current.srcObject = stream;
      cameraDialog.current.showModal();
    } catch { setProblem('Камерата не може да се отвори. Провери разрешението и връзката с устройството.'); }
    finally { setMediaPending(false); }
  }

  async function photograph() {
    if (!cameraVideo.current) return;
    try {
      const file = await captureFrame(cameraVideo.current, 'камера.jpg');
      closeCamera();
      await uploadFile(file);
    } catch (error) { setProblem(error instanceof Error ? error.message : 'Заснемането не успя.'); }
  }

  async function captureScreen() {
    if (!media.screen || mediaPending) return;
    closePopup();
    setProblem('');
    setMediaPending(true);
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      if (!mounted.current) return;
      const video = document.createElement('video');
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      const file = await captureFrame(video, 'екран.jpg');
      stream.getTracks().forEach((track) => track.stop());
      await uploadFile(file);
    } catch { setProblem('Екранът не беше заснет. Провери дали споделянето е разрешено.'); }
    finally {
      stream?.getTracks().forEach((track) => track.stop());
      setMediaPending(false);
    }
  }

  function chooseTool(tool: ChatTool) {
    if (!tool.available) return;
    if (tool.id === 'scheduled-task') {
      openInspector({ type: 'reminders', title: 'Напомняния' });
      return;
    }
    media.stopListening();
    if (tool.id !== selectedTool?.id) setTranscriptionLanguage('auto');
    setSelectedTool(tool);
    setMode('work');
    closePopup();
    clearFailedChatTurn();
    requestAnimationFrame(() => {
      const select = tool.id === 'audio-transcribe' ? transcriptionLanguageRef.current : null;
      if (select && !select.disabled) select.focus();
      else inputRef.current?.focus();
    });
  }

  async function submit(request: ChatRequest, { speak = false, canvasMime }: { speak?: boolean; canvasMime?: string } = {}) {
    if (sendController.current) return { error: 'Изчакай текущата заявка да завърши.' };
    const panelAction = canvasMime || request.reminder;
    const retry = canvasMime ? failedCanvasRequest : request.reminder ? failedReminderRequest : failedRequest;
    const controller = new AbortController();
    sendController.current = controller;
    setSending(true);
    if (!panelAction) {
      setProblem('');
      setNotice('');
    }
    setPartial('');
    const priorAttachment = request.uploadId ? messages.find(({ imagePath }) => imagePath === request.uploadId) : undefined;
    const uploaded = request.uploadId === attachment?.id ? attachment : priorAttachment ? messageAttachment(priorAttachment) : null;
    const attempt = userTurn(request, canvasMime || uploaded?.mimeType);
    const query = new URLSearchParams(window.location.search);
    const previous = !panelAction && account?.email ? {
      owner: account.email, scope: chatTurnScope(query.get('conversationId') || undefined, query.get('project') || undefined),
      request, input: input.trim() === request.message ? input : request.message,
      attachment: uploaded, tool: selectedTool?.id === request.toolId ? selectedTool : tools.find(({ id }) => id === request.toolId) ?? null,
      problem: 'Получаването на отговора е прекъснато. Можеш да опиташ отново.',
    } : null;
    if (previous) writePendingChatTurn(previous);
    let keepAttempt = false;
    if (!panelAction) followLatest();
    setOptimistic(attempt);
    closePopup();
    try {
      const response = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify({ ...request, asyncImage: true }), signal: controller.signal,
      });
      const result = await readChatResponse(response, (delta) => setPartial((text) => text + delta));
      controller.signal.throwIfAborted();
      retry.current = null;
      if (!panelAction) writePendingChatTurn(null);
      const id = result.conversationId ?? request.conversationId;
      const received: Message[] = result.messages ?? [
        { id: request.requestId, role: 'user', content: request.message, imagePath: request.uploadId, attachmentMime: canvasMime },
        { id: `${request.requestId}-answer`, role: 'assistant', content: result.content, toolResult: result.toolResult },
      ];
      const replySource = result.assistant === 'shark' ? 'shark' : result.assistantFallback === true ? 'fallback' : undefined;
      const replyId = received.findLast((item) => item.role === 'assistant')?.id;
      const labelReply = (item: Message): Message => replySource && item.id === replyId ? { ...item, replySource } : item;
      if (request.branchFrom) {
        await loadConversation(id);
        if (replySource) setMessages((current) => current.map(labelReply));
      } else {
        setMessages((current) => [...current, ...received.filter((item) => !current.some(({ id: existing }) => item.id === existing)).map(labelReply)]);
        setConversationId(id);
        setConversations((current) => {
          const existing = current.find((item) => item.id === id);
          return [{
            id, title: result.title || existing?.title || request.message.slice(0, 66) || 'Нов разговор',
            mode: request.mode, projectId: request.projectId ?? existing?.projectId, updatedAt: new Date().toISOString(),
          }, ...current.filter((item) => item.id !== id)];
        });
      }
      updateUrl(id);
      if (!panelAction) {
        setInput('');
        setAttachment(null);
        setSelectedTool(null);
        setTranscriptionLanguage('auto');
        setBranchFrom(null);
      }
      if (result.toolResult?.projectId || result.messages?.some((message) => message.toolResult?.projectId)) void loadProjects();
      if (result.toolResult?.reminderId || result.messages?.some((message) => message.toolResult?.reminderId)) void reminders.refresh();
      if (speak) media.speak(result.content);
      return { result };
    } catch (cause) {
      retry.current = request;
      const error = controller.signal.aborted ? 'Получаването на отговора е прекъснато.'
        : cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'Връзката прекъсна. Можеш да опиташ отново.';
      if (!panelAction && mounted.current) {
        keepAttempt = true;
        if (previous) writePendingChatTurn({ ...previous, problem: error, stopped: controller.signal.aborted });
        if (controller.signal.aborted) setNotice(error);
        else setProblem(error);
      }
      return { error };
    } finally {
      if (sendController.current === controller) sendController.current = null;
      setSending(false);
      if (!keepAttempt) setOptimistic(panelAction ? optimistic : null);
      setPartial('');
    }
  }

  function send(text = input, options: { speak?: boolean; origin?: BranchFrom; prior?: Message; tool?: ChatTool } = {}) {
    if (!canSend || pending || loadProblem) return;
    const origin = options.origin ?? branchFrom;
    const repeat = !!options.origin;
    const uploadId = repeat ? options.prior?.imagePath || undefined : attachment?.id;
    const mime = repeat ? options.prior?.attachmentMime || (uploadId ? 'image/jpeg' : '') : attachment?.mimeType;
    const tool = repeat ? options.tool : selectedTool;
    const draft = text.trim();
    const transcription = tool?.id === 'audio-transcribe';
    const message = transcription && !repeat && transcriptionLanguage !== 'auto' && takesTranscriptionLanguage(draft)
      ? AUDIO_TRANSCRIPTION + TRANSCRIPTION_LANGUAGES[transcriptionLanguage].suffix
      : draft || (transcription ? AUDIO_TRANSCRIPTION : tool?.input === 'none' ? tool.label : '');
    if (!message && !uploadId) return;
    const requiredFile = tool && INPUT_FILES[tool.input];
    if (requiredFile && (!uploadId || !requiredFile.types.includes(mime || ''))) {
      setProblem(requiredFile.required);
      return;
    }
    if (media.listening) media.stopListening();
    const previous = failedRequest.current;
    const requestMode = repeat ? (tool ? 'work' : 'chat') : mode;
    const current = {
      message, mode: requestMode, model: 'auto', reasoning: undefined, uploadId,
      toolId: tool?.id, projectId: projectContext ?? undefined, branchFrom: origin || undefined,
    };
    const equivalent = !!previous && previous.message === message && previous.uploadId === uploadId && previous.toolId === current.toolId
      && previous.mode === current.mode && previous.projectId === current.projectId && previous.model === current.model && previous.reasoning === current.reasoning
      && previous.branchFrom?.messageId === current.branchFrom?.messageId;
    if (equivalent) { void submit(previous, { speak: options.speak }); return; }
    const id = !origin && conversationId ? conversationId : crypto.randomUUID();
    void submit({ ...current, conversationId: id, requestId: crypto.randomUUID() }, { speak: options.speak });
  }

  async function createReminder(reminder: ReminderInput) {
    if (!account || !reminderTool || pending || loadProblem) throw new Error('Записването на напомняне е недостъпно.');
    const previous = failedReminderRequest.current;
    const same = previous?.reminder && (!conversationId || previous.conversationId === conversationId)
      && previous.reminder.text === reminder.text && previous.reminder.localTime === reminder.localTime
      && previous.reminder.timeZone === reminder.timeZone && previous.reminder.repeat === reminder.repeat;
    const request = same ? previous : {
      message: `Напомни ми: ${reminder.text}`, reminder, conversationId: conversationId || crypto.randomUUID(),
      mode, projectId: projectContext ?? undefined, requestId: crypto.randomUUID(), toolId: reminderTool.id,
    };
    const reply = await submit(request);
    if (!reply.result) throw new Error(reply.error);
    const receipt = reply.result.toolResult ?? reply.result.messages?.at(-1)?.toolResult;
    if (!receipt?.reminderId) throw new Error('Сървърът не потвърди записването на напомняне.');
  }

  async function saveCanvas(file: Attachment, value: string) {
    const mime = file.mimeType || '';
    const tool = tools.find(({ id, available }) => id === 'text-file-edit' && available);
    if (!account || pending || loadProblem || !tool || !CANVAS_MIME_TYPES.includes(mime)) {
      throw new Error('В този разговор записът на текстово копие е недостъпен.');
    }
    if (value.length > CANVAS_CONTENT_LIMIT) throw new Error('Съдържанието надхвърля допустимия размер.');
    const message = CANVAS_SAVE_PREFIX + value;
    const previous = failedCanvasRequest.current;
    const request = previous?.message === message && previous.uploadId === file.id && (!conversationId || previous.conversationId === conversationId)
      ? previous : { message, uploadId: file.id, mode, conversationId: conversationId ?? crypto.randomUUID(), projectId: projectContext ?? undefined,
        requestId: crypto.randomUUID(), toolId: tool.id };
    const reply = await submit(request, { canvasMime: mime });
    if (!reply.result) throw new Error(reply.error);
    const receipt = reply.result.toolResult ?? reply.result.messages?.at(-1)?.toolResult;
    const revision = receipt ? artifactAttachment(receipt) : null;
    const url = receipt?.artifact?.url;
    if (!revision || !url || revision.id === file.id || revision.mimeType !== mime) {
      throw new Error('Сървърът не потвърди ново копие.');
    }
    setInspector((current) => current?.type === 'text' && current.attachment?.id === file.id
      ? { type: 'text', url, title: revision.name, attachment: revision, saved: true } : current);
  }

  function startDictation() {
    if (pending) return;
    media.stopSpeaking();
    setProblem('');
    setNotice('');
    void media.listen('dictation', (text) => setInput((value) => `${value.trimEnd()}${value.trim() ? ' ' : ''}${text}`));
  }

  function startVoice() {
    if (media.speaking) { media.stopSpeaking(); return; }
    if (pending) return;
    setProblem('');
    setNotice('');
    void media.listen('conversation', (text) => { setInput(text); send(text, { speak: true }); });
  }

  function editMessage(message: Message, toolId?: string) {
    if (!conversationId || pending) return;
    clearFailedChatTurn();
    setBranchFrom({ conversationId, messageId: message.id });
    setAttachment(messageAttachment(message));
    const previousTool = tools.find((tool) => tool.id === toolId && tool.available);
    setSelectedTool(previousTool ?? null);
    setTranscriptionLanguage('auto');
    if (previousTool) setMode('work');
    setInput(message.content);
    setNotice('Редакцията ще отвори нов клон от този момент в разговора.');
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function artifactEditor(file: Attachment) {
    const mime = file.mimeType || '';
    const ids = mime.startsWith('image/') ? ['image-edit', 'image-transform']
      : INPUT_FILES.dataset.types.includes(mime) ? ['spreadsheet-edit']
      : INPUT_FILES.document.types.includes(mime) ? ['document-edit']
      : CANVAS_MIME_TYPES.includes(mime) ? ['text-file-edit'] : [];
    return ids.map((id) => tools.find((tool) => tool.id === id && tool.available)).find(Boolean);
  }

  function attachArtifact(file: Attachment, edit: boolean) {
    if (pending) return;
    const editor = edit ? artifactEditor(file) : undefined;
    const requiredFile = selectedTool && INPUT_FILES[selectedTool.input];
    const incompatibleTool = requiredFile && !requiredFile.types.includes(file.mimeType || '');
    setBranchFrom(null);
    setAttachment(file);
    if (editor) {
      setSelectedTool(editor);
      setMode('work');
    } else if (incompatibleTool) {
      setSelectedTool(null);
    }
    setProblem('');
    setNotice(editor ? 'Опиши желаните промени.' : incompatibleTool
      ? 'Файлът е прикачен. Избери инструмент за този тип файл.' : 'Файлът е прикачен към следващата заявка.');
    clearFailedChatTurn();
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function copyMessage(message: Message) {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(message.id);
    } catch { setProblem('Браузърът не разреши копиране в клипборда.'); }
  }

  const railOpen = small ? drawerOpen : railVisible;
  const toolGroups = [...new Set(tools.map(({ group }) => group))];
  const filteredConversations = conversations.filter(({ title }) => title.toLocaleLowerCase('bg').includes(search.trim().toLocaleLowerCase('bg')));
  const filteredProjects = projects.filter(({ name }) => name.toLocaleLowerCase('bg').includes(search.trim().toLocaleLowerCase('bg')));

  function railAction() {
    if (small) {
      if (drawerOpen) closeDrawer();
      else setDrawerOpen(true);
    } else {
      setRailVisible((value) => !value);
      requestAnimationFrame(() => railVisible ? railTrigger.current?.focus() : railRef.current?.querySelector<HTMLElement>('a')?.focus());
    }
  }

  function renderMessage(message: Message, index: number, local = false) {
    const author = message.replySource === 'shark' ? 'Шарк агент — Основен'
      : message.replySource === 'fallback' ? 'Резервен модел на SharkAI' : 'SharkAI';
    const prior = message.role === 'assistant' ? messages[index - 1] : undefined;
    const project = message.toolResult?.projectId ? projects.find((item) => item.id === message.toolResult?.projectId) : undefined;
    const reminderId = message.toolResult?.reminderId;
    const regenerate = message.toolResult?.artifact ? tools.find((tool) => tool.id === message.toolResult?.toolId && tool.available) : undefined;
    const regenerateLabel = regenerate ? 'Прегенерирай резултата в клон' : 'Поискай нов отговор в клон';
    const attached = messageAttachment(message);
    const preview = attached ? attachmentInspection(attached) : null;
    const canEditFile = !local && preview?.type !== 'image' && attached?.mimeType
      && !CANVAS_MIME_TYPES.includes(attached.mimeType) && !!artifactEditor(attached);
    return (
      <article className={`shark-chat-message shark-chat-message-${message.role}`} key={message.id} aria-label={message.role === 'assistant' ? author : 'Ти'}>
        {message.role === 'assistant' && <div className="shark-chat-message-author"><Logo size="sm" /> {author}</div>}
        {preview?.type === 'image' && (
          <button type="button" className="shark-chat-image" onClick={() => openInspector(preview)}><img src={preview.url} alt="Прикачено изображение" /></button>
        )}
        {attached && !local && <div className="shark-chat-message-attachments">
          {preview?.type === 'text' && <button type="button" className="shark-chat-attachment-link" onClick={() => openInspector(preview)}><FileText size={16} /> Преглед на прикачения файл</button>}
          {preview?.type === 'audio' && <button type="button" className="shark-chat-attachment-link" onClick={() => openInspector(preview)}><AudioLines size={16} /> Прослушай записа</button>}
          {preview?.type !== 'image' && <a className="shark-chat-attachment-link" href={artifactDownloadUrl(uploadUrl(attached.id), attached)} download={attached.name}><Download size={16} /> Изтегли прикачения файл</a>}
          <button type="button" disabled={pending} className="shark-chat-attachment-link" onClick={() => attachArtifact(attached, false)}><Paperclip size={16} /> Прикачи файла</button>
          {canEditFile && <button type="button" disabled={pending} className="shark-chat-attachment-link" onClick={() => attachArtifact(attached, true)}><Pencil size={16} /> Използвай файла за редакция</button>}
        </div>}
        {(!message.toolResult?.imageJobId || message.toolResult.status === 'completed') && <div className="shark-chat-message-text">{message.content}</div>}
        {message.toolResult && <ToolReceipt result={message.toolResult} open={openInspector} reuse={attachArtifact} editable={(file) => !!artifactEditor(file)} disabled={pending} projectStatus={project && projectStatusLabel(project)} reminder={reminderId ? reminders.reminders.find(({ id }) => id === reminderId) : undefined} reminderDue={!!reminderId && reminders.notifications.some(({ reminderId: id }) => id === reminderId)} />}
        {!local && (
          <div className="shark-chat-message-actions">
            <button type="button" title={copied === message.id ? 'Копирано' : 'Копирай'} aria-label={copied === message.id ? 'Копирано' : 'Копирай'} onClick={() => void copyMessage(message)}>{copied === message.id ? <Check size={15} /> : <Copy size={15} />}</button>
            {message.role === 'user' && conversationId && <button type="button" disabled={pending} title="Редактирай в нов клон" aria-label="Редактирай в нов клон" onClick={() => editMessage(message, messages[index + 1]?.toolResult?.toolId)}><Pencil size={15} /></button>}
            {prior?.role === 'user' && conversationId && (!message.toolResult || regenerate) && <button type="button" disabled={pending || !canSend} title={regenerateLabel} aria-label={regenerateLabel} onClick={() => send(prior.content, { origin: { conversationId, messageId: prior.id }, prior, tool: regenerate })}><RotateCcw size={15} /></button>}
          </div>
        )}
      </article>
    );
  }

  function formSubmit(event: FormEvent) {
    event.preventDefault();
    send();
  }

  function popupButton(type: Popup, label: string, content: ReactNode, className: string, disabled = false) {
    return <button type="button" className={className} aria-label={label} title={label} aria-haspopup={type === 'tools' && small ? 'dialog' : undefined} aria-controls={`chat-popup-${type}`} aria-expanded={popup === type} disabled={disabled} onClick={(event) => togglePopup(type, event.currentTarget)}>{content}</button>;
  }

  function logout() {
    void fetch('/api/auth/logout', { method: 'POST' }).then((response) => {
      if (!response.ok) throw new Error();
      writePendingChatTurn(null);
      window.location.assign('/login');
    }).catch(() => setProblem('Изходът от акаунта не успя.'));
  }

  return (
    <div className="shark-chat-shell" ref={shellRef} data-rail={railVisible} data-drawer={drawerOpen}>
      <a href="#chat-main" className="shark-chat-skip">Към разговора</a>
      {small && drawerOpen && <button type="button" tabIndex={-1} className="shark-chat-drawer-backdrop" aria-label="Затвори историята" onClick={closeDrawer} />}
      <aside ref={railRef} className="shark-chat-rail" id="chat-rail" aria-label="История и проекти" aria-hidden={!railOpen} inert={!railOpen}>
        <header className="shark-chat-brand">
          <Link href="/"><Logo size="md" /><span>Shark<span>AI</span></span></Link>
          <button data-close-rail type="button" className="shark-chat-icon" title="Прибери историята" aria-label="Прибери историята" onClick={railAction}>{small ? <X size={20} /> : <PanelLeftClose size={19} />}</button>
        </header>
        {account && <div className="shark-chat-rail-actions ice-section">
          <button type="button" className="shark-chat-new" onClick={() => newConversation()} disabled={pending}><Plus size={18} /> Нов чат</button>
          <label className="shark-chat-search"><Search size={17} /><span className="shark-chat-sr">Търси в заглавията на разговори и проекти</span><input type="search" value={search} placeholder="Търси в историята" onChange={(event) => setSearch(event.target.value)} /></label>
        </div>}
        <div className="shark-chat-rail-content">
          {account && <section aria-label="Разговори">
            <h2>Разговори</h2>
            {loading && !conversations.length && <p>Зареждане…</p>}
            {!loading && !filteredConversations.length && <p>{search ? 'Няма съвпадения.' : 'Тук се показват разговорите ти.'}</p>}
            {filteredConversations.map(({ id, title }) => <button type="button" key={id} className="shark-chat-rail-row" disabled={sending || uploading || mediaPending || modeSaving} aria-current={conversationId === id ? 'page' : undefined} title={title} onClick={() => chooseConversation(id)}><MessageSquare size={16} /><span>{title}</span></button>)}
          </section>}
          {account && <section aria-label="Проекти">
            <h2>Проекти</h2>
            {projectError && <button type="button" className="shark-chat-rail-row" onClick={() => void loadProjects()}><RotateCcw size={16} /> <span>Повтори зареждането</span></button>}
            {!projectError && !filteredProjects.length && <p>{search ? 'Няма съвпадения.' : 'Няма проекти за показване.'}</p>}
            {filteredProjects.map((project) => <button type="button" key={project.id} className="shark-chat-rail-row" title={project.name} onClick={() => openInspector({ type: 'project', id: project.id, title: project.name })}><Folder size={16} /><span>{project.name}</span>{project.statusUnknown && <small>Непотвърден статус</small>}</button>)}
          </section>}
        </div>
        <nav className="shark-chat-rail-modules" aria-label="Работно пространство">
          <Link href="/dashboard" className="shark-chat-rail-row ice-section" data-ice-art="shark"><LayoutDashboard size={17} /><span>Обзор</span></Link>
          <Link href="/dashboard?view=studio" className="shark-chat-rail-row ice-section" data-ice-art="studio"><AppWindow size={17} /><span>Студио</span></Link>
          <Link href="/dashboard?view=investments&tab=strategies" className="shark-chat-rail-row ice-section" data-ice-art="markets"><Sparkles size={17} /><span>Инвестиционни стратегии</span></Link>
        </nav>
        <div className="shark-chat-profile">
          {account ? popupButton('profile', 'Меню на профила', <>
            <span className="shark-chat-profile-avatar">{account.name?.trim().charAt(0).toLocaleUpperCase('bg') || 'S'}</span>
            <span className="shark-chat-profile-name"><strong>{account.name || 'Профил'}</strong><small>{accountPlanLabel(account)}</small></span><ChevronDown size={15} />
          </>, 'shark-chat-profile-button') : !loading && <Link className="shark-chat-rail-row" href={signInHref}><Shield size={18} /><span>Вход в SharkAI</span></Link>}
          {popup === 'profile' && <div id="chat-popup-profile" className="shark-chat-popup shark-chat-profile-popup" ref={popupRef}>
            <Link href="/dashboard?view=settings"><Settings size={17} /> Настройки на акаунта</Link>
            {account?.role === 'ADMIN' && <Link href="/admin"><Shield size={17} /> Администрация</Link>}
            <button type="button" onClick={logout}><ExternalLink size={17} /> Изход</button>
          </div>}
        </div>
      </aside>

      <div className="shark-chat-workspace" data-mode={mode} inert={(small && !!inspector) || (small && drawerOpen)}>
        <header className="shark-chat-topbar" ref={topbarRef}>
          <div className="shark-chat-topbar-start">
            <button ref={railTrigger} className="shark-chat-icon shark-chat-rail-trigger" type="button" aria-label={railOpen ? 'Скрий историята' : 'Отвори историята'} title="История и проекти" aria-controls="chat-rail" aria-expanded={railOpen} onClick={railAction}>
              {small ? <Menu size={21} /> : railOpen ? <PanelLeftClose size={19} /> : <PanelLeftOpen size={19} />}
            </button>
            {account && <div className="shark-chat-mobile-mode">
              {popupButton('mode', `Режим ${modeLabel(mode)}`, <>{modeLabel(mode)} <ChevronDown size={15} /></>, 'shark-chat-mode-trigger', pending)}
              {popup === 'mode' && <div id="chat-popup-mode" className="shark-chat-popup shark-chat-mode-popup" ref={popupRef}>
                {(['chat', 'work'] as const).map((item) => <button type="button" key={item} onClick={() => changeMode(item)} aria-pressed={mode === item}>{modeLabel(item)} {mode === item && <Check size={16} />}</button>)}
              </div>}
            </div>}
          </div>
          {account && <div className="shark-chat-mode-switch" role="group" aria-label="Режим на разговора">
            {(['chat', 'work'] as const).map((item) => <button type="button" key={item} aria-pressed={mode === item} disabled={pending} onClick={() => changeMode(item)}>{item === 'chat' ? <MessageSquare size={15} /> : <BriefcaseBusiness size={15} />}{modeLabel(item)}</button>)}
          </div>}
          <div className="shark-chat-topbar-actions">
            {account && <button type="button" className="shark-chat-icon shark-chat-reminder-trigger" aria-label={reminders.notifications.length ? `Напомняния, ${reminders.notifications.length} непрочетени` : 'Напомняния'} title="Напомняния" aria-haspopup={small ? 'dialog' : undefined} aria-expanded={inspector?.type === 'reminders'} aria-controls="chat-reminders-panel" onClick={() => openInspector({ type: 'reminders', title: 'Напомняния' })}><Bell size={18} />{reminders.notifications.length > 0 && <span aria-hidden="true">{reminders.notifications.length}</span>}</button>}
            <Link className="shark-chat-topbar-studio" href="/dashboard?view=studio" aria-label="Студио" title="Студио"><AppWindow size={17} /><span>Студио</span></Link>
          </div>
        </header>
        <main id="chat-main" tabIndex={-1} className="shark-chat-main" data-start={showStart}>
          {loading && <p className="shark-chat-center-state" role="status"><LoaderCircle size={19} className="shark-chat-spinner" /> Зареждане на разговора…</p>}
          {loadProblem && <div className="shark-chat-center-state" role="alert">{loadProblem} {loginRequired ? <Link className="shark-chat-new" href={signInHref}>Вход за чат</Link> : <button type="button" onClick={() => void loadConversation(new URLSearchParams(window.location.search).get('conversationId') || undefined)}>Опитай отново</button>}</div>}
          {showStart ? <section className="shark-chat-welcome ice-section" data-ice-art={mode === 'work' ? 'studio' : 'agent'} aria-labelledby="chat-welcome-title">
            <div className="shark-chat-welcome-copy">
              <Logo size="lg" />
              <h1 id="chat-welcome-title">{mode === 'work' ? 'С какво ще работим?' : 'Как мога да помогна?'}</h1>
            </div>
          </section> : !loading && !loadProblem ? (
            <div className="shark-chat-thread-area">
              <div className="shark-chat-thread-scroll" ref={scrollRef} tabIndex={0} role="region" aria-label="История на разговора" onScroll={onScroll}>
                <div className="shark-chat-thread" role="log" aria-label="Разговор с SharkAI" aria-live="polite">
                  {messages.map((message, index) => renderMessage(message, index))}
                  {optimistic && renderMessage(optimistic, messages.length, true)}
                  {sending && (partial ? renderMessage({ id: 'stream', role: 'assistant', content: partial }, messages.length, true) : (
                    <div className="shark-chat-status" role="status"><LoaderCircle size={17} className="shark-chat-spinner" /> {selectedTool ? `Изпълнявам ${selectedTool.label}…` : 'Очаквам отговор…'}</div>
                  ))}
                </div>
              </div>
              {!following && <button className="shark-chat-jump-latest shark-chat-compose-icon" type="button" aria-label="Към последното съобщение" title="Към последното съобщение"
                onClick={() => { scrollRef.current?.focus({ preventScroll: true }); followLatest(); }}><ArrowDown size={19} /></button>}
            </div>
          ) : null}
          {canSend && !loadProblem ? <div className="shark-chat-compose-area" ref={composeAreaRef}>
            {showStart && (sharkAssistant || (mode === 'work' && tools.some(({ available }) => available))) && <div className="shark-chat-suggestions" aria-label="Предложения">
              {mode === 'work' ? tools.filter(({ available }) => available).slice(0, 3).map((tool) => <button type="button" disabled={pending} key={tool.id} onClick={() => chooseTool(tool)}><ToolIcon tool={tool} /> {tool.label}</button>) : suggestions.map(({ label, text, icon: Icon }) => <button type="button" key={label} disabled={pending} onClick={() => { setInput(text); send(text); }}><Icon size={16} /> {label}</button>)}
            </div>}
            <form className="shark-chat-composer ice-section" data-ice-art={mode === 'work' ? 'studio' : 'agent'} onSubmit={formSubmit}>
              {(attachment || selectedTool || branchFrom || uploading || projectContext) && <div className="shark-chat-chips" data-transcription={isTranscription || undefined}>
                {attachment && <div className="shark-chat-chip">
                  {attachmentPreview ? <button type="button" className="shark-chat-chip-preview" aria-label={`Преглед на ${attachment.name}`} onClick={() => openInspector(attachmentPreview)}>{attachmentPreview.type === 'image' ? <img src={attachmentPreview.url} alt="" /> : attachmentPreview.type === 'audio' ? <AudioLines size={16} /> : <FileText size={16} />}<span className="shark-chat-chip-name">{attachment.name}</span></button> : <span><FileText size={16} />{attachment.name}</span>}
                  <button type="button" aria-label="Премахни прикачения файл" disabled={sending} onClick={() => setAttachment(null)}><X size={15} /></button>
                </div>}
                {selectedTool && <div className="shark-chat-chip" data-audio-tool={isTranscription || undefined}>
                  {isTranscription ? <><span><ToolIcon tool={selectedTool} />Транскрипция</span><select ref={transcriptionLanguageRef} aria-label="Език на транскрипцията"
                    value={canChooseTranscriptionLanguage ? transcriptionLanguage : 'draft'} disabled={pending || !canChooseTranscriptionLanguage}
                    onChange={(event) => setTranscriptionLanguage(event.target.value as TranscriptionLanguage)}>
                    {Object.entries(TRANSCRIPTION_LANGUAGES).map(([value, option]) => <option key={value} value={value}>{option.label}</option>)}
                    {!canChooseTranscriptionLanguage && <option value="draft">От заявката</option>}
                  </select></> : <span><ToolIcon tool={selectedTool} />{selectedTool.label}</span>}
                  <button type="button" aria-label="Премахни избрания инструмент" disabled={sending} onClick={() => setSelectedTool(null)}><X size={15} /></button>
                </div>}
                {projectContext && <div className="shark-chat-chip"><span><Folder size={15} /> {projects.find((project) => project.id === projectContext)?.name ?? 'Проект'}</span></div>}
                {branchFrom && <div className="shark-chat-chip"><span><Pencil size={15} /> Нов клон</span><button type="button" aria-label="Отмени редакцията" disabled={sending} onClick={() => { clearFailedChatTurn(); setBranchFrom(null); setInput(''); setAttachment(null); setNotice(''); setProblem(''); }}><X size={15} /></button></div>}
                {uploading && <div className="shark-chat-chip" role="status"><LoaderCircle size={15} className="shark-chat-spinner" /> Качване…</div>}
              </div>}
              <label className="shark-chat-sr" htmlFor="chat-input">Съобщение</label>
              {datasetExample && <span className="shark-chat-sr" id="chat-dataset-example">Пример за групиране. {datasetExample}. Използвай точните имена на колоните от таблицата.</span>}
              <textarea id="chat-input" ref={inputRef} value={input} rows={2} maxLength={12000} disabled={pending || !canSend || !!loadProblem}
                aria-describedby={datasetExample ? 'chat-dataset-example' : undefined}
                placeholder={datasetExample ?? (mode === 'work' ? 'Опиши задачата си…' : 'Напиши съобщение…')}
                onChange={(event) => { if (failedRequest.current) { clearFailedChatTurn(); setNotice(''); } setInput(event.target.value); setProblem(''); }}
                onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />
              <div className="shark-chat-composer-actions">
                <div className="shark-chat-plus-anchor">
                  {popupButton('tools', 'Още действия', <Plus size={22} />, 'shark-chat-compose-icon', loading || sending)}
                  {popup === 'tools' && <>
                    {small && <button type="button" tabIndex={-1} className="shark-chat-popup-backdrop" aria-label="Затвори още действия" onClick={() => closePopup(true)} />}
                    <div id="chat-popup-tools" className="shark-chat-popup shark-chat-tools-popup" role={small ? 'dialog' : undefined} aria-modal={small ? true : undefined} aria-label="Още действия" ref={popupRef}>
                      <header className="ice-section" data-ice-art={mode === 'work' ? 'studio' : 'agent'}><span>Още действия</span><button className="shark-chat-icon" type="button" aria-label="Затвори още действия" onClick={() => closePopup(true)}><X size={17} /></button></header>
                      <section>
                        <h2>Прикачване</h2>
                        <button type="button" disabled={!account || pending} onClick={() => chooseFile()}><Paperclip size={17} /><span><strong>Прикачи файл</strong><small>{account ? `Изображение, документ, таблица или текст до 25 MB · Аудио до ${MAX_AUDIO_MB} MB` : 'Изисква вход в акаунт'}</small></span></button>
                        <button type="button" disabled={!account || !media.camera || pending} onClick={() => void openCamera()}><Camera size={17} /><span><strong>Камера</strong><small>{!account ? 'Изисква вход в акаунт' : !media.camera ? 'Браузърът не предоставя камера' : 'Направи снимка'}</small></span></button>
                        <button type="button" disabled={!account || !media.screen || pending} onClick={() => void captureScreen()}><ScreenShare size={17} /><span><strong>Сподели екран</strong><small>{!account ? 'Изисква вход в акаунт' : !media.screen ? 'Браузърът не поддържа споделяне' : 'Прикачи кадър от избрания екран'}</small></span></button>
                      </section>
                      <section>
                        <h2>Глас</h2>
                        {media.dictation ? <label className="shark-chat-voice-language"><span>Език на записа</span>
                          <select value={media.language} disabled={!!media.listening} onChange={(event) => media.setLanguage(event.target.value === 'bg' || event.target.value === 'en' ? event.target.value : 'auto')}>
                            <option value="auto">Автоматично</option><option value="bg">Български</option><option value="en">Английски</option>
                          </select>
                        </label> : <button type="button" disabled><Mic size={17} /><span><strong>Диктовка</strong><small>{media.dictationReason}</small></span></button>}
                        {voiceUnavailable && <button type="button" disabled><AudioLines size={17} /><span><strong>Гласов разговор</strong><small>{voiceUnavailable}</small></span></button>}
                      </section>
                      {toolsPending && <p className="shark-chat-status" role="status"><LoaderCircle size={16} className="shark-chat-spinner" /> Зареждане на инструментите…</p>}
                      {toolsError && <button type="button" onClick={() => void loadTools()}><RotateCcw size={17} /> Зареди инструментите отново</button>}
                      {toolGroups.map((group) => <section key={group}><h2>{group}</h2>{tools.filter((tool) => tool.group === group).map((tool) => (
                        <button type="button" key={tool.id} disabled={!tool.available || pending} aria-pressed={selectedTool?.id === tool.id} onClick={() => chooseTool(tool)}><ToolIcon tool={tool} /><span><strong>{tool.label}</strong><small>{tool.available ? tool.description : tool.reason || 'Функцията е недостъпна.'}</small></span>{selectedTool?.id === tool.id && <Check size={16} />}</button>
                      ))}</section>)}
                    </div>
                  </>}
                </div>
                <input ref={fileRef} type="file" hidden onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void uploadFile(file); }} />
                {selectedTool && INPUT_FILES[selectedTool.input] && <button type="button" title="Избери входен файл" aria-label="Избери входен файл" className="shark-chat-compose-icon" disabled={pending} onClick={() => chooseFile(selectedTool.input)}><Paperclip size={17} /></button>}
                <div className="shark-chat-compose-spacer" />
                <span className="shark-chat-model-button" title="Основен агент в n8n">{modelLabel}</span>
                <button type="button" className="shark-chat-compose-icon" aria-label={dictationLabel} aria-pressed={media.listening === 'dictation'} title={media.dictationReason || dictationLabel} disabled={!media.dictation || !canSend || pending} onClick={startDictation}><Mic size={20} /></button>
                <button type="button" className="shark-chat-compose-icon shark-chat-voice" aria-label={conversationLabel} aria-pressed={media.listening === 'conversation' || media.speaking} title={voiceUnavailable || conversationLabel} disabled={!media.speaking && (!!voiceUnavailable || !canSend || pending)} onClick={startVoice}><AudioLines size={20} /></button>
                {sending ? <button className="shark-chat-send" type="button" aria-label="Спри отговора" title="Спри отговора" onClick={() => sendController.current?.abort()}><Square size={16} fill="currentColor" /></button> :
                  <button className="shark-chat-send" type="submit" aria-label="Изпрати" title="Изпрати" disabled={!canSend || pending || !!loadProblem || (!input.trim() && !attachment && selectedTool?.input !== 'none')}><ArrowUp size={21} /></button>}
              </div>
            </form>
            <div className="shark-chat-composer-status" aria-live="polite">
              {problem && <span className="shark-chat-notice" role="alert">{problem}</span>}
              {notice && <span>{notice}</span>}
              {!pending && (problem || notice) && failedRequest.current && <button type="button" className="shark-chat-new" onClick={() => { if (failedRequest.current) void submit(failedRequest.current); }}><RotateCcw size={15} /> Повтори изпращането</button>}
              {!problem && !notice && (media.recordStage || media.speechStage) && <span>{media.speechStage === 'playing' ? 'SharkAI отговаря на глас.' : media.speechStage === 'preparing' ? 'Подготвям звук…' : media.recordStage === 'transcribing' ? 'Разпознавам записа…' : media.recordStage === 'recording' ? 'Записвам. Натисни отново, за да приключиш.' : 'Включвам микрофона…'}</span>}
              {!loading && account && !sharkAssistant && capabilityReason && <span>{capabilityReason}</span>}
            </div>
          </div> : showStart && <div className="shark-chat-compose-area">
            <div className="shark-chat-sign-in ice-section" data-ice-art="agent">
              <p>Влез, за да пишеш в чата и да отвориш историята си.</p>
              <Link className="shark-chat-new" href={signInHref}><Shield size={17} aria-hidden="true" /> Вход за чат</Link>
            </div>
          </div>}
        </main>
      </div>
      {inspector && <div className="shark-chat-inspector-region" id={inspector.type === 'reminders' ? 'chat-reminders-panel' : undefined} ref={inspectorRegion} role={small ? 'dialog' : undefined} aria-modal={small ? true : undefined} aria-label={inspector.title}><Inspector item={inspector} close={closeInspector} reminders={reminders} createReminder={reminderTool ? createReminder : undefined} disabled={pending} save={account && tools.some(({ id, available }) => id === 'text-file-edit' && available) ? saveCanvas : undefined} talk={pending ? undefined : (project) => newConversation(project)} /></div>}
      <dialog className="shark-chat-camera-dialog" ref={cameraDialog} onCancel={(event) => { event.preventDefault(); closeCamera(); }}>
        <header className="ice-section" data-ice-art="agent"><h2>Камера</h2><button className="shark-chat-icon" type="button" aria-label="Затвори камерата" onClick={closeCamera}><X size={18} /></button></header>
        <video ref={cameraVideo} muted autoPlay playsInline onLoadedMetadata={() => setCameraReady(true)} />
        <button type="button" className="shark-chat-new" disabled={!cameraReady} onClick={() => void photograph()}><Camera size={18} /> Направи снимка</button>
      </dialog>
    </div>
  );
}
