import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { getOpenAIKey, getAnthropicKey, isPaidAIMode } from '../settings';

let cachedKey: string | null | undefined;
let cachedAnthropicKey: string | null | undefined;
let cachedPaidAI: boolean | undefined;
let cachedOpenAI: ReturnType<typeof createOpenAI> | null = null;
let cachedAnthropic: ReturnType<typeof createAnthropic> | null = null;

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

async function getOpenAI() {
  if (!(await isPaidAIEnabled())) return null;
  const key = await resolveOpenAIKey();
  if (!key) return null;
  if (!cachedOpenAI) cachedOpenAI = createOpenAI({ apiKey: key });
  return cachedOpenAI;
}

async function getAnthropic() {
  if (!(await isPaidAIEnabled())) return null;
  const key = await resolveAnthropicKey();
  if (!key) return null;
  if (!cachedAnthropic) cachedAnthropic = createAnthropic({ apiKey: key });
  return cachedAnthropic;
}

export function clearAIKeyCache() {
  cachedKey = undefined;
  cachedAnthropicKey = undefined;
  cachedPaidAI = undefined;
  cachedOpenAI = null;
  cachedAnthropic = null;
}

export async function hasAIProvider(): Promise<boolean> {
  if (!(await isPaidAIEnabled())) return false;
  const openai = await resolveOpenAIKey();
  const anthropic = await resolveAnthropicKey();
  return !!(openai || anthropic || process.env.AI_GATEWAY_API_KEY);
}

export async function getChatModel() {
  const openai = await getOpenAI();
  if (openai) return openai('gpt-4o-mini');
  const anthropic = await getAnthropic();
  if (anthropic) return anthropic('claude-3-5-haiku-20241022');
  return null;
}

export async function getTextModel() {
  const openai = await getOpenAI();
  if (openai) return openai('gpt-4o');
  const anthropic = await getAnthropic();
  if (anthropic) return anthropic('claude-sonnet-4-20250514');
  return null;
}

export async function getVisionModel() {
  return getTextModel();
}
