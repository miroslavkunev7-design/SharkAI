import { createOpenAI } from '@ai-sdk/openai';
import { gateway, type LanguageModel } from 'ai';
import type { AccountSession } from '../auth';
import { getAnthropic, getGoogle, getGroq, getOpenAI, googleChatModels, groqChatModels, isPaidAIEnabled } from './config';

export type ReasoningLevel = 'standard' | 'deep';

interface WorkspaceModel {
  id: 'standard' | 'advanced';
  label: string;
  provider: 'openai' | 'gateway' | 'anthropic' | 'google' | 'groq' | 'compatible';
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
    provider: 'compatible',
    imageInput: process.env.SHARKAI_OPENAI_CHAT_VISION === 'true',
    reasoningLevels: ['standard'],
    model: provider.chat(modelId),
    nativeToolCalls: process.env.SHARKAI_OPENAI_CHAT_TOOLS === 'true' ? 'compatible' : undefined,
  };
}

function googleWorkspaceModel(provider: NonNullable<Awaited<ReturnType<typeof getGoogle>>>, id: WorkspaceModel['id']): WorkspaceModel {
  return {
    id, label: id === 'standard' ? 'Gemini 3.5 Flash-Lite' : 'Gemini 3.8 Flash', provider: 'google',
    imageInput: true, reasoningLevels: ['standard'], model: provider.chat(googleChatModels[id]), nativeToolCalls: 'compatible',
  };
}

function groqWorkspaceModel(provider: NonNullable<Awaited<ReturnType<typeof getGroq>>>, id: WorkspaceModel['id']): WorkspaceModel {
  return {
    id, label: id === 'standard' ? 'Llama 3.1 8B · Groq' : 'Llama 3.3 70B · Groq', provider: 'groq',
    imageInput: false, reasoningLevels: ['standard'], model: provider.chat(groqChatModels[id]), nativeToolCalls: 'compatible',
  };
}

function anthropicWorkspaceModel(provider: NonNullable<Awaited<ReturnType<typeof getAnthropic>>>, id: WorkspaceModel['id']): WorkspaceModel {
  return {
    id, label: 'Claude Haiku', provider: 'anthropic', imageInput: true, reasoningLevels: ['standard'],
    model: provider('claude-3-5-haiku-20241022'), nativeToolCalls: 'anthropic',
  };
}

export async function fallbackWorkspaceModel(primary: WorkspaceModel, requirements: {
  imageInput: boolean; nativeTools: boolean; reasoning: ReasoningLevel;
}): Promise<WorkspaceModel | null> {
  // A custom endpoint is deliberately selected and may run locally with private model input.
  if (primary.provider === 'compatible' || requirements.reasoning !== 'standard') return null;
  const { id } = primary;
  const eligible = (model: WorkspaceModel) =>
    (!requirements.imageInput || model.imageInput) && (!requirements.nativeTools || !!model.nativeToolCalls);
  if (primary.provider !== 'groq' && !requirements.imageInput) {
    const groq = await getGroq();
    const candidate = groq && groqWorkspaceModel(groq, id);
    if (candidate && eligible(candidate)) return candidate;
  }
  if (primary.provider !== 'google') {
    const google = await getGoogle();
    const candidate = google && googleWorkspaceModel(google, id);
    if (candidate && eligible(candidate)) return candidate;
  }
  if (primary.provider !== 'anthropic') {
    const anthropic = await getAnthropic();
    const candidate = anthropic && anthropicWorkspaceModel(anthropic, id);
    if (candidate && eligible(candidate)) return candidate;
  }
  return null;
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
      id: 'standard', label: 'GPT-4o mini', provider: openai ? 'openai' : 'gateway', imageInput: true, reasoningLevels: ['standard'],
      model: openai ? openai('gpt-4o-mini') : gateway('openai/gpt-4o-mini'),
      nativeToolCalls: 'openai',
    });
    if (advanced) {
      models.push({
        id: 'advanced', label: 'GPT-5 mini', provider: openai ? 'openai' : 'gateway', imageInput: true, reasoningLevels: ['standard', 'deep'],
        model: openai ? openai('gpt-5-mini') : gateway('openai/gpt-5-mini'), reasoning: 'openai', nativeToolCalls: 'openai',
      });
    }
  } else {
    const anthropic = await getAnthropic();
    if (anthropic) {
      models.push(anthropicWorkspaceModel(anthropic, 'standard'));
    } else {
      const [google, groq] = await Promise.all([getGoogle(), getGroq()]);
      if (google) models.push(googleWorkspaceModel(google, 'standard'));
      else if (groq) models.push(groqWorkspaceModel(groq, 'standard'));
      if (advanced && groq) models.push(groqWorkspaceModel(groq, 'advanced'));
      else if (advanced && google) models.push(googleWorkspaceModel(google, 'advanced'));
    }
  }
  return { models, reason: models.length ? null : 'Няма конфигуриран доставчик за AI чат.' };
}
