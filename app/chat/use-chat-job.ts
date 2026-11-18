'use client';

import { useEffect, useRef, useState } from 'react';

export type ChatJobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
type JobAction = 'cancel' | 'retry';
const POLL_INTERVAL = 2400;
const MAX_RETRY_INTERVAL = 20_000;

export const CHAT_JOB_STATUS: Record<ChatJobStatus, string> = {
  QUEUED: 'В опашката', RUNNING: 'В ход', COMPLETED: 'Завършено', FAILED: 'Неуспешно', CANCELLED: 'Отменено',
};

function isActive(status?: ChatJobStatus) {
  return status === 'QUEUED' || status === 'RUNNING';
}

class ChatJobRequestError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

export function useChatJob<Job extends { status: ChatJobStatus }>(endpoint: string, loadError: string, method: 'PATCH' | 'POST' = 'PATCH') {
  const [job, setJob] = useState<Job | null>(null);
  const [problem, setProblem] = useState('');
  const [actionError, setActionError] = useState('');
  const [action, setAction] = useState<JobAction | null>(null);
  const [reload, setReload] = useState(0);
  const sequence = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  const observedStatus = useRef<{ endpoint: string; status: ChatJobStatus } | null>(null);

  useEffect(() => () => inFlight.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();
    const version = sequence.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryInterval = POLL_INTERVAL;

    async function poll() {
      if (controller.signal.aborted || version !== sequence.current) return;
      try {
        const latest = await fetchChatJob<Job>(endpoint, loadError, { signal: controller.signal });
        if (controller.signal.aborted || version !== sequence.current) return;
        observedStatus.current = { endpoint, status: latest.status };
        setJob(latest);
        setProblem('');
        retryInterval = POLL_INTERVAL;
        if (isActive(latest.status)) timer = setTimeout(poll, POLL_INTERVAL);
      } catch (cause) {
        if (controller.signal.aborted || version !== sequence.current) return;
        setProblem(cause instanceof Error ? cause.message : loadError);
        const observed = observedStatus.current;
        if (cause instanceof ChatJobRequestError && cause.retryable && observed?.endpoint === endpoint && isActive(observed.status)) {
          timer = setTimeout(poll, retryInterval);
          retryInterval = Math.min(retryInterval * 2, MAX_RETRY_INTERVAL);
        }
      }
    }

    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [endpoint, loadError, reload]);

  function refresh() {
    setProblem('');
    setReload((value) => value + 1);
  }

  async function update(next: JobAction) {
    if (inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    sequence.current += 1;
    setAction(next);
    setActionError('');
    try {
      const latest = await fetchChatJob<Job>(endpoint, 'Действието не успя.', {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: next }), signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        observedStatus.current = { endpoint, status: latest.status };
        setJob(latest);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setActionError(cause instanceof Error ? cause.message : 'Действието не успя.');
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
      if (!controller.signal.aborted) { setAction(null); refresh(); }
    }
  }

  return { job, problem, actionError, action, refresh, update };
}

async function fetchChatJob<Job>(url: string, fallback: string, options?: RequestInit) {
  const response = await fetch(url, { cache: 'no-store', ...options }).catch(() => {
    throw new ChatJobRequestError(fallback, true);
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.job) throw new ChatJobRequestError(data?.error || fallback, response.status === 429 || response.status >= 500);
  return data.job as Job;
}
