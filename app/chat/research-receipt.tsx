'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, FileText, Globe2, LoaderCircle, RotateCcw, Square } from 'lucide-react';
import { safeLink, type InspectorItem } from './workspace-types';

interface ResearchJob {
  id: string;
  topic: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  stage: number;
  totalStages: number;
  stageLabel: string;
  updatedAt: string;
  error?: string;
  summary?: string;
  warnings: string[];
  sources: { title: string; url: string }[];
  downloadUrl: string | null;
}

const STATUS: Record<ResearchJob['status'], string> = {
  QUEUED: 'В опашката', RUNNING: 'В ход', COMPLETED: 'Завършено', FAILED: 'Неуспешно', CANCELLED: 'Отменено',
};

async function fetchJob(url: string, options?: RequestInit) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.job) throw new Error(data?.error || 'Статусът на проучването не може да се зареди.');
  return data.job as ResearchJob;
}

export function ResearchReceipt({ id, label, open }: { id: string; label: string; open: (item: InspectorItem) => void }) {
  const [job, setJob] = useState<ResearchJob | null>(null);
  const [problem, setProblem] = useState('');
  const [actionError, setActionError] = useState('');
  const [action, setAction] = useState<'cancel' | 'retry' | null>(null);
  const [refresh, setRefresh] = useState(0);
  const sequence = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  const endpoint = `/api/chat/research/${encodeURIComponent(id)}`;

  useEffect(() => () => inFlight.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();
    const version = sequence.current;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const latest = await fetchJob(endpoint, { signal: controller.signal });
        if (controller.signal.aborted || version !== sequence.current) return;
        setJob(latest);
        setProblem('');
        if (latest.status === 'QUEUED' || latest.status === 'RUNNING') timer = setTimeout(poll, 2400);
      } catch (cause) {
        if (controller.signal.aborted || version !== sequence.current) return;
        setProblem(cause instanceof Error ? cause.message : 'Връзката с проучването прекъсна.');
      }
    }

    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [endpoint, refresh]);

  async function update(next: 'cancel' | 'retry') {
    if (inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    sequence.current += 1;
    setAction(next);
    setActionError('');
    try {
      const latest = await fetchJob(endpoint, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: next }), signal: controller.signal,
      });
      if (!controller.signal.aborted) setJob(latest);
    } catch (cause) {
      if (!controller.signal.aborted) setActionError(cause instanceof Error ? cause.message : 'Действието не успя.');
    } finally {
      inFlight.current = null;
      if (!controller.signal.aborted) {
        setAction(null);
        setRefresh((value) => value + 1);
      }
    }
  }

  const active = job?.status === 'QUEUED' || job?.status === 'RUNNING';
  const retryable = job?.status === 'FAILED' || job?.status === 'CANCELLED';
  const downloadUrl = job?.status === 'COMPLETED' && job.downloadUrl === `${endpoint}/report` ? job.downloadUrl : null;

  return (
    <section className="shark-chat-receipt shark-chat-research" aria-label={label}>
      <div className="shark-chat-receipt-head ice-section" data-ice-art="agent"><Globe2 size={17} /><strong>{label}</strong><span aria-live="polite">{job ? STATUS[job.status] : 'Зареждане…'}</span></div>
      {job && <>
        <p className="shark-chat-research-topic">{job.topic}</p>
        <section className="shark-chat-research-progress" aria-label="Напредък на проучването">
          <div><span aria-live="polite">{job.stageLabel}</span><span>{job.stage} / {job.totalStages}</span></div>
          <progress aria-label="Изпълнени стъпки" max={job.totalStages} value={job.stage} />
        </section>
        {job.summary && <p className="shark-chat-message-text">{job.summary}</p>}
        {job.error && <p className="shark-chat-notice" role="alert">{job.error}</p>}
        {!!job.warnings.length && <ul className="shark-chat-research-warnings">{job.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul>}
        {!!job.sources.length && <details className="shark-chat-research-sources">
          <summary>Източници · {job.sources.length}</summary>
          <ol>{job.sources.map(source => {
            const href = safeLink(source.url);
            return href ? <li key={source.url}><a href={href} target="_blank" rel="noreferrer">{source.title} <ExternalLink size={12} /></a></li> : null;
          })}</ol>
        </details>}
      </>}
      {problem && <p className="shark-chat-notice" role="alert">{problem}</p>}
      {actionError && <p className="shark-chat-notice" role="alert">{actionError}</p>}
      <footer className="shark-chat-result-actions">
        {active && <button type="button" disabled={!!action} onClick={() => void update('cancel')}>{action === 'cancel' ? <LoaderCircle className="shark-chat-spinner" size={15} /> : <Square size={15} />} Отмени проучването</button>}
        {retryable && <button type="button" disabled={!!action} onClick={() => void update('retry')}>{action === 'retry' ? <LoaderCircle className="shark-chat-spinner" size={15} /> : <RotateCcw size={15} />} Повтори проучването</button>}
        {problem && <button type="button" disabled={!!action} onClick={() => { setProblem(''); setRefresh((value) => value + 1); }}><RotateCcw size={15} /> Обнови статуса</button>}
        {downloadUrl && <>
          <button type="button" onClick={() => open({ type: 'text', url: downloadUrl, title: 'Доклад.md' })}><FileText size={15} /> Преглед на доклада</button>
          <a href={downloadUrl} download><Download size={15} /> Изтегли доклада</a>
        </>}
      </footer>
    </section>
  );
}
