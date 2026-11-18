import type { BrainResult } from './ai/supreme-brain';
import type { ImageProfile } from './vision-local';
import { getFeature } from './agents';
import { buildScreenshotProject } from './screenshot-builder';
import { generateProjectFiles } from './generator';
import { generateWithAI } from './ai/codegen';

interface ProjectFile {
  path: string;
  content: string;
}

interface BuildResult {
  files: ProjectFile[];
  method: 'reference' | 'provider' | 'scaffold' | 'document';
}

export async function buildMultiAgentProject(options: {
  featureId: string;
  brain: BrainResult;
  imageProfile: ImageProfile | null;
  prompt: string;
}): Promise<BuildResult> {
  const feature = getFeature(options.featureId);
  const { brain, imageProfile, prompt } = options;

  if (feature.projectType === 'docs') {
    return {
      method: 'document',
      files: [{
        path: 'docs/overview.md',
        content: `# ${brain.intent.title}

## Описание
${prompt}

## Обхват
${brain.intent.understanding}
${brain.intent.sections.map((section) => `- ${section}`).join('\n')}
`,
      }],
    };
  }

  if (imageProfile) {
    const files = buildScreenshotProject(brain, imageProfile, feature.projectType);
    if (['mobile', 'desktop', 'game'].includes(feature.projectType)) {
      const scaffold = generateProjectFiles(feature.projectType, prompt, brain.intent.title);
      const nativeFiles = scaffold.filter((file) => !files.some(({ path }) => path === file.path));
      files.push(...nativeFiles);
    }
    return { files, method: 'reference' };
  }

  if (feature.projectType === 'api' || feature.projectType === 'database') {
    return { files: generateProjectFiles(feature.projectType, prompt, brain.intent.title), method: 'scaffold' };
  }

  return generateWithAI(brain, feature.projectType);
}
