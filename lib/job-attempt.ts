type JobIdentity = { id: string; userId: string; runnerId: string | null };

// A lease stores <attempt>:<runner>. Older rows may have a single runner ID
// or no ID. Preserve that identity until a retry starts a different attempt.
export function jobAttemptId(job: JobIdentity) {
  return job.runnerId?.split(':', 1)[0] ?? job.id;
}

export function sameJobAttempt(job: JobIdentity, attemptId: string) {
  return {
    id: job.id, userId: job.userId,
    OR: [
      { runnerId: attemptId }, { runnerId: { startsWith: `${attemptId}:` } },
      ...(attemptId === job.id ? [{ runnerId: null }] : []),
    ],
  };
}
