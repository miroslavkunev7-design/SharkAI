import { createOpenAI } from '@ai-sdk/openai';
import { gateway, type LanguageModel } from 'ai';
import type { AccountSession } from '../auth';
import { getAnthropic, getGoogle, getGroq, getOpenAI, googleChatModels, groqChatModels, isPaidAIEnabled } from './config';

export type ReasoningLevel = 'standard' | 'deep';

interface WorkspaceModel {
  id: 'standard' | 'advanced';
  label: string;
  imageInput: boolean;
  reasoningLevels: ReasoningLevel[];
  model: LanguageModel;
  reasoning?: 'openai';
  nativeToolCalls?: 'openai' | 'compatible' | 'anthropic';
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
    nativeToolCalls: process.env.SHARKAI_OPENAI_CHAT_TOOLS === 'true' ? 'compatible' : undefined,
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
  const advanced = session.plan !== 'FREE' || session.role === 'ADMIN';
  if (openai || process.env.AI_GATEWAY_API_KEY) {
    models.push({
      id: 'standard', label: 'GPT-4o mini', imageInput: true, reasoningLevels: ['standard'],
      model: openai ? openai('gpt-4o-mini') : gateway('openai/gpt-4o-mini'),
      nativeToolCalls: 'openai',
    });
    if (advanced) {
      models.push({
        id: 'advanced', label: 'GPT-5 mini', imageInput: true, reasoningLevels: ['standard', 'deep'],
        model: openai ? openai('gpt-5-mini') : gateway('openai/gpt-5-mini'), reasoning: 'openai', nativeToolCalls: 'openai',
      });
    }
  } else {
    const anthropic = await getAnthropic();
    if (anthropic) {
      models.push({
        id: 'standard', label: 'Claude Haiku', imageInput: true, reasoningLevels: ['standard'],
        model: anthropic('claude-3-5-haiku-20241022'), nativeToolCalls: 'anthropic',
      });
    } else {
      const [google, groq] = await Promise.all([getGoogle(), getGroq()]);
      if (google) {
        models.push({
          id: 'standard', label: 'Gemini 3.5 Flash-Lite', imageInput: true, reasoningLevels: ['standard'],
          model: google.chat(googleChatModels.standard), nativeToolCalls: 'compatible',
        });
      } else if (groq) {
        models.push({
          id: 'standard', label: 'Llama 3.1 8B · Groq', imageInput: false, reasoningLevels: ['standard'],
          model: groq.chat(groqChatModels.standard), nativeToolCalls: 'compatible',
        });
      }
      if (advanced && groq) {
        models.push({
          id: 'advanced', label: 'Llama 3.3 70B · Groq', imageInput: false, reasoningLevels: ['standard'],
          model: groq.chat(groqChatModels.advanced), nativeToolCalls: 'compatible',
        });
      } else if (advanced && google) {
        models.push({
          id: 'advanced', label: 'Gemini 3.8 Flash', imageInput: true, reasoningLevels: ['standard'],
          model: google.chat(googleChatModels.advanced), nativeToolCalls: 'compatible',
        });
      }
    }
  }
  return { models, reason: models.length ? null : 'Няма конфигуриран доставчик за AI чат.' };
}
