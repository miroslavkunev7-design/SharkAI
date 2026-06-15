import fs from 'fs';
import path from 'path';

export interface InstallerInfo {
  source: 'local' | 'external';
  name: string;
  size?: number;
  url: string;
}

export function getInstallerInfo(): InstallerInfo | null {
  const external = process.env.INSTALLER_DOWNLOAD_URL?.trim();
  if (external) {
    const name = process.env.INSTALLER_FILENAME?.trim() || 'SharkAI-Setup.exe';
    const sizeMb = process.env.INSTALLER_SIZE_MB?.trim();
    return {
      source: 'external',
      name,
      size: sizeMb ? Number(sizeMb) * 1_000_000 : undefined,
      url: external,
    };
  }

  const releaseDir = path.join(process.cwd(), 'release');
  if (!fs.existsSync(releaseDir)) return null;

  const name = fs.readdirSync(releaseDir).find((f) => f.endsWith('.exe') && /setup/i.test(f));
  if (!name) return null;

  const size = fs.statSync(path.join(releaseDir, name)).size;
  return {
    source: 'local',
    name,
    size,
    url: '/api/download/installer',
  };
}
