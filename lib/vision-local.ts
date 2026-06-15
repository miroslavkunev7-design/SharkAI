import sharp from 'sharp';

export interface LayoutHints {
  hasHeader: boolean;
  hasSidebar: boolean;
  hasHero: boolean;
  layout: 'landing' | 'dashboard' | 'mobile' | 'wide';
}

export interface ImageProfile {
  width: number;
  height: number;
  isDark: boolean;
  colors: string[];
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  layout: LayoutHints;
}

function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
}

function sampleColors(data: Buffer, info: { width: number; height: number; channels: number }) {
  const colorCount: Record<string, number> = {};
  let totalBrightness = 0;
  const pixels = info.width * info.height;

  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    totalBrightness += (r + g + b) / 3;
    const hex = rgbToHex(Math.round(r / 24) * 24, Math.round(g / 24) * 24, Math.round(b / 24) * 24);
    if (r + g + b > 24) colorCount[hex] = (colorCount[hex] || 0) + 1;
  }

  const sorted = Object.entries(colorCount).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 8).map(([c]) => c);
  const isDark = totalBrightness / pixels < 110;

  return { top, isDark };
}

function detectLayout(data: Buffer, info: { width: number; height: number; channels: number }, isDark: boolean): LayoutHints {
  const w = info.width;
  const h = info.height;
  const ch = info.channels;

  const bandColor = (yStart: number, yEnd: number, xStart: number, xEnd: number) => {
    const samples: string[] = [];
    for (let y = yStart; y < yEnd; y++) {
      for (let x = xStart; x < xEnd; x++) {
        const i = (y * w + x) * ch;
        samples.push(rgbToHex(data[i], data[i + 1], data[i + 2]));
      }
    }
    const counts: Record<string, number> = {};
    for (const c of samples) counts[c] = (counts[c] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '#000';
  };

  const topColor = bandColor(0, Math.floor(h * 0.12), 0, w);
  const midColor = bandColor(Math.floor(h * 0.3), Math.floor(h * 0.5), 0, w);
  const leftColor = bandColor(0, h, 0, Math.floor(w * 0.18));
  const centerColor = bandColor(0, h, Math.floor(w * 0.2), Math.floor(w * 0.8));

  const hasHeader = topColor !== centerColor;
  const hasSidebar = leftColor !== centerColor;
  const hasHero = topColor !== midColor;
  const ratio = w / h;

  let layout: LayoutHints['layout'] = 'landing';
  if (hasSidebar && ratio > 1.2) layout = 'dashboard';
  else if (ratio < 0.7) layout = 'mobile';
  else if (ratio > 1.8) layout = 'wide';

  return { hasHeader, hasSidebar, hasHero, layout };
}

async function analyzeBuffer(buffer: Buffer): Promise<ImageProfile> {
  const img = sharp(buffer);
  const meta = await img.metadata();
  const { data, info } = await img
    .resize(160, 160, { fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { top, isDark } = sampleColors(data, info);
  const layout = detectLayout(data, info, isDark);

  const primary = top[0] || '#0072FF';
  const secondary = top[1] || '#00D2FF';
  const accent = top[2] || '#9D50BB';
  const background = isDark ? (top[top.length - 1] || '#0a0e1a') : '#f8fafc';

  return {
    width: meta.width || 1920,
    height: meta.height || 1080,
    isDark,
    colors: top.length ? top : [primary, secondary, accent],
    primary,
    secondary,
    accent,
    background,
    layout,
  };
}

export async function analyzeImageFile(filePath: string): Promise<ImageProfile> {
  const buffer = await sharp(filePath).toBuffer();
  return analyzeBuffer(buffer);
}

export async function analyzeImageBase64(base64: string, _mime: string): Promise<ImageProfile> {
  return analyzeBuffer(Buffer.from(base64, 'base64'));
}
