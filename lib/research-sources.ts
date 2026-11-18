import { z } from 'zod';

const contact = 'SharkAI/1.0 (+https://github.com/miroslavkunev7-design/SharkAI)';
type WikiLanguage = 'bg' | 'en';

export interface ResearchSource {
  title: string;
  url: string;
  excerpt: string;
}

export interface WikiHit extends ResearchSource {
  pageId: number;
  language: WikiLanguage;
}

export interface ScholarlyHit extends ResearchSource {
  publisher: string;
  year?: number;
  publicationDate?: string;
  doi: string;
}

const wikiSearch = z.object({ query: z.object({ search: z.array(z.object({
  title: z.string(), pageid: z.number().int().positive(), snippet: z.string(),
})) }) });
const wikiArticles = z.object({ query: z.object({ pages: z.array(z.object({
  pageid: z.number().int().positive(), extract: z.string().optional(),
})) }) });
const crossrefResults = z.object({ message: z.object({ items: z.array(z.object({
  title: z.array(z.string()).optional(),
  DOI: z.string().optional(),
  publisher: z.string().optional(),
  abstract: z.string().optional(),
  published: z.object({ 'date-parts': z.array(z.array(z.number())) }).optional(),
})) }) });

const entities: Record<string, string> = { amp: '&', quot: '"', apos: "'", nbsp: ' ', lt: '<', gt: '>' };

function plainText(value: string, size: number) {
  const decode = (text: string) => text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (full, token: string) => {
      if (!token.startsWith('#')) return entities[token] ?? full;
      const code = token[1]?.toLowerCase() === 'x' ? Number.parseInt(token.slice(2), 16) : Number(token.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    });
  return decode(decode(value)).replace(/<\/?[a-z][\w:-]*(?:\s[^>]*)?>/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, size);
}

async function sourceRequest(url: URL, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(8_000);
  const response = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { Accept: 'application/json', 'User-Agent': contact },
    cache: 'no-store', redirect: 'error',
  });
  if (!response.ok) throw new Error(`Source HTTP ${response.status}`);
  return response.json();
}

function wikiUrl(language: WikiLanguage, params: Record<string, string>) {
  const url = new URL(language === 'bg' ? 'https://bg.wikipedia.org/w/api.php' : 'https://en.wikipedia.org/w/api.php');
  url.search = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', ...params }).toString();
  return url;
}

export function researchTopic(text: string) {
  const request = text.trim().replace(/^(?:моля|please)[,\s]+/iu, '');
  return request.replace(/^(?:(?:направи\s+)?задълбочено\s+проучване(?:\s+(?:за|на))?|(?:по)?търси\s+в\s+интернет(?:\s+за)?|потърси\s+за|проучи|deep\s+research(?:\s+(?:on|about))?|search\s+the\s+web(?:\s+for)?|search\s+for)(?:\s*[:–—-]\s*|\s+|$)|^research\s*:\s*/iu, '').trim();
}

export async function searchWiki(topic: string, signal?: AbortSignal): Promise<WikiHit[]> {
  const language = /[а-я]/iu.test(topic) ? 'bg' : 'en';
  const url = wikiUrl(language, { list: 'search', srsearch: topic, srnamespace: '0', srlimit: '4' });
  const result = wikiSearch.parse(await sourceRequest(url, signal));
  return result.query.search.map((article) => ({
    title: plainText(article.title, 200), pageId: article.pageid, language,
    url: `https://${language}.wikipedia.org/?curid=${article.pageid}`,
    excerpt: plainText(article.snippet, 430),
  }));
}

export async function readWikiArticles(hits: WikiHit[], signal?: AbortSignal): Promise<WikiHit[]> {
  if (!hits.length) return [];
  const url = wikiUrl(hits[0].language, {
    prop: 'extracts', pageids: hits.map(({ pageId }) => pageId).join('|'), exintro: '1', exsentences: '4', explaintxt: '1',
  });
  const result = wikiArticles.parse(await sourceRequest(url, signal));
  const extracts = new Map(result.query.pages.map(({ pageid, extract }) => [pageid, extract ? plainText(extract, 900) : '']));
  return hits.map((hit) => ({ ...hit, excerpt: extracts.get(hit.pageId) || hit.excerpt }));
}

export function formatPublicationDate(parts?: number[]) {
  if (!parts?.length) return;
  const [year, month, day] = parts;
  if (!Number.isInteger(year) || year < 1 || year > 9999) return;
  const yyyy = String(year).padStart(4, '0');
  if (!Number.isInteger(month) || month < 1 || month > 12) return yyyy;
  const yearMonth = `${yyyy}-${String(month).padStart(2, '0')}`;
  if (!Number.isInteger(day) || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return yearMonth;
  return `${yearMonth}-${String(day).padStart(2, '0')}`;
}

export async function searchCrossref(topic: string, signal?: AbortSignal): Promise<ScholarlyHit[]> {
  const url = new URL('https://api.crossref.org/works');
  url.search = new URLSearchParams({
    query: topic, rows: '5', select: 'title,DOI,publisher,abstract,published',
  }).toString();
  const result = crossrefResults.parse(await sourceRequest(url, signal));
  const seen = new Set<string>();
  return result.message.items.flatMap((item) => {
    const doi = item.DOI;
    const title = item.title?.[0];
    if (!doi || !/^10\.\d{4,9}\/[\w.\-;()/:+]+$/i.test(doi) || !title) return [];
    const work = doi.toLowerCase().replace(/\/v\d+$/, '');
    if (seen.has(work)) return [];
    seen.add(work);
    const published = item.published?.['date-parts'][0];
    const year = published?.[0];
    const publicationDate = formatPublicationDate(published);
    return [{
      doi, title: plainText(title, 250), publisher: plainText(item.publisher || '', 120),
      url: `https://doi.org/${encodeURI(doi).replace(/\(/g, '%28').replace(/\)/g, '%29')}`,
      excerpt: item.abstract ? plainText(item.abstract, 950) : '', ...(publicationDate ? { year, publicationDate } : {}),
    }];
  });
}
