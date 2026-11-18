import { ZipArchive } from 'archiver';
import { readAllProjectFiles } from './project-files';

export async function createProjectZip(projectId: string, projectName: string): Promise<Buffer> {
  const files = await readAllProjectFiles(projectId);
  if (!files.length) throw new Error('No project files');

  const folderName = projectName.replace(/[^a-z0-9-_]/gi, '-').slice(0, 40) || 'sharkai-project';

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const archive = new ZipArchive({ zlib: { level: 9 } });

    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);

    for (const file of files) archive.append(file.content, { name: `${folderName}/${file.path}` });
    void archive.finalize().catch(reject);
  });
}
