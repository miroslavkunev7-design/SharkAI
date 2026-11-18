import { z } from 'zod';
import { parseDocumentTranslationRequest } from './chat-document-translation.server';
import { ChatError } from './chat-history';
import { getResearch, researchCitations } from './research';

const receiptSchema = z.object({ toolId: z.literal('deep-research'), researchId: z.string().uuid() });
const source = String.raw`(?:(?:(?:предишния|последния) (?:изследователски )?(?:доклад|отчет)(?: от проучването)?|(?:доклада|отчета) от проучването)|(?:the )?(?:(?:previous|last|latest) (?:research )?report|research report))`;
const fileFormat = String.raw`(markdown|md|txt|pdf|docx|word)`;
const exportReport = new RegExp(String.raw`^(?:запази|запиши|експортирай|save|export) ${source} (?:като|в|във|as|to|in) ${fileFormat}[.!]?$`, 'iu');
const createFromReport = new RegExp(String.raw`^(?:създай|направи|create|make|write) ${fileFormat} (?:от|from) ${source}[.!]?$`, 'iu');
const translateReport = new RegExp(String.raw`^((?:преведи|translate) )${source}(?=\s)`, 'iu');
const analyzeReport = new RegExp(String.raw`^(?:анализирай|обобщи|резюмирай|analy[sz]e|summari[sz]e) ${source}(?=\s|[:.,!?]|$)`, 'iu');
const numberedSource = new RegExp(String.raw`^(?:покажи източник|show source) (?:#|№)?(\d+) (?:от|from) ${source}[.!?]?$`, 'iu');
const crossrefSource = new RegExp(String.raw`^(?:покажи първия DOI от|show (?:the )?first (?:Crossref )?DOI from) ${source}[.!?]?$`, 'iu');
const numberedQuestion = /^\s*[:,-]?\s*(?:(?:which|what) (?:publication|paper|source) (?:appears as|is(?: listed as)?) (?:citation|source|reference)|коя публикация е (?:източник|цитат)) (?:\[(\d+)\]|(?:#|№)?(\d+))(?=\s|[?.!,]|$)/iu;
const compoundAnalysis = /\[\d+\]|(?:citation|source|reference|източник|цитат)\s+(?:#|№)?\d+|(?<!\p{L})(?:compare|contrast|explain|summari[sz]e|translate|discuss|сравни|обясни|обобщи|преведи)(?!\p{L})/iu;
const previousAnswer = /(?:предишния(?:т)?|последния(?:т)?) (?:ти )?отговор|(?:previous|last) (?:answer|response)/iu;
const explicitBody = /(?:с(?:ъс)? съдържание|със следния текст|с текст|with (?:the following )?(?:content|text)|content)\s*:/iu;

type ResearchMessage = { role: string; toolResult?: unknown };
type ResearchAction =
  | { kind: 'tool'; id: 'text-file-create' | 'document-export' | 'document-translate'; prompt: string }
  | { kind: 'citation'; number?: number }
  | { kind: 'analysis' };

export function parseResearchFollowUp(prompt: string, selectedTool?: string): ResearchAction | null {
  const request = prompt.trim().replace(/^(?:please|моля)[,\s]+/iu, '').replace(/\s+/gu, ' ');
  const match = exportReport.exec(request) ?? createFromReport.exec(request);
  if (match) {
    const requested = match[1].toLowerCase();
    const format = requested === 'markdown' ? 'md' : requested === 'word' ? 'docx' : requested;
    const plain = format === 'md' || format === 'txt';
    const id = plain ? 'text-file-create' : 'document-export';
    if (selectedTool && selectedTool !== id) return null;
    const textFormat = format === 'md' ? 'Markdown' : 'TXT';
    return {
      kind: 'tool', id, prompt: plain ? `Запази ${textFormat} SharkAI-Research.${format} с предишния отговор`
        : `Създай ${format.toUpperCase()} от предишния отговор`,
    };
  }
  if ((!selectedTool || selectedTool === 'document-translate') && translateReport.test(request)) {
    const normalized = request.replace(translateReport, '$1previous answer');
    if (parseDocumentTranslationRequest(normalized)?.source === 'previous-answer') {
      return { kind: 'tool', id: 'document-translate', prompt: normalized };
    }
  }
  if (selectedTool) return null;
  const citation = numberedSource.exec(request);
  if (citation) return { kind: 'citation', number: Number(citation[1]) };
  if (crossrefSource.test(request)) return { kind: 'citation' };
  const analysis = analyzeReport.exec(request);
  if (!analysis) return null;
  const question = request.slice(analysis[0].length);
  const number = numberedQuestion.exec(question);
  if (number && !compoundAnalysis.test(question.slice(number[0].length))) {
    return { kind: 'citation', number: Number(number[1] ?? number[2]) };
  }
  return { kind: 'analysis' };
}

export function reportReceiptId(message?: ResearchMessage) {
  if (message?.role !== 'assistant') return;
  const receipt = receiptSchema.safeParse(message.toolResult);
  return receipt.success ? receipt.data.researchId : undefined;
}

export function previousAnswerExport(prompt: string, toolId?: string) {
  return (toolId === 'text-file-create' || toolId === 'document-export')
    && !explicitBody.test(prompt) && previousAnswer.test(prompt);
}

export async function requireConversationReport(userId: string, receiptId?: string) {
  if (!receiptId) throw new ChatError('В този разговор няма достъпен доклад от проучване.', 400);
  const report = await getResearch(receiptId, userId);
  if (!report) throw new ChatError('Докладът от проучване не е намерен.', 404);
  if (report.status === 'QUEUED' || report.status === 'RUNNING') {
    throw new ChatError('Докладът още се подготвя. Изчакай проучването да завърши.', 409);
  }
  if (report.status !== 'COMPLETED' || !report.report) {
    throw new ChatError('Докладът не е готов. Повтори проучването от разговора.', 409);
  }
  return { text: report.report, ...researchCitations(report) };
}

export function selectResearchCitation(report: ReturnType<typeof researchCitations>, number?: number) {
  const index = number === undefined
    ? report.sources.findIndex(({ url }) => url === report.firstCrossrefDoi)
    : number - 1;
  const citation = report.sources[index];
  if (!citation) throw new ChatError(number === undefined
    ? 'Докладът не съдържа публикация от Crossref.' : 'В доклада няма източник с този номер.', 404);
  return { ...citation, number: index + 1 };
}
