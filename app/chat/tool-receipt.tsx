'use client';

import type { ChatToolResult } from '@/lib/chat-tools';
import { AudioLines, Bell, Download, ExternalLink, FileText, Image as ImageIcon, LoaderCircle, Paperclip, Pencil, RotateCcw, Sparkles, Square } from 'lucide-react';
import { formatReminderTime, reminderStatus, type Reminder } from './reminders';
import { ResearchReceipt } from './research-receipt';
import { CHAT_JOB_STATUS, useChatJob, type ChatJobStatus } from './use-chat-job';
import { artifactAttachment, artifactDownloadUrl, attachmentInspection, isTextArtifact, safeLink, type Attachment, type InspectorItem } from './workspace-types';

interface ReceiptProps {
  result: ChatToolResult;
  open: (item: InspectorItem) => void;
  reuse: (attachment: Attachment, edit: boolean) => void;
  editable: (attachment: Attachment) => boolean;
  disabled: boolean;
  projectStatus?: string;
  reminder?: Reminder;
  reminderDue?: boolean;
}

type ArtifactProps = Pick<ReceiptProps, 'result' | 'open' | 'reuse' | 'editable' | 'disabled'>;

interface ImageJob {
  status: ChatJobStatus;
  phaseLabel: string;
  error: string | null;
  retryable: boolean;
  artifact: ChatToolResult['artifact'] | null;
  nextAttemptAt: string | null;
}

function ImageJobReceipt({ id, ...props }: ArtifactProps & { id: string }) {
  const { result } = props;
  const endpoint = `/api/chat/images/${encodeURIComponent(id)}`;
  const { job, problem, actionError, action, refresh, update } = useChatJob<ImageJob>(endpoint, 'Статусът на задачата за изображение не може да се зареди.', 'POST');
  const active = job?.status === 'QUEUED' || job?.status === 'RUNNING';
  const retryable = job?.retryable && (job.status === 'FAILED' || job.status === 'CANCELLED');
  const completed = job ? job.status === 'COMPLETED' : result.status === 'completed';
  const artifact = completed ? job?.artifact ?? result.artifact : undefined;
  const saved = artifact?.mimeType.startsWith('image/') ? artifactAttachment({ ...result, artifact }) : null;
  const status = completed && !saved ? 'Файлът е недостъпен' : job ? CHAT_JOB_STATUS[job.status] : completed ? 'Завършено' : 'Проверка на статуса…';
  const nextAttempt = job?.status === 'QUEUED' && job.nextAttemptAt ? new Date(job.nextAttemptAt) : null;

  return (
    <section className="shark-chat-receipt shark-chat-image-job" aria-label={result.label}>
      <div className="shark-chat-receipt-head ice-section" data-ice-art="studio">
        <ImageIcon size={17} /><strong>{result.label}</strong><span aria-live="polite">{status}</span>
      </div>
      {job?.phaseLabel && job.phaseLabel !== status && <p className="shark-chat-status">{job.phaseLabel}</p>}
      {nextAttempt && Number.isFinite(nextAttempt.getTime()) && <p className="shark-chat-status">Следващ опит · <time dateTime={nextAttempt.toISOString()}>{nextAttempt.toLocaleString('bg-BG')}</time></p>}
      {job?.error && <p className="shark-chat-notice" role="alert">{job.error}</p>}
      {problem && <p className="shark-chat-notice" role="alert">{problem}</p>}
      {actionError && <p className="shark-chat-notice" role="alert">{actionError}</p>}
      {saved && <ArtifactFields {...props} result={{ ...result, artifact }} />}
      {(active || retryable || problem || (completed && !saved)) && <footer className="shark-chat-result-actions">
        {active && <button type="button" disabled={!!action} onClick={() => void update('cancel')}>
          {action === 'cancel' ? <LoaderCircle className="shark-chat-spinner" size={15} /> : <Square size={15} />} Отмени задачата
        </button>}
        {retryable && <button type="button" disabled={!!action} onClick={() => void update('retry')}>
          {action === 'retry' ? <LoaderCircle className="shark-chat-spinner" size={15} /> : <RotateCcw size={15} />} Повтори задачата
        </button>}
        {(problem || (completed && !saved)) && <button type="button" disabled={!!action} onClick={refresh}><RotateCcw size={15} /> Обнови статуса</button>}
      </footer>}
    </section>
  );
}

function ArtifactFields({ result, open, reuse, editable, disabled }: ArtifactProps) {
  const artifact = result.artifact;
  const url = artifact ? safeLink(artifact.url) : null;
  if (!artifact || !url) return null;
  const attached = artifactAttachment(result);
  const title = attached?.name || result.label;
  const preview = attached ? attachmentInspection(attached) : null;

  return (
    <>
      {artifact.mimeType.startsWith('image/') && <button type="button" className="shark-chat-image" onClick={() => open({ type: 'image', url, title, attachment: attached || undefined })}>
        <img src={url} alt={title} />
      </button>}
      {attached && <p className="shark-chat-artifact-name">{preview?.type === 'audio' ? <AudioLines size={15} /> : <FileText size={15} />}{attached.name}</p>}
      <footer className="shark-chat-result-actions">
        {isTextArtifact(artifact.mimeType) && <button type="button" onClick={() => open({ type: 'text', url, title, attachment: attached || undefined })}><FileText size={15} /> Преглед на файла</button>}
        {preview?.type === 'audio' && <button type="button" onClick={() => open(preview)}><AudioLines size={15} /> Прослушай записа</button>}
        <a href={artifactDownloadUrl(url, attached || undefined)} download={attached?.name || true}><Download size={15} /> Изтегли резултата</a>
        {attached && <button type="button" disabled={disabled} onClick={() => reuse(attached, false)}><Paperclip size={15} /> Прикачи резултата</button>}
        {attached && editable(attached) && <button type="button" disabled={disabled} onClick={() => reuse(attached, true)}><Pencil size={15} /> Редактирай резултата</button>}
      </footer>
    </>
  );
}

export function ToolReceipt({ projectStatus, reminder, reminderDue, ...props }: ReceiptProps) {
  const { result, open } = props;
  if (result.imageJobId) return <ImageJobReceipt key={result.imageJobId} id={result.imageJobId} {...props} />;

  if (result.reminderId) return (
    <div className="shark-chat-receipt">
      <div className="shark-chat-receipt-head ice-section" data-ice-art="team"><Bell size={16} /><strong>Напомняне</strong><span>{reminder ? reminderStatus(reminder, !!reminderDue) : 'Записано'}</span></div>
      {reminder?.nextAt && <p>{formatReminderTime(reminder.nextAt, reminder.timeZone)} · {reminder.timeZone}</p>}
      <button type="button" onClick={() => open({ type: 'reminders', title: 'Напомняния' })}>Виж напомнянията <ExternalLink size={15} /></button>
    </div>
  );
  if (result.researchId) return <ResearchReceipt id={result.researchId} label={result.label} open={open} />;
  const url = result.url ? safeLink(result.url) : null;
  const artifact = result.artifact;
  const artifactUrl = artifact ? safeLink(artifact.url) : null;
  const projectId = result.projectId;

  return (
    <div className="shark-chat-receipt">
      <div className="shark-chat-receipt-head ice-section" data-ice-art={projectId || artifact ? 'studio' : 'agent'}><Sparkles size={16} /><strong>{result.label}</strong><span>{projectStatus || (result.status === 'started' ? 'Стартиран' : 'Завършен')}</span></div>
      {projectId && <button type="button" onClick={() => open({ type: 'project', id: projectId, title: result.label })}>Виж статуса <ExternalLink size={15} /></button>}
      {artifactUrl && <ArtifactFields {...props} />}
      {url && !projectId && !artifactUrl && <a href={url} target="_blank" rel="noreferrer">Отвори резултата <ExternalLink size={15} /></a>}
      {!!result.sources?.length && <ol>{result.sources.map((source, index) => {
        const href = safeLink(source.url);
        return href ? <li key={`${source.url}-${index}`}><a href={href} target="_blank" rel="noreferrer">{source.title || href} <ExternalLink size={12} /></a></li> : null;
      })}</ol>}
    </div>
  );
}
