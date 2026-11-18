import { statSync } from 'node:fs';
import path from 'node:path';
import packageInfo from '../package.json';

export const installerFilename = `SharkAI-Setup-${packageInfo.version}.exe`;

export interface InstallerInfo {
  source: 'local' | 'external';
  name: string;
  size?: number;
  url: string;
}

export function getInstallerInfo(): InstallerInfo | null {
  const external = process.env.INSTALLER_DOWNLOAD_URL?.trim();
  if (external) {
    try {
      const url = new URL(external);
      if (url.protocol !== 'https:' || url.username || url.password || !url.pathname.endsWith(`/${installerFilename}`)) return null;
      const sizeMb = Number(process.env.INSTALLER_SIZE_MB);
      return {
        source: 'external',
        name: installerFilename,
        size: Number.isFinite(sizeMb) && sizeMb > 0 ? Math.round(sizeMb * 1_000_000) : undefined,
        url: url.href,
      };
    } catch {
      return null;
    }
  }

  const file = statSync(path.join(process.cwd(), 'release', installerFilename), { throwIfNoEntry: false });
  if (!file?.isFile() || file.size === 0) return null;
  return { source: 'local', name: installerFilename, size: file.size, url: '/api/download/installer' };
}
