import { generateText } from 'ai';
import { z } from 'zod';
import { getOpenAI } from './ai/config';

export type HostedOpenAI = NonNullable<Awaited<ReturnType<typeof getOpenAI>>>;

export interface HostedWebSource {
  title: string;
  url: string;
}

export interface HostedWebSearchResult {
  text: string;
  sources: HostedWebSource[];
  citations: Array<{ end: number; url: string }>;
  usageTokens: number;
  partial?: boolean;
}

export class HostedWebSearchError extends Error {
  readonly status = 502;
  constructor(message: string, readonly usageTokens = 0) { super(message); }
}

export async function getHostedOpenAI() {
  const endpoint = process.env.OPENAI_BASE_URL?.trim();
  if (endpoint && !/^https:\/\/api\.openai\.com\/v1\/?$/i.test(endpoint)) return null;
  return getOpenAI();
}

const urlCitation = z.object({
  type: z.literal('url_citation'), start_index: z.number().int().nonnegative(),
  end_index: z.number().int().positive(), url: z.string(),
});

function safeSource(url: string) {
  try {
    const parsed = new URL(url);
    if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return parsed.href;
  } catch { /* Malformed provider citation. */ }
  return null;
}

export async function runHostedWebSearch(openai: HostedOpenAI, prompt: string, options: {
  signal?: AbortSignal;
  depth?: 'quick' | 'research';
  maxOutputTokens?: number;
} = {}): Promise<HostedWebSearchResult> {
  const system = options.depth === 'research'
    ? 'Research the topic on the public web using several relevant searches where useful. Compare the independently sourced evidence, specify dates or limitations when relevant, and cite each factual finding using actual source annotations. Prioritize original and authoritative evidence. Reply in the topic language and avoid raw URL text.'
    : 'Search the web for the request, answer in the user’s language, and cite the actual sources supporting factual claims. Explain any uncertainty.';
  const answer = await generateText({
    model: openai.responses('gpt-4.1'), system, prompt,
    tools: { web_search: openai.tools.webSearch({ searchContextSize: 'medium' }) },
    toolChoice: { type: 'tool', toolName: 'web_search' },
    providerOptions: { openai: { store: false } },
    maxOutputTokens: options.maxOutputTokens ?? 1800,
    maxRetries: 0,
    abortSignal: options.signal,
  });
  const used = answer.totalUsage.totalTokens ?? (answer.totalUsage.inputTokens ?? 0) + (answer.totalUsage.outputTokens ?? 0);
  const usageTokens = Number.isSafeInteger(used) && used > 0 ? used : 0;
  const sources = new Map<string, HostedWebSource>();
  for (const source of answer.sources) {
    if (source.sourceType !== 'url') continue;
    const url = safeSource(source.url);
    if (!url || sources.has(url)) continue;
    const title = source.title?.trim().replace(/\s+/g, ' ').slice(0, 250) || new URL(url).hostname;
    sources.set(url, { title, url });
  }
  if (!answer.text.trim() || !sources.size) {
    throw new HostedWebSearchError('Търсенето не върна отговор с проверими връзки.', usageTokens);
  }
  const citations: HostedWebSearchResult['citations'] = [];
  let offset = 0;
  for (const part of answer.content) {
    if (part.type !== 'text') continue;
    const annotations = part.providerMetadata?.openai?.annotations;
    if (Array.isArray(annotations)) {
      const characters = Array.from(part.text);
      for (const annotation of annotations) {
        const checked = urlCitation.safeParse(annotation);
        if (!checked.success) continue;
        const { start_index, end_index, url: href } = checked.data;
        const url = safeSource(href);
        if (!url || !sources.has(url) || start_index >= end_index || end_index > characters.length) continue;
        citations.push({ end: offset + characters.slice(0, end_index).join('').length, url });
      }
    }
    offset += part.text.length;
  }
  const partial = answer.finishReason === 'length' || answer.finishReason === 'content-filter';
  return { text: answer.text, citations, sources: [...sources.values()], usageTokens, partial };
}
