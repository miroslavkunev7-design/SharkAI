import { readZipEntries as readEntries } from './bounded-zip.mjs';

export interface ZipLimits {
  select?: (name: string) => boolean;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  maxEntries?: number;
  signal?: AbortSignal;
}

export function readZipEntries(buffer: Buffer, limits?: ZipLimits): Promise<Map<string, Buffer>> {
  return readEntries(buffer, limits);
}
