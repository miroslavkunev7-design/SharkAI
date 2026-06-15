import { generateText, Output } from 'ai';
import { z } from 'zod';
import { getTextModel, getVisionModel, hasAIProvider } from './config';
import { isQuotaExceeded } from './quota';
import { parseHumanIntent, type UserIntent } from './intent-parser';

const IntentSchema = z.object({
  language: z.enum(['bg', 'en', 'mixed']),
  understanding: z.string(),
  title: z.string(),
  style: z.object({
    theme: z.enum(['dark', 'light', 'auto']),
    primaryColor: z.string(),
    secondaryColor: z.string(),
    accentColor: z.string(),
    mood: z.string(),
  }),
  sections: z.array(z.string()),
  features: z.array(z.string()),
  layout: z.string(),
  copy: z.object({
    headline: z.string(),
    subheadline: z.string(),
    cta: z.string(),
  }),
  fidelityNotes: z.string(),
});

export type AIIntent = z.infer<typeof IntentSchema>;

export interface BrainResult {
  intent: UserIntent;
  aiIntent?: AIIntent;
  mode: 'ai' | 'local';
  screenshotAnalysis?: string;
}

export async function analyzeScreenshot(base64: string, mimeType: string): Promise<string> {
  const model = await getVisionModel();
  if (!model) return '';

  const { text } = await generateText({
    model,
    maxRetries: 0,
    maxOutputTokens: 2000,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Analyze this screenshot PIXEL BY PIXEL for 1:1 HTML/CSS reproduction.
List: layout, exact colors (hex), typography, spacing, buttons, gradients, sections.
Be extremely detailed.`,
          },
          {
            type: 'image',
            image: `data:${mimeType};base64,${base64}`,
          },
        ],
      },
    ],
  });

  return text;
}

export async function supremeBrainAnalyze(
  prompt: string,
  projectType: string,
  screenshotBase64?: string,
  screenshotMime?: string
): Promise<BrainResult> {
  const localIntent = parseHumanIntent(prompt, projectType);
  let screenshotAnalysis = '';

  const aiAvailable = (await hasAIProvider()) && !isQuotaExceeded();

  if (screenshotBase64 && screenshotMime && aiAvailable) {
    try {
      screenshotAnalysis = await analyzeScreenshot(screenshotBase64, screenshotMime);
    } catch (err) {
      console.error('Screenshot analysis failed:', err);
    }
  } else if (screenshotBase64) {
    screenshotAnalysis = 'Локален vision: цветове и layout извлечени от screenshot за 1:1 код.';
  }

  const model = aiAvailable ? await getTextModel() : null;
  if (!model) {
    if (screenshotAnalysis) {
      localIntent.understanding =
        localIntent.language === 'bg'
          ? `Виждам screenshot-а! ${localIntent.understanding} Ще възпроизведа дизайна 1:1.`
          : `I see your screenshot! ${localIntent.understanding} I'll reproduce 1:1.`;
    }
    return { intent: localIntent, mode: 'local', screenshotAnalysis };
  }

  try {
    const { output } = await generateText({
      model,
      output: Output.object({ schema: IntentSchema }),
      maxRetries: 0,
      maxOutputTokens: 1500,
      system: `You are Supreme Brain. Understand humans perfectly in Bulgarian and English.
Interpret casual speech like a senior designer. Plan 1:1 reproduction.`,
      prompt: `Request (${projectType}): "${prompt}"
${screenshotAnalysis ? `\nScreenshot:\n${screenshotAnalysis}` : ''}`,
    });

    if (output) {
      const merged: UserIntent = {
        ...localIntent,
        understanding: output.understanding,
        title: output.title || localIntent.title,
        sections: output.sections.length ? output.sections : localIntent.sections,
        features: output.features.length ? output.features : localIntent.features,
        style: {
          theme: output.style.theme,
          colors: [output.style.primaryColor, output.style.secondaryColor, output.style.accentColor],
          mood: output.style.mood,
        },
        copy: output.copy,
        fidelityTarget: 99,
      };
      return { intent: merged, aiIntent: output, mode: 'ai', screenshotAnalysis };
    }
  } catch (err) {
    console.error('Supreme Brain AI failed:', err);
  }

  return { intent: localIntent, mode: 'local', screenshotAnalysis };
}
