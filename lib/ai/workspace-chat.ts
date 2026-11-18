import { createOpenAI } from '@ai-sdk/openai';
import { gateway, type LanguageModel } from 'ai';
import type { AccountSession } from '../auth';
import { getChatModel, getOpenAI, isPaidAIEnabled } from './config';

export type ReasoningLevel = 'standard' | 'deep';

interface WorkspaceModel {
  id: 'standard' | 'advanced';
  label: string;
  imageInput: boolean;
  reasoningLevels: ReasoningLevel[];
  model: LanguageModel;
  reasoning?: 'openai';
}

function configuredCompatibleChat(): WorkspaceModel | null {
  const configuredUrl = process.env.SHARKAI_OPENAI_CHAT_BASE_URL;
  const modelId = process.env.SHARKAI_OPENAI_CHAT_MODEL;
  if (!configuredUrl || !modelId) return null;
  const apiKey = process.env.SHARKAI_OPENAI_CHAT_API_KEY;
  let url: URL;
  try { url = new URL(configuredUrl); } catch { return null; }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (!loopback && url.protocol !== 'https:') || (!loopback && !apiKey)) {
    return null;
  }
  if (!['https:', 'http:'].includes(url.protocol)) return null;
  const provider = createOpenAI({ apiKey: apiKey || 'local', baseURL: url.href.replace(/\/$/, '') });
  return {
    id: 'standard',
    label: modelId,
    imageInput: process.env.SHARKAI_OPENAI_CHAT_VISION === 'true',
    reasoningLevels: ['standard'],
    model: provider.chat(modelId),
  };
}

export function remainingChatTokens(session: AccountSession) {
  if (session.role === 'ADMIN' || session.plan === 'ULTRA') return Infinity;
  return Math.max(0, session.tokensLimit - session.tokensUsed);
}

export async function workspaceModels(session: AccountSession | null) {
  if (!session) return { models: [], reason: 'Влез в акаунта си, за да започнеш разговор.' };
  if (remainingChatTokens(session) === 0) return { models: [], reason: 'Достигнат е лимитът на текущия план.' };
  if (!(await isPaidAIEnabled())) return { models: [], reason: 'Администраторът не е включил доставчик за AI чат.' };

  const custom = configuredCompatibleChat();
  if (custom) return { models: [custom], reason: null };
  const openai = await getOpenAI();
  const models: WorkspaceModel[] = [];
  if (openai || process.env.AI_GATEWAY_API_KEY) {
    models.push({
      id: 'standard', label: 'GPT-4o mini', imageInput: true, reasoningLevels: ['standard'],
      model: openai ? openai('gpt-4o-mini') : gateway('openai/gpt-4o-mini'),
    });
    if (session.plan !== 'FREE' || session.role === 'ADMIN') {
      models.push({
        id: 'advanced', label: 'GPT-5 mini', imageInput: true, reasoningLevels: ['standard', 'deep'],
        model: openai ? openai('gpt-5-mini') : gateway('openai/gpt-5-mini'), reasoning: 'openai',
      });
    }
  } else {
    const anthropic = await getChatModel();
    if (anthropic) models.push({ id: 'standard', label: 'Claude Haiku', imageInput: true, reasoningLevels: ['standard'], model: anthropic });
  }
  return { models, reason: models.length ? null : 'Няма конфигуриран доставчик за AI чат.' };
}
