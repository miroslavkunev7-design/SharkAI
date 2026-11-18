import { stepCountIs, streamText, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import { isLocalDocumentEdit } from '../chat-documents.server';
import { parseLocalImageEdit } from '../chat-image-edits.server';
import { supportsLocalTableAnalysis } from '../chat-tables.server';
import type { ChatTool } from '../chat-tools';

type Selection = { toolId: string; prompt: string; needsFile: boolean };
type Validation = (input: unknown) => Selection | null;
type Router = { tools: ToolSet; validate: (name: string, input: unknown) => Selection | null };

export class NativeToolSelectionError extends Error {
  readonly status = 422;
}

const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const pdf = 'application/pdf';
const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const images = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

export function createNativeToolRouter(registry: ChatTool[], mimeType?: string, allowExport = true): Router | undefined {
  const available = new Set(registry.filter((entry) => entry.available).map((entry) => entry.id));
  const tools: ToolSet = {};
  const validators = new Map<string, Validation>();

  function offer<Schema extends z.ZodTypeAny>(
    name: string, toolId: string, needsFile: boolean, description: string, schema: Schema,
    promptFor: (value: z.output<Schema>) => string | null,
  ) {
    if (!available.has(toolId)) return;
    tools[name] = tool({ description, inputSchema: schema });
    validators.set(name, (input) => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return null;
      const prompt = promptFor(parsed.data);
      return prompt ? { toolId, prompt, needsFile } : null;
    });
  }

  const noArgs = z.object({}).strict();
  const command = z.object({ command: z.string().trim().min(1).max(12_000) }).strict();
  const draft = z.string().min(1).max(20_000).refine((value) => !!value.trim()).describe('Complete requested file content as plain text.');
  if (allowExport) {
    offer('export_document', 'document-export', false,
      'Create a new private document only when the latest user explicitly asks for a downloadable PDF or Word document. Include the complete content in the requested language.',
      z.object({ format: z.enum(['pdf', 'docx']), content: draft }).strict(),
      ({ format, content }) => `Създай ${format.toUpperCase()} със съдържание:\n${content}`);
    offer('export_text', 'text-file-create', false,
      'Create a new private downloadable TXT, Markdown or JSON file when explicitly requested. An ordinary reply does not need a file.',
      z.object({ format: z.enum(['txt', 'md', 'json']), content: draft }).strict(),
      ({ format, content }) => `Създай ${format} със съдържание:\n${content}`);
  }

  if (mimeType && images.has(mimeType)) {
    offer('inspect_image', 'image-properties', true,
      'Measure the available image dimensions or sample its color palette. This tool does not identify objects or read text.',
      noArgs, () => 'Свойства на изображение');
    offer('transform_image', 'image-transform', true,
      'Apply one requested transformation to the available image. Use one exact command: resize to 300 × 200, resize width 300, crop 200 × 200, rotate by 90, grayscale, or flip horizontally. Use the user’s numbers.',
      command, ({ command }) => parseLocalImageEdit(command) ? command : null);
  }
  if (mimeType === docx) {
    offer('extract_docx', 'document-read', true,
      'Extract the raw text of the available Word document as-is, only when requested. This does not summarize or translate.',
      noArgs, () => 'Извлечи текста от DOCX');
  }
  if (mimeType === docx || mimeType === pdf) {
    offer('edit_document', 'document-edit', true,
      `Create an edited copy of the available ${mimeType === pdf ? 'PDF. Commands: rotate page 2 by 90; remove page 2; append:\n<exact text>' : 'Word document. Commands: replace "old text" with "new text"; append:\n<exact text>'}. Use only values supplied by the user.`,
      command, ({ command }) => isLocalDocumentEdit(command, mimeType) ? command : null);
  }
  if (mimeType === 'text/csv' || mimeType === xlsx) {
    offer('analyze_table', 'dataset-analysis', true,
      'Run a bounded local analysis of the available table when requested. Commands: summary; summary; column: "Exact header"; chart; column: "Exact header". Optional sheet: "Exact sheet" is XLSX only. Supports count, sum, average, minimum, maximum, missing cells and a chart of column values.',
      command, ({ command }) => supportsLocalTableAnalysis(command) ? command : null);
  }

  return validators.size ? { tools, validate: (name, input) => validators.get(name)?.(input) ?? null } : undefined;
}

type ProviderOptions = Parameters<typeof streamText>[0]['providerOptions'];

export async function streamWorkspaceReply({ model, system, messages, signal, maxOutputTokens, providerOptions, router, onDelta }: {
  model: LanguageModel;
  system: string;
  messages: ModelMessage[];
  signal: AbortSignal;
  maxOutputTokens: number;
  providerOptions?: ProviderOptions;
  router?: Router;
  onDelta?: (text: string) => void;
}) {
  const stream = streamText({
    model,
    system,
    messages,
    abortSignal: signal,
    maxRetries: 0,
    // The request converts provider errors without logging prompt or model arguments.
    onError: () => {},
    maxOutputTokens,
    providerOptions,
    ...(router ? { tools: router.tools, toolChoice: 'auto' as const, stopWhen: stepCountIs(1) } : {}),
  });

  let text = '';
  let selection: Selection | null = null;
  for await (const part of stream.fullStream) {
    if (part.type === 'error') throw part.error;
    if (part.type === 'abort') signal.throwIfAborted();
    if (part.type === 'text-delta') {
      text += part.text;
      if (!router) onDelta?.(part.text);
    }
    if (part.type === 'tool-call') {
      if (selection || !router || part.providerExecuted || ('invalid' in part && part.invalid)) {
        throw new NativeToolSelectionError('Моделът не избра една валидна операция. Избери инструмент от менюто „+“.');
      }
      selection = router.validate(part.toolName, part.input);
      if (!selection) throw new NativeToolSelectionError('Моделът предложи неподдържана операция. Избери инструмент от менюто „+“.');
    }
  }
  signal.throwIfAborted();
  if (router && !selection && await stream.finishReason === 'tool-calls') {
    throw new NativeToolSelectionError('Моделът върна непълен избор на инструмент. Избери инструмент от менюто „+“.');
  }
  const usage = await stream.totalUsage;
  if (router && !selection && text) onDelta?.(text);
  return { text: selection ? '' : text, selection, tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) };
}
