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
}

export type InspectorItem =
  | { type: 'project'; id: string; title: string }
  | { type: 'image'; url: string; title: string };

export const imageUrl = (id: string) => `/api/upload/${encodeURIComponent(id)}`;

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

export const projectInProgress = (status: string) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(status);
