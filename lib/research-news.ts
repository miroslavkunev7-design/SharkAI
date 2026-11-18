import { DOMParser, onWarningStopParsing, type Element } from '@xmldom/xmldom';

const FEED_LIMIT = 512 * 1024;
const ARTICLE_LIMIT = 6;
const DAY = 24 * 60 * 60 * 1000;
const indexHost = 'news.google.com';

export interface NewsHit {
  title: string;
  url: string;
  publisher: string;
  publishedAt: string;
}

export interface NewsPeriod {
  start: number;
  end: number;
  clause: string;
}

const calendarPeriods = [
  { clause: /\b(?:from|published)\s+today\b|\btoday['’]s(?=\s+(?:news|headlines)\b)|\b(?:news|headlines)\s+today\b|(?<!\p{L})(?:от\s+днес|днешните\s+новини|новини\s+днес)(?!\p{L})/iu, period: 'today' },
  { clause: /\b(?:from|published)\s+yesterday\b|\byesterday['’]s(?=\s+(?:news|headlines)\b)|\b(?:news|headlines)\s+yesterday\b|(?<!\p{L})(?:от\s+вчера|вчерашните\s+новини|новини\s+вчера)(?!\p{L})/iu, period: 'yesterday' },
  { clause: /\b(?:(?:from|in|over)\s+)?this\s+week\b|(?<!\p{L})(?:(?:от|през)\s+)?тази\s+седмица(?!\p{L})/iu, period: 'thisWeek' },
  { clause: /\b(?:(?:from|in|over)\s+)?last\s+week\b|(?<!\p{L})(?:(?:от|през)\s+)?(?:миналата|предходната)\s+седмица(?!\p{L})/iu, period: 'lastWeek' },
] as const;

export function requestedNewsPeriod(topic: string, asOf = new Date()): NewsPeriod | null {
  const now = asOf.getTime();
  const numbered = /\b(?:(?:from|in|over|for)\s+)?(?:the\s+)?(?:last|past)\s+([1-9]\d{0,2})\s+(days?|hours?)\b|(?<!\p{L})(?:(?:от|през|за)\s+)?последните\s+([1-9]\d{0,2})\s+(дни|часа)(?!\p{L})/iu.exec(topic);
  if (numbered) {
    const unit = numbered[2] ?? numbered[4];
    const span = /^(?:day|дни)/iu.test(unit) ? DAY : DAY / 24;
    return { start: now - Number(numbered[1] ?? numbered[3]) * span, end: now, clause: numbered[0] };
  }
  const midnight = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  const monday = midnight - (asOf.getUTCDay() + 6) % 7 * DAY;
  for (const { clause, period } of calendarPeriods) {
    const match = clause.exec(topic);
    if (!match) continue;
    const [start, end] = {
      today: [midnight, now],
      yesterday: [midnight - DAY, midnight - 1],
      thisWeek: [monday, now],
      lastWeek: [monday - 7 * DAY, monday - 1],
    }[period];
    return { start, end, clause: match[0] };
  }
  return null;
}

export function describeNewsPeriod({ start, end }: NewsPeriod) {
  return [start, end].map((time) => new Date(time).toISOString().slice(0, 16).replace('T', ' ')).join(' до ') + ' UTC';
}

export function isInNewsPeriod(date: number, period: NewsPeriod) {
  return date >= period.start && date <= period.end;
}

export function wantsNewsCoverage(topic: string) {
  return /(?:^|[^\p{L}\p{N}])(?:news|headlines|latest|recent|today|yesterday|this week|last week|current events|новини|актуално|актуални|последните|днес|вчера|тази седмица|миналата седмица|в момента)(?=$|[^\p{L}\p{N}])/iu.test(topic);
}

function newsQuery(topic: string) {
  return topic.replace(/^(?:(?:the\s+)?(?:latest\s+|recent\s+)?(?:news|headlines)\s+(?:on|about|from)\s+|(?:какви\s+са\s+)?(?:(?:последните|актуални|актуалните|най-новите)\s+)?новини\s+(?:за|от|около)\s+)/iu, '').trim() || topic;
}

function articleUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.origin !== `https://${indexHost}` || url.username || url.password || !url.pathname.startsWith('/rss/articles/')) return null;
    return url.href;
  } catch {
    return null;
  }
}

function field(item: Element, name: string, maxLength: number) {
  return item.getElementsByTagName(name).item(0)?.textContent?.replace(/\s+/g, ' ').trim().slice(0, maxLength) ?? '';
}

export function parseNewsFeed(xml: string, period?: NewsPeriod | null): NewsHit[] {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('Unexpected RSS declaration');
  const feed = new DOMParser({ locator: false, onError: onWarningStopParsing }).parseFromString(xml, 'application/xml');
  const channel = feed.documentElement?.nodeName === 'rss' && feed.documentElement.getElementsByTagName('channel').item(0);
  if (!channel) throw new Error('Invalid news RSS feed');
  const seen = new Set<string>();
  const hits: NewsHit[] = [];
  for (const item of Array.from(channel.getElementsByTagName('item'))) {
    const url = articleUrl(field(item, 'link', 4000));
    const publisher = field(item, 'source', 160);
    const originalTitle = field(item, 'title', 300);
    const publisherSuffix = ` - ${publisher}`;
    const title = publisher && originalTitle.endsWith(publisherSuffix) ? originalTitle.slice(0, -publisherSuffix.length) : originalTitle;
    const date = Date.parse(field(item, 'pubDate', 100));
    if (!url || seen.has(url) || !title || !publisher || !Number.isFinite(date)) continue;
    if (period && !isInNewsPeriod(date, period)) continue;
    seen.add(url);
    hits.push({ title, publisher, publishedAt: new Date(date).toISOString(), url });
    if (hits.length === ARTICLE_LIMIT) break;
  }
  return hits;
}

export async function searchNews(topic: string, signal?: AbortSignal, asOf = new Date()): Promise<NewsHit[]> {
  const bulgarian = /[а-я]/iu.test(topic);
  const period = requestedNewsPeriod(topic, asOf);
  const query = newsQuery(period ? topic.replace(period.clause, /новини/iu.test(period.clause) ? 'новини' : ' ').replace(/\s+/g, ' ').trim() || topic : topic);
  // Add a day on either side for the index's local calendar. Verify exact UTC times below.
  const q = period ? `${query} after:${new Date(period.start - DAY).toISOString().slice(0, 10)} before:${new Date(period.end + DAY).toISOString().slice(0, 10)}` : query;
  const url = new URL(`https://${indexHost}/rss/search`);
  url.search = new URLSearchParams({
    q, hl: bulgarian ? 'bg' : 'en-US', gl: bulgarian ? 'BG' : 'US', ceid: bulgarian ? 'BG:bg' : 'US:en',
  }).toString();
  const deadline = AbortSignal.timeout(8_000);
  const response = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    headers: { Accept: 'application/rss+xml, application/xml, text/xml' }, cache: 'no-store', redirect: 'error',
  });
  if (!response.ok || !response.body) throw new Error(`News RSS HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let xml = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > FEED_LIMIT) {
        await reader.cancel();
        throw new Error('News RSS exceeds size limit');
      }
      xml += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return parseNewsFeed(xml + decoder.decode(), period);
}
