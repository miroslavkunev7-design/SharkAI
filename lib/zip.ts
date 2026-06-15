import { ZipArchive } from 'archiver';
import fs from 'fs';
import path from 'path';
import { getProjectDir } from './project-files';

function addDirToArchive(archive: ZipArchive, dirPath: string, zipPath: string) {
  if (!fs.existsSync(dirPath)) return;
  for (const item of fs.readdirSync(dirPath)) {
    const full = path.join(dirPath, item);
    const zipItem = zipPath ? `${zipPath}/${item}` : item;
    if (item === 'manifest.json') continue;
    if (fs.statSync(full).isDirectory()) {
      addDirToArchive(archive, full, zipItem);
    } else {
      archive.file(full, { name: zipItem });
    }
  }
}

export async function createProjectZip(projectId: string, projectName: string): Promise<Buffer> {
  const root = getProjectDir(projectId);
  if (!fs.existsSync(root)) throw new Error('No project files');

  const folderName = projectName.replace(/[^a-z0-9-_]/gi, '-').slice(0, 40) || 'sharkai-project';

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const archive = new ZipArchive({ zlib: { level: 9 } });

    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);

    addDirToArchive(archive, root, folderName);
    archive.finalize();
  });
}
