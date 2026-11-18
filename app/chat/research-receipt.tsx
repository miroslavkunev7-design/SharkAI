'use client';

import { Download, ExternalLink, FileText, Globe2, LoaderCircle, RotateCcw, Square } from 'lucide-react';
import { safeLink, type InspectorItem } from './workspace-types';
import { CHAT_JOB_STATUS, useChatJob, type ChatJobStatus } from './use-chat-job';

interface ResearchJob {
  id: string;
  topic: string;
  status: ChatJobStatus;
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

export function ResearchReceipt({ id, label, open }: { id: string; label: string; open: (item: InspectorItem) => void }) {
  const endpoint = `/api/chat/research/${encodeURIComponent(id)}`;
  const { job, problem, actionError, action, refresh, update } = useChatJob<ResearchJob>(endpoint, 'Статусът на проучването не може да се зареди.');

  const active = job?.status === 'QUEUED' || job?.status === 'RUNNING';
  const retryable = job?.status === 'FAILED' || job?.status === 'CANCELLED';
  const downloadUrl = job?.status === 'COMPLETED' && job.downloadUrl === `${endpoint}/report` ? job.downloadUrl : null;

  return (
    <section className="shark-chat-receipt shark-chat-research" aria-label={label}>
      <div className="shark-chat-receipt-head ice-section" data-ice-art="agent"><Globe2 size={17} /><strong>{label}</strong><span aria-live="polite">{job ? CHAT_JOB_STATUS[job.status] : 'Зареждане…'}</span></div>
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
        {problem && <button type="button" disabled={!!action} onClick={refresh}><RotateCcw size={15} /> Обнови статуса</button>}
        {downloadUrl && <>
          <button type="button" onClick={() => open({ type: 'text', url: downloadUrl, title: 'Доклад.md' })}><FileText size={15} /> Преглед на доклада</button>
          <a href={downloadUrl} download><Download size={15} /> Изтегли доклада</a>
        </>}
      </footer>
    </section>
  );
}
