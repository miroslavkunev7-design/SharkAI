import fs from 'fs/promises';
import path from 'path';
import { getGeneratedDir } from './storage-paths';

export function getProjectDir(projectId: string) {
  return path.join(getGeneratedDir(), projectId);
}

export async function writeProjectFiles(
  projectId: string,
  files: Array<{ path: string; content: string }>
) {
  const root = getProjectDir(projectId);
  await fs.mkdir(root, { recursive: true });

  const written: string[] = [];

  for (const file of files) {
    if (file.content === '__BINARY_REFERENCE__') continue;
    const fullPath = path.join(root, file.path);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, file.content, 'utf-8');
    written.push(file.path);
  }

  const manifest = {
    projectId,
    fileCount: written.length,
    files: written,
    generatedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  return root;
}

export async function copyReferenceImage(projectId: string, sourceImagePath: string) {
  const dest = path.join(getProjectDir(projectId), 'public', 'assets', 'reference.png');
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(sourceImagePath, dest);

  const manifestPath = path.join(getProjectDir(projectId), 'manifest.json');
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw);
    if (!manifest.files.includes('public/assets/reference.png')) {
      manifest.files.push('public/assets/reference.png');
      manifest.fileCount = manifest.files.length;
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    }
  } catch { /* */ }
}

export async function readProjectManifest(projectId: string) {
  try {
    const raw = await fs.readFile(path.join(getProjectDir(projectId), 'manifest.json'), 'utf-8');
    return JSON.parse(raw) as { projectId: string; fileCount: number; files: string[]; generatedAt: string };
  } catch {
    return null;
  }
}

export async function readProjectFile(projectId: string, filePath: string) {
  const fullPath = path.join(getProjectDir(projectId), filePath);
  const normalized = path.normalize(fullPath);
  if (!normalized.startsWith(getProjectDir(projectId))) throw new Error('Invalid path');
  return fs.readFile(normalized, 'utf-8');
}

export async function listProjectFiles(projectId: string): Promise<string[]> {
  const manifest = await readProjectManifest(projectId);
  return manifest?.files ?? [];
}
