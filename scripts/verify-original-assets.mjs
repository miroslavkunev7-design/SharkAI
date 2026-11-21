#!/usr/bin/env node
/** Verify original approved graphic assets by SHA256, never generate substitutes. */
import { readFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const scriptRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const index = args.indexOf('--root');
const root = resolve(index >= 0 && args[index + 1] ? args[index + 1] : process.cwd());
const manifestFile = join(scriptRoot, 'assets-sha256.json');
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
const verified = [], missing = [], altered = [];
const rootReal = realpathSync(root);

for (const [relativePath, expected] of Object.entries(manifest)) {
  const sharedArtwork = /^public\/sharkai\/(wallet|chat)\/[\w-]+\.webp$/;
  const archiveArtwork = /^public\/wallet-original\/(?:image-\d{2}\.(?:png|jpg)|original-font-[12]\.ttf|reference-avatar\.png)$/;
  if (!sharedArtwork.test(relativePath) && !archiveArtwork.test(relativePath)) {
    throw new Error('Unsafe manifest path');
  }
  const file = resolve(root, relativePath);
  if (!file.startsWith(root + sep)) throw new Error('Path escapes project root');
  if (!existsSync(file)) { missing.push(relativePath); continue; }
  if (lstatSync(file).isSymbolicLink()) { altered.push(relativePath); continue; }
  if (!realpathSync(file).startsWith(rootReal + sep)) { altered.push(relativePath); continue; }
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (actual === expected) verified.push(relativePath);
  else altered.push(relativePath);
}
const result = { checked: Object.keys(manifest).length, verified: verified.length, missing, altered,
  status: missing.length || altered.length ? 'BLOCKED' : 'READY' };
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'READY') process.exitCode = 1;
