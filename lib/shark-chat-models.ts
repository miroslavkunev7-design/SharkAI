import { z } from 'zod';

const modelIds = [
  'auto',
  'gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra',
  'gpt-6.1-sol', 'gpt-6.1-terra',
  'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra',
  'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano',
  'gpt-5.3-codex', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano',
  'gpt-4.1', 'gpt-4o', 'gpt-4o-mini',
] as const;

export type SharkChatModel = typeof modelIds[number];

// Older clients sent standard or advanced while n8n chose the model automatically.
export const sharkChatModelSchema = z.enum([...modelIds, 'standard', 'advanced'])
  .default('auto').transform((id): SharkChatModel => id === 'standard' || id === 'advanced' ? 'auto' : id);

export const sharkChatModels = modelIds.map((id) => ({
  id,
  label: id === 'auto' ? 'Автоматично' : id.replace('gpt-', 'GPT-').replace(/-([a-z])([a-z]+)$/, (_, first: string, rest: string) => ' ' + first.toUpperCase() + rest),
  reasoningLevels: [],
}));

export function sharkModelPrefix(model: SharkChatModel = 'auto') {
  return model === 'auto' ? '' : `Модел: ${model}\n`;
}
