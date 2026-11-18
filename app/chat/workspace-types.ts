import type { ChatToolResult } from '@/lib/chat-tools';

export type Mode = 'chat' | 'work';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  imagePath?: string | null;
  attachmentMime?: string | null;
  toolResult?: ChatToolResult | null;
}

export interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
  mode?: Mode;
  projectId?: string | null;
}

export interface Account {
  name: string | null;
  email?: string;
  plan: string;
  role: string;
}

export interface Model {
  id: string;
  label: string;
  reasoningLevels: string[];
  imageInput?: boolean;
}

export interface Attachment {
  id: string;
  name: string;
  previewUrl?: string;
  mimeType?: string;
}

export interface Project {
  id: string;
  name: string;
  status: string;
  statusUnknown?: boolean;
}

export type InspectorItem =
  | { type: 'project'; id: string; title: string }
  | { type: 'reminders'; title: string }
  | { type: 'image'; url: string; title: string; attachment?: Attachment }
  | { type: 'text'; url: string; title: string; attachment?: Attachment; saved?: boolean };

export const uploadUrl = (id: string) => `/api/upload/${encodeURIComponent(id)}`;

export function safeLink(link: string) {
  if (link.startsWith('/') && !link.startsWith('//') && !link.includes('\\')) return link;
  try {
    const url = new URL(link);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
  } catch { /* Invalid source URL. */ }
  return null;
}

export const PROJECT_STATUS: Record<string, string> = {
  DRAFT: 'Чернова', PENDING: 'Изчаква', ANALYZING: 'Анализиране', PLANNING: 'Планиране',
  BUILDING: 'Изграждане', RUNNING: 'Изпълнява се', DEPLOYING: 'Подготовка на резултата', REVIEWING: 'Преглед', TESTING: 'Проверка', FIXING: 'Корекции',
  GENERATING: 'Генериране', VALIDATING: 'Проверка', PACKAGING: 'Пакетиране',
  COMPLETED: 'Завършен', FAILED: 'Неуспешен', CANCELLED: 'Отменен',
};

export const projectInProgress = (project: Project) => !project.statusUnknown && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(project.status);

export const projectStatusLabel = (project: Project) => project.statusUnknown ? 'Непотвърден статус' : PROJECT_STATUS[project.status] || project.status;

const FILE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'application/pdf': 'pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv', 'text/plain': 'txt', 'text/markdown': 'md', 'application/json': 'json',
};

export const CANVAS_MIME_TYPES = ['text/plain', 'text/markdown', 'application/json'];
export const CANVAS_SAVE_PREFIX = 'Запиши съдържание:\n';
export const CANVAS_CONTENT_LIMIT = 24000 - CANVAS_SAVE_PREFIX.length;

export function isTextArtifact(mime: string) {
  return CANVAS_MIME_TYPES.includes(mime) || mime === 'text/csv';
}

export function messageAttachment(message: Message): Attachment | null {
  if (!message.imagePath) return null;
  const mimeType = message.attachmentMime ?? 'image/jpeg';
  const isImage = mimeType.startsWith('image/');
  const extension = message.attachmentMime ? FILE_EXTENSIONS[message.attachmentMime] : undefined;
  const label = isImage ? 'Прикачено изображение' : 'Прикачен файл';
  return {
    id: message.imagePath, mimeType, name: extension ? `${label}.${extension}` : label,
    previewUrl: isImage ? uploadUrl(message.imagePath) : undefined,
  };
}

export function attachmentInspection(file: Attachment): InspectorItem | null {
  if (file.previewUrl) return { type: 'image', url: file.previewUrl, title: file.name, attachment: file };
  return file.mimeType && isTextArtifact(file.mimeType)
    ? { type: 'text', url: uploadUrl(file.id), title: file.name, attachment: file }
    : null;
}

export function artifactDownloadUrl(url: string, attachment: Attachment | undefined) {
  if (!attachment) return url;
  const download = new URL(url, 'https://sharkai.invalid');
  download.searchParams.set('download', attachment.name);
  return `${download.pathname}${download.search}`;
}

export function artifactAttachment(result: ChatToolResult): Attachment | null {
  const artifact = result.artifact;
  if (!artifact) return null;
  if (!artifact.url.startsWith('/') || !safeLink(artifact.url)) return null;
  const localOrigin = 'https://sharkai.invalid';
  const location = new URL(artifact.url, localOrigin);
  if (location.origin !== localOrigin) return null;
  const id = /^\/api\/upload\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i.exec(location.pathname)?.[1];
  const extension = FILE_EXTENSIONS[artifact.mimeType];
  if (!id || !extension) return null;
  return {
    id, name: artifact.filename || `${result.label}.${extension}`, mimeType: artifact.mimeType,
    previewUrl: artifact.mimeType.startsWith('image/') ? artifact.url : undefined,
  };
}
