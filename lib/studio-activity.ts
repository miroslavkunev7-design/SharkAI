// The normal Studio request has a 120-second runtime. Allow some time for the final database write.
const STUDIO_STATUS_WINDOW_MS = 130_000;
export const TRACKED_STUDIO_RUNS = 'tracked';

export type AgentRunActivity = 'running' | 'completed' | 'failed' | 'unknown';

export function studioStatusCutoff(now = Date.now()) {
  return new Date(now - STUDIO_STATUS_WINDOW_MS);
}

export function isTerminalStudioStatus(status: string) {
  return status === 'COMPLETED' || status === 'FAILED';
}

export function studioStatusUnknown(status: string, updatedAt: Date, now = Date.now()) {
  return !isTerminalStudioStatus(status) && updatedAt < studioStatusCutoff(now);
}

export function describeAgentRunActivity(status: string, startedAt: Date, projectStatus: string, now = Date.now()): AgentRunActivity {
  if (status === 'completed' || status === 'failed') return status;
  if (status === 'running' && !isTerminalStudioStatus(projectStatus) && startedAt >= studioStatusCutoff(now)) return 'running';
  return 'unknown';
}
