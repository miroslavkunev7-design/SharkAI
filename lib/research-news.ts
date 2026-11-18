import { DOMParser, onWarningStopParsing, type Element } from '@xmldom/xmldom';

const FEED_LIMIT = 512 * 1024;
const ARTICLE_LIMIT = 6;
const indexHost = 'news.google.com';

export interface NewsHit {
  title: string;
  url: string;
  publisher: string;
  publishedAt: string;
}

export function wantsNewsCoverage(topic: string) {
  return /(?:^|[^\p{L}\p{N}])(?:news|headlines|latest|recent|today|this week|current events|новини|актуално|актуални|последните|днес|тази седмица|в момента)(?=$|[^\p{L}\p{N}])/iu.test(topic);
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

export function parseNewsFeed(xml: string): NewsHit[] {
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
    seen.add(url);
    hits.push({ title, publisher, publishedAt: new Date(date).toISOString(), url });
    if (hits.length === ARTICLE_LIMIT) break;
  }
  return hits;
}

export async function searchNews(topic: string, signal?: AbortSignal): Promise<NewsHit[]> {
  const bulgarian = /[а-я]/iu.test(topic);
  const url = new URL(`https://${indexHost}/rss/search`);
  url.search = new URLSearchParams({
    q: newsQuery(topic), hl: bulgarian ? 'bg' : 'en-US', gl: bulgarian ? 'BG' : 'US', ceid: bulgarian ? 'BG:bg' : 'US:en',
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
  return parseNewsFeed(xml + decoder.decode());
}
