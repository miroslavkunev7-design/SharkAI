'use client';

import type { ChatToolResult } from '@/lib/chat-tools';
import { Download, ExternalLink, FileText, Paperclip, Pencil, Sparkles } from 'lucide-react';
import { ResearchReceipt } from './research-receipt';
import { artifactAttachment, artifactDownloadUrl, isTextArtifact, PROJECT_STATUS, safeLink, type Attachment, type InspectorItem } from './workspace-types';

interface ReceiptProps {
  result: ChatToolResult;
  open: (item: InspectorItem) => void;
  reuse: (attachment: Attachment, edit: boolean) => void;
  editable: (attachment: Attachment) => boolean;
  disabled: boolean;
  projectStatus?: string;
}

export function ToolReceipt({ result, open, reuse, editable, disabled, projectStatus }: ReceiptProps) {
  if (result.researchId) return <ResearchReceipt id={result.researchId} label={result.label} open={open} />;
  const url = result.url ? safeLink(result.url) : null;
  const artifact = result.artifact;
  const artifactUrl = artifact ? safeLink(artifact.url) : null;
  const attached = artifactAttachment(result);
  const projectId = result.projectId;
  const isImage = !!artifact?.mimeType.startsWith('image/');
  const isText = !!artifact && isTextArtifact(artifact.mimeType);
  const title = attached?.name || result.label;

  return (
    <div className="shark-chat-receipt">
      <div><Sparkles size={16} /><strong>{result.label}</strong><span>{projectStatus ? PROJECT_STATUS[projectStatus] || projectStatus : result.status === 'started' ? 'Стартиран' : 'Завършен'}</span></div>
      {projectId && <button type="button" onClick={() => open({ type: 'project', id: projectId, title: result.label })}>Виж статуса <ExternalLink size={15} /></button>}
      {artifactUrl && isImage && (
        <button type="button" className="shark-chat-image" onClick={() => open({ type: 'image', url: artifactUrl, title })}>
          <img src={artifactUrl} alt={title} />
        </button>
      )}
      {artifactUrl && attached && <p className="shark-chat-artifact-name"><FileText size={15} />{attached.name}</p>}
      {artifactUrl && <footer className="shark-chat-result-actions">
        {isText && <button type="button" onClick={() => open({ type: 'text', url: artifactUrl, title, attachment: attached || undefined })}><FileText size={15} /> Преглед на файла</button>}
        <a href={artifactDownloadUrl(artifactUrl, attached || undefined)} download={attached?.name || true}><Download size={15} /> Изтегли резултата</a>
        {attached && (editable(attached)
          ? <button type="button" disabled={disabled} onClick={() => reuse(attached, true)}><Pencil size={15} /> Редактирай резултата</button>
          : <button type="button" disabled={disabled} onClick={() => reuse(attached, false)}><Paperclip size={15} /> Прикачи резултата</button>)}
      </footer>}
      {url && !projectId && !artifactUrl && <a href={url} target="_blank" rel="noreferrer">Отвори резултата <ExternalLink size={15} /></a>}
      {!!result.sources?.length && <ol>{result.sources.map((source, index) => {
        const href = safeLink(source.url);
        return href ? <li key={`${source.url}-${index}`}><a href={href} target="_blank" rel="noreferrer">{source.title || href} <ExternalLink size={12} /></a></li> : null;
      })}</ol>}
    </div>
  );
}
