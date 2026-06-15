import fs from 'fs';
import path from 'path';

const QUOTA_FILE = path.join(process.cwd(), '.quota-exceeded');

export function isQuotaExceeded(): boolean {
  return fs.existsSync(QUOTA_FILE);
}

export function markQuotaExceeded() {
  try { fs.writeFileSync(QUOTA_FILE, new Date().toISOString()); } catch { /* */ }
}

export function isQuotaError(message: string) {
  return /quota|billing|insufficient|exceeded/i.test(message);
}
