import path from 'path';
import os from 'os';

export function isVercel(): boolean {
  return process.env.VERCEL === '1';
}

export function useDbUploads(): boolean {
  return isVercel() || process.env.USE_DB_UPLOADS === 'true';
}

export function getUploadDir(): string {
  if (isVercel()) return path.join(os.tmpdir(), 'sharkai-uploads');
  return path.join(process.cwd(), 'uploads');
}

export function getGeneratedDir(): string {
  if (isVercel()) return path.join(os.tmpdir(), 'sharkai-generated');
  return path.join(process.cwd(), 'generated');
}
