import fs from 'node:fs/promises';
import sharp from 'sharp';
import { AGENTS, SUPREME_BRAIN, getFeature } from './agents';
import { prisma } from './db';
import { supremeBrainAnalyze } from './ai/supreme-brain';
import { getProjectPreviewPath, readAllProjectFiles, writeProjectFiles } from './project-files';
import { buildReferenceDeploymentFiles } from './screenshot-builder';
import { TRACKED_STUDIO_RUNS } from './studio-activity';
import { analyzeImageBase64 } from './vision-local';
import { buildMultiAgentProject } from './multi-agent-build';

interface LoopInput {
  featureId?: string;
  screenshotBase64?: string;
  screenshotMime?: string;
  screenshotPath?: string;
  uploadKind?: string;
}

function studioAgent(id: string) {
  const agent = AGENTS.find((candidate) => candidate.id === id);
  if (!agent) throw new Error('Studio role not found');
  return agent;
}

async function runAgent<T>(
  projectId: string,
  agent: { id: string; name: string },
  failure: string,
  work: () => Promise<{ result: T; output: string }>,
) {
  const [run] = await prisma.$transaction([
    prisma.agentRun.create({
      data: { projectId, agentId: agent.id, agentName: agent.name, status: 'running' },
      select: { id: true },
    }),
    prisma.project.update({ where: { id: projectId }, data: { updatedAt: new Date() }, select: { id: true } }),
  ]);

  const started = performance.now();
  let completed: { result: T; output: string };
  try {
    completed = await work();
  } catch (error) {
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: 'failed', output: failure, duration: Math.round(performance.now() - started) },
    }).catch(() => console.error('Studio role failure could not be saved'));
    throw error;
  }

  await prisma.agentRun.update({
    where: { id: run.id },
    data: { status: 'completed', output: completed.output, duration: Math.round(performance.now() - started) },
  });
  return completed.result;
}

export async function runAutonomousLoop(projectId: string, input: LoopInput = {}) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return;

  const feature = getFeature(input.featureId);
  const prompt = project.description || project.inputData || '';
  const runMetadata = { feature: feature.id, featureTitle: feature.title, runSemantics: TRACKED_STUDIO_RUNS };

  try {
    await prisma.project.update({ where: { id: projectId }, data: { analysis: JSON.stringify(runMetadata) } });
    const visual = feature.inputType === 'screenshot'
      ? await runAgent(projectId, studioAgent('agent-1'), 'Референтното изображение не можа да се прочете.', async () => {
        const reference = input.screenshotBase64
          ? Buffer.from(input.screenshotBase64, 'base64')
          : input.screenshotPath ? await fs.readFile(input.screenshotPath) : null;
        if (!reference?.length) throw new Error('Screenshot source is unavailable');
        const imageProfile = await analyzeImageBase64(reference.toString('base64'), input.screenshotMime ?? 'image/png');
        const description = `Изображение ${imageProfile.width}×${imageProfile.height}, структура ${imageProfile.layout.layout}, цветове ${imageProfile.colors.join(', ')}.`;
        return { result: { reference, imageProfile, description }, output: description };
      })
      : null;
    const imageProfile = visual?.imageProfile ?? null;

    const brainResult = await runAgent(projectId, SUPREME_BRAIN, 'Обхватът на проекта не можа да се подготви.', async () => {
      const brain = await supremeBrainAnalyze(prompt, feature.projectType);
      brain.intent.title = project.name;
      if (visual) {
        brain.intent.style.colors = visual.imageProfile.colors;
        brain.intent.style.theme = visual.imageProfile.isDark ? 'dark' : 'light';
        brain.screenshotAnalysis = visual.description;
      }
      return { result: brain, output: brain.intent.understanding };
    });

    const analysis = {
      ...runMetadata,
      understanding: brainResult.intent.understanding,
      mode: brainResult.mode,
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

    const buildAgentId = feature.projectType === 'api' ? 'agent-3'
      : feature.projectType === 'database' ? 'agent-4'
      : feature.projectType === 'docs' ? 'agent-12' : 'agent-2';
    const { files, method } = await runAgent(projectId, studioAgent(buildAgentId), 'Файловете на проекта не можаха да се генерират.', async () => {
      const result = await buildMultiAgentProject({ featureId: feature.id, brain: brainResult, imageProfile, prompt });
      if (!result.files.length) throw new Error('Generator returned no output');
      return { result, output: `Генерирани са ${result.files.length} файла.` };
    });
    const artifactFiles: Array<{ path: string; content: string | Buffer }> = [...files];

    if (visual) {
      const design = await runAgent(projectId, studioAgent('agent-13'), 'Референцията и палитрата не можаха да се подготвят.', async () => {
        const { reference, imageProfile: profile } = visual;
        const png = await sharp(reference).png().toBuffer();
        return {
          result: [
            { path: 'public/assets/reference.png', content: png },
            {
              path: 'design/palette.json',
              content: JSON.stringify({
                primary: profile.primary, secondary: profile.secondary, accent: profile.accent,
                background: profile.background, extractedColors: profile.colors,
              }, null, 2),
            },
          ],
          output: 'Палитрата на референтното изображение е подготвена в design/palette.json.',
        };
      });
      artifactFiles.push(...design);
    }

    if (method === 'reference') {
      const deployment = await runAgent(projectId, studioAgent('agent-5'), 'Файловете за статично публикуване не можаха да се подготвят.', async () => ({
        result: buildReferenceDeploymentFiles(),
        output: 'Подготвени са Dockerfile и vercel.json за статичния артефакт.',
      }));
      artifactFiles.push(...deployment);
    }

    const manifest = await writeProjectFiles(projectId, artifactFiles);
    await prisma.project.update({ where: { id: projectId }, data: { status: 'TESTING' } });
    await runAgent(projectId, studioAgent('agent-8'), 'Проверката откри липсващи или променени файлове.', async () => {
      const stored = await readAllProjectFiles(projectId);
      const expected = new Map(artifactFiles.map(({ path, content }) => [path, Buffer.from(content)]));
      const verified = stored.length === manifest.fileCount && stored.every(({ path, content }) => expected.get(path)?.equals(content));
      if (!verified) throw new Error('Saved artifact differs from generated output');
      const previewPath = getProjectPreviewPath(manifest);
      if (method === 'reference' && (!previewPath || !expected.get('public/assets/reference.png')?.length)) {
        throw new Error('Screenshot preview is missing its entry page or reference image');
      }
      return { result: undefined, output: `Проверени са ${stored.length} запазени файла${previewPath ? ` и входната страница ${previewPath}` : ''}.` };
    });

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
