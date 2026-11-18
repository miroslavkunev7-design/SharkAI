import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from './db';
import { getGeneratedDir } from './storage-paths';

interface ProjectManifest {
  projectId: string;
  fileCount: number;
  files: string[];
  generatedAt: string;
}

interface ProjectFile {
  path: string;
  content: string | Buffer;
}

type StoredFile = {
  path: string;
  base64: string;
};

function assertArtifactPath(filePath: string) {
  if (
    /[\\:\x00-\x1f]/.test(filePath) ||
    filePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) throw new Error('Invalid artifact path');
}

function getProjectDir(projectId: string) {
  return path.join(getGeneratedDir(), projectId);
}

export async function writeProjectFiles(projectId: string, input: ProjectFile[]) {
  const files = new Map<string, StoredFile>();
  for (const file of input) {
    if (file.content === '__BINARY_REFERENCE__') continue;
    assertArtifactPath(file.path);
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf-8');
    files.set(file.path, { path: file.path, base64: content.toString('base64') });
  }
  if (!files.size) throw new Error('Project contains no files');

  const manifest = {
    projectId,
    fileCount: files.size,
    files: [...files.keys()],
    generatedAt: new Date().toISOString(),
  };
  const data = { manifest, files: [...files.values()] };
  await prisma.projectArtifact.upsert({
    where: { projectId },
    create: { projectId, ...data },
    update: data,
  });
  return manifest;
}

export function getProjectPreviewPath(manifest: ProjectManifest | null): string | null {
  return ['public/index.html', 'index.html'].find((file) => manifest?.files.includes(file)) ?? null;
}

export async function readProjectManifest(projectId: string): Promise<ProjectManifest | null> {
  const stored = await prisma.projectArtifact.findUnique({ where: { projectId }, select: { manifest: true } });
  if (stored) return stored.manifest as unknown as ProjectManifest;

  try {
    const raw = await fs.readFile(path.join(getProjectDir(projectId), 'manifest.json'), 'utf-8');
    return JSON.parse(raw) as ProjectManifest;
  } catch {
    return null;
  }
}

export async function readProjectFileBytes(projectId: string, filePath: string): Promise<Buffer> {
  assertArtifactPath(filePath);
  const stored = await prisma.projectArtifact.findUnique({ where: { projectId }, select: { files: true } });
  if (stored) {
    const file = (stored.files as unknown as StoredFile[]).find((entry) => entry.path === filePath);
    if (!file) throw new Error('File not found');
    return Buffer.from(file.base64, 'base64');
  }

  return fs.readFile(path.join(getProjectDir(projectId), filePath));
}

export async function readProjectFile(projectId: string, filePath: string): Promise<string> {
  return (await readProjectFileBytes(projectId, filePath)).toString('utf-8');
}

export async function readAllProjectFiles(projectId: string): Promise<Array<{ path: string; content: Buffer }>> {
  const stored = await prisma.projectArtifact.findUnique({ where: { projectId }, select: { files: true } });
  if (stored) {
    return (stored.files as unknown as StoredFile[]).map((file) => ({
      path: file.path,
      content: Buffer.from(file.base64, 'base64'),
    }));
  }

  const manifest = await readProjectManifest(projectId);
  return Promise.all((manifest?.files ?? []).map(async (filePath) => {
    assertArtifactPath(filePath);
    return { path: filePath, content: await fs.readFile(path.join(getProjectDir(projectId), filePath)) };
  }));
}
