'use client';

import { useEffect, useRef, useState } from 'react';

export type ChatJobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
type JobAction = 'cancel' | 'retry';

export const CHAT_JOB_STATUS: Record<ChatJobStatus, string> = {
  QUEUED: 'В опашката', RUNNING: 'В ход', COMPLETED: 'Завършено', FAILED: 'Неуспешно', CANCELLED: 'Отменено',
};

export function useChatJob<Job extends { status: ChatJobStatus }>(endpoint: string, loadError: string, method: 'PATCH' | 'POST' = 'PATCH') {
  const [job, setJob] = useState<Job | null>(null);
  const [problem, setProblem] = useState('');
  const [actionError, setActionError] = useState('');
  const [action, setAction] = useState<JobAction | null>(null);
  const [reload, setReload] = useState(0);
  const sequence = useRef(0);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => () => inFlight.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();
    const version = sequence.current;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const latest = await fetchChatJob<Job>(endpoint, loadError, { signal: controller.signal });
        if (controller.signal.aborted || version !== sequence.current) return;
        setJob(latest);
        setProblem('');
        if (latest.status === 'QUEUED' || latest.status === 'RUNNING') timer = setTimeout(poll, 2400);
      } catch (cause) {
        if (!controller.signal.aborted && version === sequence.current) {
          setProblem(cause instanceof Error ? cause.message : loadError);
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
      if (!controller.signal.aborted) setJob(latest);
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
  const response = await fetch(url, { cache: 'no-store', ...options });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.job) throw new Error(data?.error || fallback);
  return data.job as Job;
}
