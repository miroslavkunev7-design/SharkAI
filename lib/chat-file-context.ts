type HistoryEntry = {
  role: string;
  imagePath?: string | null;
  attachmentMime?: string | null;
  toolResult?: unknown;
};

export interface ChatFile {
  id: string;
  mime?: string;
}

const ownedUploadPath = /^\/api\/upload\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})(?:\?[^#\\]*)?$/iu;
const uploadId = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;
const fileMime: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  excel: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  markdown: 'text/markdown',
  md: 'text/markdown',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

function attachedFile(entry: HistoryEntry): ChatFile | null {
  if (entry.role === 'user' && entry.imagePath && uploadId.test(entry.imagePath)) {
    return { id: entry.imagePath, mime: entry.attachmentMime ?? undefined };
  }
  if (entry.role !== 'assistant' || !entry.toolResult || typeof entry.toolResult !== 'object') return null;
  const { artifact, status } = entry.toolResult as { artifact?: { url?: unknown; mimeType?: unknown }; status?: unknown };
  if (status !== 'completed' || typeof artifact?.url !== 'string' || typeof artifact.mimeType !== 'string') return null;
  const id = ownedUploadPath.exec(artifact.url)?.[1];
  return id ? { id, mime: artifact.mimeType } : null;
}

// Continue only through server-owned messages from the selected conversation or fork prefix.
export function rememberedChatFiles(messages: HistoryEntry[]) {
  const files = new Map<string, ChatFile>();
  for (let index = messages.length - 1; index >= 0; index--) {
    const file = attachedFile(messages[index]);
    if (file && (!files.has(file.id) || (!files.get(file.id)?.mime && file.mime))) files.set(file.id, file);
  }
  return [...files.values()];
}

function openingInstruction(prompt: string) {
  return prompt.slice(0, 180).split(/[:\r\n]|\s+(?:and\s+(?:save|export|write)|then\s+(?:save|export|write)|и\s+(?:запази|запиши|експортирай)|като|as)\s+/iu, 1)[0];
}

export function chatFileReference(prompt: string) {
  // Later clauses can name a new output format. Ignore quoted replacement text.
  const source = openingInstruction(prompt).replace(/["„“][^"”\r\n]*["”]/gu, ' ');
  const format = /\b(pdf|docx|xlsx|excel|csv|txt|markdown|md|json|png|jpe?g|webp)\b/iu.exec(source)?.[1].toLowerCase();
  if (format && Object.hasOwn(fileMime, format)) {
    const mime = fileMime[format];
    return { matches: (candidate: string) => candidate === mime };
  }
  if (/\b(?:image|photo|picture)\b|(?<!\p{L})(?:изображени(?:е|ето)|снимка(?:та)?|картинка(?:та)?)(?!\p{L})/iu.test(source)) {
    return { matches: (candidate: string) => candidate.startsWith('image/') };
  }
  if (/\b(?:spreadsheet|table|workbook)\b|(?<!\p{L})таблица(?:та)?(?!\p{L})/iu.test(source)) {
    return { matches: (candidate: string) => candidate === fileMime.csv || candidate === fileMime.xlsx };
  }
  if (/\bdocument\b|(?<!\p{L})документ(?:а|ът)?(?!\p{L})/iu.test(source)) {
    return { matches: (candidate: string) => candidate === fileMime.pdf || candidate === fileMime.docx };
  }
  return null;
}

export function specifiesParticularChatFile(prompt: string) {
  const source = openingInstruction(prompt);
  return /[\p{L}\p{N}_-]\.(?:pdf|docx|xlsx|csv|txt|md|json|png|jpe?g|webp)\b/iu.test(source)
    || /\b(?:first|second|third|oldest|earliest)\s+(?:file|image|photo|document|pdf|docx|xlsx|csv|spreadsheet)\b|(?:първ(?:ия|ията|ата|ото)|втор(?:ия|ата|ото)|най-стар(?:ия|ата|ото))\s+(?:файл|изображение|снимка|документ|pdf|docx|xlsx|csv|таблица)/iu.test(source);
}

export function isFileFollowUp(prompt: string) {
  const request = prompt.trim().replace(/^(?:моля|please)[,\s]+/iu, '')
    .replace(/^(?:можеш ли да|can you|could you)\s+/iu, '');
  return /^(?:редактирай|редактираш|поправи|поправиш|промени|анализирай|прочети|разчети|извлечи|преведи|обобщи|опиши|замени|добави|inspect|analy[sz]e|edit|revise|read|extract|describe|translate|summari[sz]e|replace|append)\s/iu.test(request);
}
