import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { getOpenAIKey, getAnthropicKey, getGoogleKey, getGroqKey, isPaidAIMode } from '../settings';

export const googleChatModels = { standard: 'gemini-3.5-flash-lite', advanced: 'gemini-3.8-flash' } as const;
export const groqChatModels = { standard: 'llama-3.1-8b-instant', advanced: 'llama-3.3-70b-versatile' } as const;

let cachedKey: string | null | undefined;
let cachedAnthropicKey: string | null | undefined;
let cachedPaidAI: boolean | undefined;
let cachedOpenAI: ReturnType<typeof createOpenAI> | null = null;
let cachedAnthropic: ReturnType<typeof createAnthropic> | null = null;
let cachedGoogle: ReturnType<typeof createOpenAI> | null | undefined;
let cachedGroq: ReturnType<typeof createOpenAI> | null | undefined;

/** SharkAI по подразбиране е локален — платен AI само ако е включен от Admin. */
export async function isPaidAIEnabled(): Promise<boolean> {
  if (cachedPaidAI !== undefined) return cachedPaidAI;
  cachedPaidAI = await isPaidAIMode();
  return cachedPaidAI;
}

async function resolveOpenAIKey() {
  if (cachedKey !== undefined) return cachedKey;
  cachedKey = await getOpenAIKey();
  return cachedKey;
}

async function resolveAnthropicKey() {
  if (cachedAnthropicKey !== undefined) return cachedAnthropicKey;
  cachedAnthropicKey = await getAnthropicKey();
  return cachedAnthropicKey;
}

export async function getOpenAI() {
  if (!(await isPaidAIEnabled())) return null;
  const key = await resolveOpenAIKey();
  if (!key) return null;
  if (!cachedOpenAI) cachedOpenAI = createOpenAI({ apiKey: key });
  return cachedOpenAI;
}

export async function getAnthropic() {
  if (!(await isPaidAIEnabled())) return null;
  const key = await resolveAnthropicKey();
  if (!key) return null;
  if (!cachedAnthropic) cachedAnthropic = createAnthropic({ apiKey: key });
  return cachedAnthropic;
}

export async function getGoogle() {
  if (!(await isPaidAIEnabled())) return null;
  if (cachedGoogle === undefined) {
    const key = await getGoogleKey();
    cachedGoogle = key ? createOpenAI({
      apiKey: key,
      name: 'google-gemini',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    }) : null;
  }
  return cachedGoogle;
}

export async function getGroq() {
  if (!(await isPaidAIEnabled())) return null;
  if (cachedGroq === undefined) {
    const key = await getGroqKey();
    cachedGroq = key ? createOpenAI({
      apiKey: key,
      name: 'groq',
      baseURL: 'https://api.groq.com/openai/v1',
    }) : null;
  }
  return cachedGroq;
}

export function clearAIKeyCache() {
  cachedKey = undefined;
  cachedAnthropicKey = undefined;
  cachedPaidAI = undefined;
  cachedOpenAI = null;
  cachedAnthropic = null;
  cachedGoogle = undefined;
  cachedGroq = undefined;
}

export async function hasAIProvider(): Promise<boolean> {
  if (!(await isPaidAIEnabled())) return false;
  const providers = await Promise.all([resolveOpenAIKey(), resolveAnthropicKey(), getGoogle(), getGroq()]);
  return providers.some(Boolean) || Boolean(process.env.AI_GATEWAY_API_KEY);
}

export async function getChatModel() {
  const openai = await getOpenAI();
  if (openai) return openai('gpt-4o-mini');
  const anthropic = await getAnthropic();
  if (anthropic) return anthropic('claude-3-5-haiku-20241022');
  const google = await getGoogle();
  if (google) return google.chat(googleChatModels.standard);
  const groq = await getGroq();
  return groq?.chat(groqChatModels.standard) ?? null;
}

export async function getTextModel({ requiresVision = false } = {}) {
  const openai = await getOpenAI();
  if (openai) return openai('gpt-4o');
  const anthropic = await getAnthropic();
  if (anthropic) return anthropic('claude-sonnet-4-20250514');
  const google = await getGoogle();
  if (google) return google.chat(googleChatModels.advanced);
  if (requiresVision) return null;
  const groq = await getGroq();
  return groq?.chat(groqChatModels.advanced) ?? null;
}

export async function getVisionModel() {
  return getTextModel({ requiresVision: true });
}
