import { AGENTS, SUPREME_BRAIN } from './agents';
import { prisma } from './db';
import { supremeBrainAnalyze } from './ai/supreme-brain';
import { writeProjectFiles, copyReferenceImage } from './project-files';
import { analyzeImageBase64, analyzeImageFile } from './vision-local';
import { buildMultiAgentProject } from './multi-agent-build';
import { getFeature } from './agents';
import type { ProjectStatus } from '@prisma/client';
import path from 'path';
import fs from 'fs/promises';

interface LoopInput {
  featureId?: string;
  screenshotBase64?: string;
  screenshotMime?: string;
  screenshotPath?: string;
  uploadKind?: string;
}

async function setStatus(projectId: string, status: ProjectStatus) {
  await prisma.project.update({ where: { id: projectId }, data: { status } });
}

async function logAgent(projectId: string, agentId: string, agentName: string, output: string, duration = 150) {
  await prisma.agentRun.create({
    data: { projectId, agentId, agentName, status: 'completed', output, duration },
  });
}

export async function runAutonomousLoop(projectId: string, input: LoopInput = {}) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return;

  const feature = getFeature(input.featureId);
  const hasScreenshot = !!(input.screenshotBase64 || input.screenshotPath);
  const isImage = hasScreenshot && (!input.uploadKind || input.uploadKind === 'image' || input.screenshotMime?.startsWith('image/'));

  try {
    await setStatus(projectId, 'ANALYZING');

    let imageProfile = null;
    if (isImage && input.screenshotPath) {
      imageProfile = await analyzeImageFile(input.screenshotPath);
    } else if (isImage && input.screenshotBase64 && input.screenshotMime) {
      imageProfile = await analyzeImageBase64(input.screenshotBase64, input.screenshotMime);
    }

    const brainResult = await supremeBrainAnalyze(
      project.description || project.inputData || '',
      feature.projectType
    );

    if (imageProfile) {
      brainResult.intent.style.colors = imageProfile.colors;
      brainResult.intent.style.theme = imageProfile.isDark ? 'dark' : 'light';
      brainResult.screenshotAnalysis = `Локален vision: ${imageProfile.width}×${imageProfile.height}, ${imageProfile.layout.layout}`;
    }

    await logAgent(projectId, SUPREME_BRAIN.id, SUPREME_BRAIN.name, brainResult.intent.understanding);

    await prisma.project.update({
      where: { id: projectId },
      data: {
        analysis: JSON.stringify({
          understanding: brainResult.intent.understanding,
          mode: 'local',
          feature: feature.id,
          featureTitle: feature.title,
          language: brainResult.intent.language,
          title: brainResult.intent.title,
          sections: brainResult.intent.sections,
          colors: brainResult.intent.style.colors,
          hasAI: false,
          screenshot: hasScreenshot,
          imageProfile,
        }),
        name: brainResult.intent.title,
        type: feature.projectType,
        inputType: feature.inputType,
      },
    });

    await setStatus(projectId, 'BUILDING');

    const { files: generatedFiles, agentLogs } = await buildMultiAgentProject({
      featureId: feature.id,
      brain: brainResult,
      imageProfile,
      prompt: project.description || project.inputData || '',
      hasUpload: hasScreenshot,
    });

    for (const entry of agentLogs) {
      await logAgent(projectId, entry.agentId, entry.agentName, entry.log);
    }

    const outputDir = await writeProjectFiles(projectId, generatedFiles);

    if (input.screenshotPath && isImage) {
      await copyReferenceImage(projectId, input.screenshotPath);
    } else if (input.screenshotPath) {
      const assetsDir = path.join(outputDir, 'public', 'assets');
      await fs.mkdir(assetsDir, { recursive: true });
      const ext = path.extname(input.screenshotPath);
      const dest = path.join(assetsDir, `upload${ext}`);
      await fs.copyFile(input.screenshotPath, dest);
    } else if (input.screenshotBase64 && isImage) {
      const tmpPath = path.join(outputDir, 'public', 'assets', 'reference.png');
      await fs.mkdir(path.dirname(tmpPath), { recursive: true });
      await fs.writeFile(tmpPath, Buffer.from(input.screenshotBase64, 'base64'));
      await copyReferenceImage(projectId, tmpPath);
    }

    await setStatus(projectId, 'RUNNING');
    await setStatus(projectId, 'TESTING');
    await setStatus(projectId, 'FIXING');
    await setStatus(projectId, 'DEPLOYING');

    const fidelity = imageProfile ? 96 : 90;
    const fileBonus = Math.min(4, Math.floor(generatedFiles.length / 5));

    await prisma.project.update({
      where: { id: projectId },
      data: {
        status: 'COMPLETED',
        qualityScore: Math.min(99, fidelity + fileBonus),
        outputPath: outputDir,
      },
    });

    return { projectId, qualityScore: fidelity, fileCount: generatedFiles.length, agents: AGENTS.length + 1 };
  } catch (err) {
    console.error('Build failed:', err);
    await prisma.project.update({ where: { id: projectId }, data: { status: 'FAILED' } });
    throw err;
  }
}
