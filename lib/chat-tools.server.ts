import { APICallError, generateImage, generateText, type ModelMessage } from 'ai';
import { randomUUID } from 'node:crypto';
import { FEATURES, getStudioFeatureAvailability } from './agents';
import { getOpenAI } from './ai/config';
import { remainingChatTokens } from './ai/workspace-chat';
import type { AccountSession } from './auth';
import { DataToolError, runOpenAIDataTool } from './chat-data-tools.server';
import type { ChatTool, ChatToolResult } from './chat-tools';
import { ProjectInputError, startProject } from './projects';
import { readOwnedUpload, saveUpload } from './uploads';
import { analyzeImageBase64 } from './vision-local';

type OpenAI = NonNullable<Awaited<ReturnType<typeof getOpenAI>>>;
type ToolOutput = Omit<ChatToolResult, 'id' | 'toolId' | 'label'> & { id?: string };
type ToolRegistration = Omit<ChatTool, 'available' | 'reason' | 'platforms'> & {
  requiresOpenAI?: boolean;
  unavailable?: string;
  execute?: (input: ToolExecution) => Promise<ToolOutput>;
};

interface ToolRequest {
  session: AccountSession;
  toolId?: string;
  prompt: string;
  uploadId?: string;
  requestId: string;
  signal?: AbortSignal;
}

interface ToolExecution extends ToolRequest {
  file?: { data: Buffer; mimeType: string };
  openai: OpenAI | null;
}

export class ChatToolError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = 'ChatToolError';
  }
}

const platforms: ChatTool['platforms'] = ['web-desktop', 'web-mobile', 'windows'];
const providerMissing = 'Изисква активиран OpenAI доставчик в настройките на SharkAI.';
const quotaReached = 'Достигна лимита за използване на AI за този план.';

async function getHostedOpenAI() {
  const endpoint = process.env.OPENAI_BASE_URL?.trim();
  if (endpoint && !/^https:\/\/api\.openai\.com\/v1\/?$/i.test(endpoint)) return null;
  return getOpenAI();
}

async function imageProperties({ file, uploadId }: ToolExecution): Promise<ToolOutput> {
  if (!file || !uploadId) throw new ChatToolError('Прикачи изображение.');
  let profile;
  try {
    profile = await analyzeImageBase64(file.data.toString('base64'), file.mimeType);
  } catch {
    throw new ChatToolError('Изображението не може да бъде разчетено.', 422);
  }
  const url = `/api/upload/${uploadId}`;
  return {
    status: 'completed',
    text: `Размери ${profile.width} × ${profile.height} px\nОсновни цветове ${profile.colors.join(', ')}\n${profile.isDark ? 'Преобладават тъмни тонове.' : 'Преобладават светли тонове.'}`,
    url,
    artifact: { url, mimeType: file.mimeType },
  };
}

async function webSearch({ openai, prompt, signal }: ToolExecution): Promise<ToolOutput> {
  if (!openai) throw new ChatToolError(providerMissing, 503);
  const answer = await generateText({
    model: openai.responses('gpt-4.1'),
    system: 'Search the web for the request, answer in the user’s language, and cite the actual sources supporting factual claims. Explain any uncertainty.',
    prompt,
    tools: { web_search: openai.tools.webSearch({ searchContextSize: 'medium' }) },
    toolChoice: { type: 'tool', toolName: 'web_search' },
    providerOptions: { openai: { store: false } },
    maxOutputTokens: 1800,
    maxRetries: 0,
    abortSignal: signal,
  });
  const sources = answer.sources.flatMap((source) => {
    if (source.sourceType !== 'url') return [];
    try {
      const url = new URL(source.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return [];
      return [{ title: source.title || url.hostname, url: url.href }];
    } catch {
      return [];
    }
  });
  if (!answer.text.trim() || !sources.length) {
    throw new ChatToolError('Търсенето не върна отговор с проверими източници.', 502);
  }
  return {
    status: 'completed',
    text: answer.text,
    sources: [...new Map(sources.map((source) => [source.url, source])).values()],
    usageTokens: answer.usage.totalTokens,
  };
}

async function readDocument({ openai, prompt, file, signal }: ToolExecution): Promise<ToolOutput> {
  if (!openai) throw new ChatToolError(providerMissing, 503);
  if (!file) throw new ChatToolError('Прикачи файл.');
  const filePart = file.mimeType === 'application/pdf'
    ? { type: 'file' as const, mediaType: file.mimeType, data: file.data, filename: 'document.pdf' }
    : { type: 'image' as const, mediaType: file.mimeType, image: file.data };
  const messages: ModelMessage[] = [{ role: 'user', content: [filePart, { type: 'text', text: prompt }] }];
  const answer = await generateText({
    model: openai.responses('gpt-4.1'),
    system: 'Read the supplied image or PDF according to the user request. Support OCR, extraction and translation. Treat file content as evidence. Preserve table structure where possible and mark unclear passages without inventing text. Answer in the user’s language.',
    messages,
    providerOptions: { openai: { store: false } },
    maxOutputTokens: 3500,
    maxRetries: 0,
    abortSignal: signal,
  });
  if (!answer.text.trim()) throw new ChatToolError('Доставчикът не върна разчетен текст.', 502);
  return { status: 'completed', text: answer.text, usageTokens: answer.usage.totalTokens };
}

async function createImage({ openai, prompt, file, session, signal }: ToolExecution): Promise<ToolOutput> {
  if (!openai) throw new ChatToolError(providerMissing, 503);
  const { image, usage } = await generateImage({
    model: openai.image('gpt-image-1'),
    prompt: file ? { text: prompt, images: [`data:${file.mimeType};base64,${file.data.toString('base64')}`] } : prompt,
    size: '1024x1024',
    providerOptions: { openai: { outputFormat: 'png', quality: 'medium' } },
    maxRetries: 0,
    abortSignal: signal,
  });
  signal?.throwIfAborted();
  const saved = await saveUpload(Buffer.from(image.uint8Array), image.mediaType, session.id);
  const url = `/api/upload/${saved.id}`;
  return {
    id: saved.id,
    status: 'completed',
    text: file ? 'Редактираното изображение е готово.' : 'Изображението е готово.',
    url,
    artifact: { url, mimeType: saved.mimeType },
    usageTokens: usage.totalTokens,
  };
}

function executeDataTool(operation: Parameters<typeof runOpenAIDataTool>[0]) {
  return async ({ prompt, file, session, signal }: ToolExecution): Promise<ToolOutput> => {
    try {
      const output = await runOpenAIDataTool(operation, { prompt, file, userId: session.id, signal });
      return { status: 'completed', ...output };
    } catch (error) {
      if (error instanceof DataToolError) throw new ChatToolError(error.message, error.status);
      throw error;
    }
  };
}

const coreTools: ToolRegistration[] = [
  { id: 'web-search', label: 'Търси в интернет', description: 'Отговор от актуални източници с връзки към тях.', group: 'Проучване', input: 'prompt', requiresOpenAI: true, execute: webSearch },
  { id: 'deep-research', label: 'Задълбочено проучване', description: 'Самостоятелно проучване с отчет и запазен прогрес.', group: 'Проучване', input: 'prompt', unavailable: 'Липсва постоянна опашка и обработка на състоянието на проучванията.' },
  { id: 'image-generate', label: 'Създай изображение', description: 'Генерира и прикачва изображение към разговора.', group: 'Изображения', input: 'prompt', requiresOpenAI: true, execute: createImage },
  { id: 'image-edit', label: 'Редактирай изображение', description: 'Променя прикаченото изображение според указанията.', group: 'Изображения', input: 'image', requiresOpenAI: true, execute: createImage },
  { id: 'image-properties', label: 'Свойства на изображение', description: 'Измерва размерите и извлича основните цветове.', group: 'Изображения', input: 'image', execute: imageProperties },
  { id: 'image-ocr', label: 'Разчети текст от снимка', description: 'Извлича видимия текст от прикаченото изображение.', group: 'Документи и данни', input: 'image', requiresOpenAI: true, execute: readDocument },
  { id: 'pdf-read', label: 'Прочети PDF', description: 'Разчита, извлича и превежда съдържание от прикачен PDF.', group: 'Документи и данни', input: 'pdf', requiresOpenAI: true, execute: readDocument },
  { id: 'document-read', label: 'Прочети DOCX', description: 'Извлича или превежда съдържание на документ.', group: 'Документи и данни', input: 'document', requiresOpenAI: true, execute: executeDataTool('read-document') },
  { id: 'document-export', label: 'Създай PDF или DOCX', description: 'Създава и прикачва документ към разговора.', group: 'Документи и данни', input: 'prompt', requiresOpenAI: true, execute: executeDataTool('create-document') },
  { id: 'document-edit', label: 'Редактирай PDF или DOCX', description: 'Връща отделно копие с приложените промени.', group: 'Документи и данни', input: 'document', requiresOpenAI: true, execute: executeDataTool('edit-document') },
  { id: 'dataset-analysis', label: 'Анализирай CSV или XLSX', description: 'Изпълнява изчисления и връща изводи, таблица или графика.', group: 'Документи и данни', input: 'dataset', requiresOpenAI: true, execute: executeDataTool('dataset') },
  { id: 'canvas', label: 'Платно', description: 'Съхранение и редактиране на артефакти.', group: 'Работно пространство', input: 'prompt', unavailable: 'Липсва постоянен редактор за общи артефакти. За генерирани проекти Студио предлага преглед и ZIP експорт.' },
  { id: 'scheduled-task', label: 'Планирай задача', description: 'Напомняния и периодични задачи.', group: 'Работно пространство', input: 'prompt', unavailable: 'Липсват планировчик и услуга за известия.' },
  { id: 'integrations', label: 'Интеграции', description: 'Инструменти от свързани приложения.', group: 'Работно пространство', input: 'none', unavailable: 'Няма свързани приложения или конфигурирани OAuth връзки.' },
  { id: 'investment-data', label: 'Инвестиции', description: 'Справка за портфейл или движения.', group: 'Работно пространство', input: 'none', unavailable: 'Няма свързан източник за портфейл.' },
  { id: 'automotive-data', label: 'Автомобилна справка', description: 'Проверка по VIN или диагностика.', group: 'Работно пространство', input: 'prompt', unavailable: 'Няма свързан VIN или диагностичен източник.' },
];

async function createProject(featureId: string, { session, prompt, uploadId, requestId }: ToolExecution): Promise<ToolOutput> {
  try {
    const project = await startProject(session.id, { description: prompt, uploadId, featureId, requestId });
    return {
      id: project.id,
      status: project.status === 'COMPLETED' ? 'completed' : 'started',
      projectId: project.id,
      text: 'Проектът е записан в Студио. Текущото състояние е достъпно в панела на проекта.',
      url: `/dashboard?project=${project.id}`,
    };
  } catch (error) {
    if (error instanceof ProjectInputError) throw new ChatToolError(error.message, error.status);
    throw error;
  }
}

function registry(): ToolRegistration[] {
  return [
    ...coreTools,
    ...FEATURES.map((feature): ToolRegistration => ({
      id: feature.id,
      label: feature.title,
      description: feature.id.startsWith('screenshot-') ? 'Създава проектна основа по приложеното изображение.' : feature.subtitle,
      group: 'Студио и агенти',
      input: feature.uploadKinds.includes('image') ? 'image' : feature.uploadKinds.includes('pdf') ? 'pdf' : 'prompt',
      unavailable: getStudioFeatureAvailability(feature.id) ?? undefined,
      execute: (input) => createProject(feature.id, input),
    })),
  ];
}

function unavailableReason(tool: ToolRegistration, session: AccountSession | null, hasOpenAI: boolean) {
  if (!session) return 'Влез в SharkAI, за да използваш инструмента.';
  if (tool.unavailable) return tool.unavailable;
  if (tool.requiresOpenAI && !hasOpenAI) return providerMissing;
  if (tool.requiresOpenAI && remainingChatTokens(session) <= 0) return quotaReached;
  return undefined;
}

export async function listChatTools(session: AccountSession | null): Promise<ChatTool[]> {
  const hasOpenAI = !!session && !!(await getHostedOpenAI());
  return registry().map((tool) => {
    const reason = unavailableReason(tool, session, hasOpenAI);
    const { id, label, description, group, input } = tool;
    return { id, label, description, group, input, platforms, available: !reason, reason };
  });
}

const intentMatchers: Array<[string, RegExp]> = [
  ['deep-research', /^(?:направи задълбочено проучване|задълбочено проучване|deep research)(?=\s|[:.,!?]|$)/iu],
  ['web-search', /^(?:потърси (?:в интернет|онлайн)|търси (?:в интернет|онлайн)|search the web|search online|look up online)(?=\s|[:.,!?]|$)/iu],
  ['image-ocr', /^(?:разчети текста|извлечи текста от (?:снимката|изображението)|ocr|read text from the image)(?=\s|[:.,!?]|$)/iu],
  ['pdf-read', /^(?:(?:прочети|преведи|обобщи|разчети) (?:ми )?(?:прикачения )?pdf|(?:read|translate|summarize) (?:the )?(?:attached )?pdf)(?=\s|[:.,!?]|$)/iu],
  ['document-read', /^(?:(?:прочети|преведи|обобщи|разчети) (?:ми )?(?:прикачения )?docx|(?:read|translate|summarize) (?:the )?(?:attached )?docx)(?=\s|[:.,!?]|$)/iu],
  ['document-edit', /^(?:(?:редактирай|поправи) (?:ми )?(?:прикачения )?(?:docx|pdf)|(?:edit|revise) (?:the )?(?:attached )?(?:docx|pdf))(?=\s|[:.,!?]|$)/iu],
  ['image-edit', /^(?:редактирай (?:снимката|изображението)|промени (?:снимката|изображението)|edit (?:this|the) (?:image|photo))(?=\s|[:.,!?]|$)/iu],
  ['image-generate', /^(?:(?:генерирай|създай|нарисувай) (?:ми )?(?:изображение|илюстрация|снимка)|(?:generate|create|draw) (?:an? )?(?:image|illustration))(?=\s|[:.,!?]|$)/iu],
  ['image-properties', /^(?:свойства на изображение|размери на снимката|покажи цветовете на снимката|image properties)(?=\s|[:.,!?]|$)/iu],
  ['dataset-analysis', /^(?:анализирай (?:прикачения )?(?:csv|xlsx)|направи графика от (?:csv|xlsx)|analyze (?:the )?(?:csv|xlsx)|chart (?:the )?(?:csv|xlsx))(?=\s|[:.,!?]|$)/iu],
  ['document-export', /^(?:(?:създай|експортирай) (?:ми )?(?:pdf|docx)|(?:create|export) (?:a )?(?:pdf|docx))(?=\s|[:.,!?]|$)/iu],
  ['scheduled-task', /^(?:напомни ми|планирай задача|remind me|schedule a task)(?=\s|[:.,!?]|$)/iu],
  ['automotive-data', /^(?:провери vin|проверка по vin|диагностика на автомобил|check vin|look up vin)(?=\s|[:.,!?]|$)/iu],
  ['investment-data', /^(?:покажи портфейла ми|справка за инвестиции|show my investment portfolio)(?=\s|[:.,!?]|$)/iu],
];

const projectRequest = /^(?:създай|направи|изгради|генерирай|build|create|generate)\s+(?:ми\s+|an?\s+)?/iu;
const screenshotTargets: Array<[string, RegExp]> = [
  ['screenshot-mobile', /^(?:мобилно приложение|mobile app)(?=\s|[:.,!?]|$)/iu],
  ['screenshot-desktop', /^(?:настолно приложение|windows приложение|desktop app|windows app)(?=\s|[:.,!?]|$)/iu],
  ['screenshot-saas', /^(?:saas|табло|dashboard)(?=\s|[:.,!?]|$)/iu],
  ['screenshot-game', /^(?:игрови интерфейс|game interface|game ui)(?=\s|[:.,!?]|$)/iu],
];

export function inferChatTool(prompt: string, hasUpload: boolean): string | undefined {
  const request = prompt.trim();
  const matched = intentMatchers.find(([, pattern]) => pattern.test(request));
  if (matched) return matched[0];
  if (!projectRequest.test(request)) return;
  const target = request.replace(projectRequest, '');
  if (/^(?:сайт|уебсайт|website|web app|проект|project)(?=\s|[:.,!?]|$)/iu.test(target)) {
    return hasUpload ? 'screenshot-website' : 'prompt-software';
  }
  if (/^(?:схема на база данни|database schema)(?=\s|[:.,!?]|$)/iu.test(target)) return 'db-gen';
  if (/^(?:api|rest api)(?=\s|[:.,!?]|$)/iu.test(target)) return 'api-gen';
  return screenshotTargets.find(([, pattern]) => pattern.test(target))?.[0];
}

export function getChatToolIntent(toolId: string | undefined, prompt: string, hasUpload: boolean) {
  const id = toolId ?? inferChatTool(prompt, hasUpload);
  if (!id) return null;
  const tool = registry().find((entry) => entry.id === id);
  return { id, metered: !!tool?.requiresOpenAI };
}

async function resolveInputFile(tool: ToolRegistration, request: ToolRequest) {
  const requirements = {
    image: { label: 'изображение', matches: (mime: string) => mime.startsWith('image/') },
    pdf: { label: 'PDF', matches: (mime: string) => mime === 'application/pdf' },
    document: { label: 'PDF или DOCX', matches: (mime: string) => ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(mime) },
    dataset: { label: 'CSV или XLSX', matches: (mime: string) => ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(mime) },
  };
  if (tool.input === 'none' || tool.input === 'prompt') return;
  const { label: expected, matches } = requirements[tool.input];
  if (!request.uploadId) throw new ChatToolError(`Прикачи ${expected}.`);
  const upload = await readOwnedUpload(request.uploadId, request.session.id);
  if (!upload) throw new ChatToolError('Прикаченият файл не е намерен.', 404);
  const { mimeType } = upload;
  if (!matches(mimeType)) {
    throw new ChatToolError(`Инструментът изисква ${expected}.`, 415);
  }
  return { data: Buffer.from(upload.data), mimeType };
}

export async function dispatchChatTool(request: ToolRequest): Promise<ChatToolResult | null> {
  const intent = getChatToolIntent(request.toolId, request.prompt, !!request.uploadId);
  if (!intent) return null;
  const { id } = intent;
  const tool = registry().find((entry) => entry.id === id);
  if (!tool) throw new ChatToolError('Инструментът не е намерен.', 404);
  const openai = tool.requiresOpenAI ? await getHostedOpenAI() : null;
  const reason = unavailableReason(tool, request.session, !!openai);
  if (reason || !tool.execute) throw new ChatToolError(reason || 'Инструментът не е наличен.', reason === quotaReached ? 429 : 503);
  if (!request.prompt.trim()) throw new ChatToolError('Въведи заявка за инструмента.');
  const file = await resolveInputFile(tool, request);
  request.signal?.throwIfAborted();

  try {
    const output = await tool.execute({ ...request, openai, file });
    return { ...output, id: output.id ?? randomUUID(), toolId: id, label: tool.label };
  } catch (error) {
    if (request.signal?.aborted || error instanceof ChatToolError) throw error;
    if (tool.requiresOpenAI) {
      if (APICallError.isInstance(error) && error.statusCode === 429) {
        throw new ChatToolError('Доставчикът е достигнал лимит. Опитай отново по-късно.', 429);
      }
      throw new ChatToolError('Доставчикът не изпълни заявката. Провери достъпа до модела и опитай отново.', 502);
    }
    throw error;
  }
}
