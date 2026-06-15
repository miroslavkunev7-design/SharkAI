import { prisma } from './db';

const KEY_OPENAI = 'openai_api_key';
const KEY_ANTHROPIC = 'anthropic_api_key';
const KEY_PAID_AI = 'sharkai_use_paid_ai';

async function getConfig(key: string): Promise<string | null> {
  try {
    const row = await prisma.systemConfig.findUnique({ where: { key } });
    return row?.value?.trim() || null;
  } catch {
    return null;
  }
}

async function setConfig(key: string, value: string) {
  await prisma.systemConfig.upsert({
    where: { key },
    create: { key, value: value.trim() },
    update: { value: value.trim() },
  });
}

export async function getOpenAIKey(): Promise<string | null> {
  const db = await getConfig(KEY_OPENAI);
  if (db) return db;
  return process.env.OPENAI_API_KEY?.trim() || null;
}

export async function setOpenAIKey(key: string) {
  await setConfig(KEY_OPENAI, key);
}

export async function getAnthropicKey(): Promise<string | null> {
  const db = await getConfig(KEY_ANTHROPIC);
  if (db) return db;
  return process.env.ANTHROPIC_API_KEY?.trim() || null;
}

export async function setAnthropicKey(key: string) {
  await setConfig(KEY_ANTHROPIC, key);
}

export async function isPaidAIMode(): Promise<boolean> {
  if (process.env.SHARKAI_USE_PAID_AI === 'true') return true;
  const db = await getConfig(KEY_PAID_AI);
  return db === 'true';
}

export async function setPaidAIMode(enabled: boolean) {
  await setConfig(KEY_PAID_AI, enabled ? 'true' : 'false');
}

export async function hasConfiguredAI(): Promise<boolean> {
  const paid = await isPaidAIMode();
  if (!paid) return false;
  const openai = await getOpenAIKey();
  const anthropic = await getAnthropicKey();
  return !!(openai || anthropic || process.env.AI_GATEWAY_API_KEY);
}

export function maskKey(key: string | null): string | null {
  if (!key || key.length < 12) return null;
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

export async function getAISettings() {
  const openaiKey = await getOpenAIKey();
  const anthropicKey = await getAnthropicKey();
  const paidAIEnabled = await isPaidAIMode();
  const configured = await hasConfiguredAI();

  return {
    paidAIEnabled,
    aiConfigured: configured,
    openai: { hasKey: !!openaiKey, preview: maskKey(openaiKey) },
    anthropic: { hasKey: !!anthropicKey, preview: maskKey(anthropicKey) },
    localMode: !paidAIEnabled,
  };
}
