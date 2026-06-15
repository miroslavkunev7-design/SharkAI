export interface UserIntent {
  language: 'bg' | 'en' | 'mixed';
  summary: string;
  understanding: string;
  title: string;
  projectType: string;
  style: {
    theme: 'dark' | 'light' | 'auto';
    colors: string[];
    mood: string;
  };
  sections: string[];
  features: string[];
  copy: {
    headline: string;
    subheadline: string;
    cta: string;
  };
  fidelityTarget: number;
  rawPrompt: string;
}

const BG_MARKERS = /[а-яА-ЯёЁ]/;
const COLOR_WORDS: Record<string, string> = {
  черен: '#000000', black: '#000000', тъмен: '#0a0e1a', dark: '#0a0e1a',
  син: '#0072FF', blue: '#0072FF', циан: '#00D2FF', cyan: '#00D2FF',
  лилав: '#9D50BB', purple: '#9D50BB', violet: '#9D50BB',
  бял: '#ffffff', white: '#ffffff', зелен: '#22c55e', green: '#22c55e',
  червен: '#ef4444', red: '#ef4444', златен: '#f59e0b', gold: '#f59e0b',
};

const SECTION_KEYWORDS: Record<string, string[]> = {
  hero: ['hero', 'начало', 'заглавие', 'header', 'banner', 'главна'],
  pricing: ['pricing', 'цена', 'цени', 'план', 'абонамент', 'subscription'],
  features: ['features', 'функции', 'възможности', 'услуги', 'services'],
  contact: ['contact', 'контакт', 'форма', 'form', 'email'],
  about: ['about', 'за нас', 'история', 'team', 'екип'],
  gallery: ['gallery', 'галерия', 'portfolio', 'портфолио', 'снимки'],
  testimonials: ['testimonials', 'отзиви', 'reviews', 'мнения'],
  footer: ['footer', 'долен', 'край'],
  dashboard: ['dashboard', 'табло', 'admin', 'панел'],
  login: ['login', 'вход', 'sign in', 'регистрация', 'register'],
};

function detectLanguage(text: string): 'bg' | 'en' | 'mixed' {
  const hasBg = BG_MARKERS.test(text);
  const hasEn = /[a-zA-Z]{3,}/.test(text);
  if (hasBg && hasEn) return 'mixed';
  if (hasBg) return 'bg';
  return 'en';
}

function extractColors(text: string): string[] {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const [word, hex] of Object.entries(COLOR_WORDS)) {
    if (lower.includes(word)) found.add(hex);
  }
  const hexMatches = text.match(/#[0-9a-fA-F]{3,8}/g);
  hexMatches?.forEach((h) => found.add(h));
  if (found.size === 0) return ['#00D2FF', '#0072FF', '#9D50BB'];
  return [...found];
}

function extractSections(text: string): string[] {
  const lower = text.toLowerCase();
  const sections: string[] = [];
  for (const [section, keywords] of Object.entries(SECTION_KEYWORDS)) {
    if (keywords.some((k) => lower.includes(k))) sections.push(section);
  }
  if (sections.length === 0) sections.push('hero', 'features', 'footer');
  return sections;
}

function extractTitle(text: string, lang: 'bg' | 'en' | 'mixed'): string {
  const patterns = [
    /(?:за|for)\s+(.{3,50}?)(?:\.|,|$)/i,
    /(?:направи|създай|build|create|make)\s+(?:ми\s+)?(.{3,50}?)(?:\.|,|$)/i,
    /(?:landing page|сайт|website|app|приложение)\s+(?:за|for)\s+(.{3,40})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) return m[1].trim().replace(/["']/g, '');
  }
  const first = text.split(/[.!?\n]/)[0]?.trim();
  if (first && first.length > 5 && first.length < 60) return first;
  return lang === 'bg' ? 'Моят Проект' : 'My Project';
}

function buildUnderstanding(intent: Partial<UserIntent>, lang: 'bg' | 'en' | 'mixed'): string {
  if (lang === 'bg' || lang === 'mixed') {
    return `Разбрах те! Искаш ${intent.title} — ${intent.style?.theme === 'dark' ? 'тъмна' : 'светла'} тема с ${intent.sections?.join(', ')}. Ще направя 1:1 както описа: "${intent.rawPrompt?.slice(0, 120)}".`;
  }
  return `Got it! You want ${intent.title} — ${intent.style?.theme} theme with ${intent.sections?.join(', ')}. I'll build this exactly as you described: "${intent.rawPrompt?.slice(0, 120)}".`;
}

export function parseHumanIntent(prompt: string, projectType: string): UserIntent {
  const lang = detectLanguage(prompt);
  const lower = prompt.toLowerCase();
  const colors = extractColors(prompt);
  const sections = extractSections(prompt);
  const title = extractTitle(prompt, lang);

  const isDark = /dark|тъм|черен|black|navy|нощ/i.test(prompt) || !/light|свет|бял|white/i.test(prompt);
  const isLight = /light|свет|бял|white/i.test(prompt) && !isDark;

  const features: string[] = [];
  if (/responsive|мобил|mobile/i.test(prompt)) features.push('Mobile responsive');
  if (/анимац|animat/i.test(prompt)) features.push('Smooth animations');
  if (/glass|стъкло|glassmorphism/i.test(prompt)) features.push('Glassmorphism');
  if (/gradient|градиент/i.test(prompt)) features.push('Gradient accents');
  if (/1:1|един към един|точно|exact|pixel|копие|copy|като/i.test(prompt)) {
    features.unshift('1:1 pixel-perfect reproduction');
  }
  if (features.length === 0) features.push('Modern UI', 'Professional design', 'Premium quality');

  const intent: UserIntent = {
    language: lang,
    summary: prompt.slice(0, 200),
    understanding: '',
    title,
    projectType,
    style: {
      theme: isLight ? 'light' : 'dark',
      colors,
      mood: /premium|премиум|luxury|лукс/i.test(prompt) ? 'premium' : 'modern',
    },
    sections,
    features,
    copy: {
      headline: title,
      subheadline: prompt.slice(0, 150),
      cta: lang === 'bg' ? 'Започни сега' : 'Get Started',
    },
    fidelityTarget: 99,
    rawPrompt: prompt,
  };

  intent.understanding = buildUnderstanding(intent, lang);
  return intent;
}
