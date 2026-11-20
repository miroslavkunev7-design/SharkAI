import { createHash } from 'node:crypto';

export function buildRevision() {
  return [process.env.VERCEL_GIT_COMMIT_SHA, process.env.SHARKAI_BUILD_REVISION]
    .map((value) => value?.trim().toLowerCase())
    .find((value) => value && /^[0-9a-f]{40}$/.test(value));
}

export function desktopWebRevision() {
  // Preview and production aliases can move even when two deployments share a Git commit.
  const deployment = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_URL;
  return deployment ? createHash('sha256').update(deployment).digest('hex') : buildRevision();
}
