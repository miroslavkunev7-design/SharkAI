import fs from 'node:fs/promises';
import sharp from 'sharp';
import { AGENTS, SUPREME_BRAIN, getFeature } from './agents';
import { prisma } from './db';
import { supremeBrainAnalyze } from './ai/supreme-brain';
import { writeProjectFiles } from './project-files';
import { analyzeImageBase64 } from './vision-local';
import { buildMultiAgentProject } from './multi-agent-build';

interface LoopInput {
  featureId?: string;
  screenshotBase64?: string;
  screenshotMime?: string;
  screenshotPath?: string;
  uploadKind?: string;
}

async function logAgent(
  projectId: string,
  agent: { id: string; name: string },
  output: string,
  started: number,
) {
  await prisma.agentRun.create({
    data: {
      projectId,
      agentId: agent.id,
      agentName: agent.name,
      status: 'completed',
      output,
      duration: Math.round(performance.now() - started),
    },
  });
}

export async function runAutonomousLoop(projectId: string, input: LoopInput = {}) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return;

  const feature = getFeature(input.featureId);
  const prompt = project.description || project.inputData || '';
  const requiresImage = feature.inputType === 'screenshot';

  try {
    const analysisStarted = performance.now();
    const reference = input.screenshotBase64
      ? Buffer.from(input.screenshotBase64, 'base64')
      : input.screenshotPath && requiresImage ? await fs.readFile(input.screenshotPath) : null;
    const imageProfile = reference && requiresImage
      ? await analyzeImageBase64(reference.toString('base64'), input.screenshotMime ?? 'image/png')
      : null;
    if (requiresImage && !imageProfile) throw new Error('Image analysis failed');

    const brainResult = await supremeBrainAnalyze(prompt, feature.projectType);
    brainResult.intent.title = project.name;
    if (imageProfile) {
      brainResult.intent.style.colors = imageProfile.colors;
      brainResult.intent.style.theme = imageProfile.isDark ? 'dark' : 'light';
      brainResult.screenshotAnalysis = `Изображение ${imageProfile.width}×${imageProfile.height}, структура ${imageProfile.layout.layout}, цветове ${imageProfile.colors.join(', ')}.`;
      await logAgent(projectId, AGENTS[0], brainResult.screenshotAnalysis, analysisStarted);
    }
    await logAgent(projectId, SUPREME_BRAIN, brainResult.intent.understanding, analysisStarted);

    const analysis = {
      understanding: brainResult.intent.understanding,
      mode: brainResult.mode,
      feature: feature.id,
      featureTitle: feature.title,
      language: brainResult.intent.language,
      title: brainResult.intent.title,
      sections: brainResult.intent.sections,
      colors: brainResult.intent.style.colors,
      hasAI: brainResult.mode === 'ai',
      screenshot: !!imageProfile,
      imageProfile,
    };
    await prisma.project.update({
      where: { id: projectId },
      data: { status: 'BUILDING', analysis: JSON.stringify(analysis) },
    });

    const buildStarted = performance.now();
    const { files, method } = await buildMultiAgentProject({ featureId: feature.id, brain: brainResult, imageProfile, prompt });
    const artifactFiles: Array<{ path: string; content: string | Buffer }> = [...files];
    if (imageProfile && reference) {
      const png = await sharp(reference).png().toBuffer();
      artifactFiles.push({ path: 'public/assets/reference.png', content: png });
    }
    const manifest = await writeProjectFiles(projectId, artifactFiles);
    const buildAgentId = feature.projectType === 'api' ? 'agent-3'
      : feature.projectType === 'database' ? 'agent-4'
      : feature.projectType === 'docs' ? 'agent-12' : 'agent-2';
    const buildAgent = AGENTS.find((agent) => agent.id === buildAgentId);
    if (buildAgent) await logAgent(projectId, buildAgent, `Създадени и запазени файлове: ${manifest.fileCount}.`, buildStarted);

    await prisma.project.update({
      where: { id: projectId },
      data: { status: 'COMPLETED', analysis: JSON.stringify({ ...analysis, buildMethod: method }) },
    });

    return { projectId, fileCount: manifest.fileCount };
  } catch (err) {
    console.error('Studio build failed:', err);
    await prisma.project.update({ where: { id: projectId }, data: { status: 'FAILED' } });
    throw err;
  }
}
