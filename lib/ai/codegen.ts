import { generateText, Output } from 'ai';
import { z } from 'zod';
import { getTextModel, hasAIProvider } from './config';
import { isQuotaExceeded } from './quota';
import type { BrainResult } from './supreme-brain';
import { generateProjectFiles } from '../generator';
import type { UserIntent } from './intent-parser';

const FilesSchema = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() })),
  qualityNotes: z.string(),
});

export async function generateWithAI(
  brain: BrainResult,
  projectType: string
): Promise<Array<{ path: string; content: string }>> {
  const model = await getTextModel();

  if (!model || !(await hasAIProvider()) || isQuotaExceeded()) {
    return generateFromIntent(brain.intent, projectType, brain.screenshotAnalysis);
  }

  const layoutDetail = brain.aiIntent?.layout || brain.screenshotAnalysis || '';
  const fidelity = brain.aiIntent?.fidelityNotes || '';

  try {
    const { output } = await generateText({
      model,
      output: Output.object({ schema: FilesSchema }),
      maxRetries: 0,
      maxOutputTokens: 8000,
      system: `Generate COMPLETE production code files 1:1 from screenshot analysis.
REQUIRED files: public/index.html, public/styles.css, public/app.js, package.json, README.md, .gitignore
Match colors, layout, typography EXACTLY. Full working code only.`,
      prompt: `Build ${projectType} 1:1:
${brain.intent.understanding}
Title: ${brain.intent.title}
Colors: ${brain.intent.style.colors.join(', ')}
Sections: ${brain.intent.sections.join(', ')}
${layoutDetail ? `Layout:\n${layoutDetail}` : ''}
${fidelity ? `Notes:\n${fidelity}` : ''}
User: "${brain.intent.rawPrompt}"`,
    });

    if (output?.files?.length) {
      if (!output.files.some((f) => f.path === 'README.md')) {
        output.files.push({
          path: 'README.md',
          content: `# ${brain.intent.title}\n\n${brain.intent.understanding}`,
        });
      }
      return output.files;
    }
  } catch (err) {
    console.error('AI codegen failed:', err);
  }

  return generateFromIntent(brain.intent, projectType, brain.screenshotAnalysis);
}

function generateFromIntent(
  intent: UserIntent,
  projectType: string,
  screenshotAnalysis?: string
): Array<{ path: string; content: string }> {
  const base = generateProjectFiles(projectType, intent.rawPrompt, intent.title);

  if (projectType === 'website' || projectType === 'saas') {
    const htmlIdx = base.findIndex((f) => f.path === 'public/index.html');
    if (htmlIdx >= 0) {
      base[htmlIdx] = {
        path: 'public/index.html',
        content: buildIntentHtml(intent, projectType === 'saas', screenshotAnalysis),
      };
    }
    const cssIdx = base.findIndex((f) => f.path === 'public/styles.css');
    if (cssIdx >= 0) {
      base[cssIdx] = { path: 'public/styles.css', content: buildIntentCss(intent) };
    }
  }

  base.push({
    path: 'SHARKAI_UNDERSTANDING.md',
    content: `# Supreme Brain\n\n${intent.understanding}\n${screenshotAnalysis ? `\n## Screenshot\n${screenshotAnalysis}` : ''}`,
  });

  return base;
}

function buildIntentCss(intent: UserIntent): string {
  const [c1, c2, c3] = intent.style.colors;
  const bg = intent.style.theme === 'light' ? '#f8fafc' : '#0a0e1a';
  const text = intent.style.theme === 'light' ? '#0f172a' : '#ffffff';
  return `*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}:root{--c1:${c1};--c2:${c2};--c3:${c3};--bg:${bg};--text:${text}}body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text)}.hero{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:2rem}.hero h1{font-size:clamp(2rem,5vw,3.5rem);background:linear-gradient(90deg,var(--c1),var(--c2),var(--c3));-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:1rem}.hero p{opacity:.7;max-width:640px;margin-bottom:2rem}.btn{padding:1rem 2.5rem;border-radius:14px;background:linear-gradient(135deg,var(--c1),var(--c3));color:#fff;text-decoration:none;font-weight:600}section{padding:4rem 2rem;max-width:1100px;margin:0 auto}section h2{text-align:center;margin-bottom:2rem}.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1.5rem}.card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:2rem}footer{text-align:center;padding:3rem;opacity:.5}`;
}

function buildIntentHtml(intent: UserIntent, isSaas: boolean, screenshotAnalysis?: string): string {
  const lang = intent.language === 'en' ? 'en' : 'bg';
  const sections = intent.sections.filter((s) => s !== 'hero' && s !== 'footer').map((s) => {
    const cards = intent.features.slice(0, 3).map((f) => `<div class="card"><h3>${f}</h3><p>${intent.copy.subheadline.slice(0, 80)}</p></div>`).join('');
    return `<section><h2>${s}</h2><div class="features">${cards}</div></section>`;
  }).join('');
  return `<!DOCTYPE html><html lang="${lang}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${intent.title}</title><link rel="stylesheet" href="styles.css"></head><body><section class="hero"><h1>${intent.copy.headline}</h1><p>${intent.copy.subheadline}</p><a href="#" class="btn">${intent.copy.cta}</a></section>${sections}${isSaas ? '<section style="text-align:center;padding:4rem"><a href="#" class="btn">Free Trial</a></section>' : ''}<footer>SharkAI · ${new Date().getFullYear()}${screenshotAnalysis ? ' · 1:1' : ''}</footer><script src="app.js"></script></body></html>`;
}
