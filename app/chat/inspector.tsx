'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Download, ExternalLink, LoaderCircle, MessageSquare, X } from 'lucide-react';
import { projectInProgress, PROJECT_STATUS, type InspectorItem, type Project } from './workspace-types';

interface ProjectDetails {
  project: Project & { description?: string };
  fileCount: number;
  previewUrl: string | null;
  downloadUrl: string | null;
}

function ProjectInspector({ id, talk }: { id: string; talk?: (project: string) => void }) {
  const [details, setDetails] = useState<ProjectDetails | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    async function load() {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
          cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok) throw new Error(response.status === 404 ? 'Проектът не е достъпен.' : 'Статусът на проекта не може да се зареди.');
        const data = await response.json() as ProjectDetails;
        if (controller.signal.aborted) return;
        setDetails(data);
        setError('');
        if (projectInProgress(data.project.status)) {
          timeout = setTimeout(load, 2500);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Връзката с проекта прекъсна.');
      }
    }

    void load();
    return () => { controller.abort(); clearTimeout(timeout); };
  }, [id, retry]);

  const done = details?.project.status === 'COMPLETED';
  return (
    <>
      {!details && !error && <p className="shark-chat-status" role="status"><LoaderCircle className="shark-chat-spinner" size={16} /> Зареждане на проекта…</p>}
      {details && (
        <div className="shark-chat-inspector-card">
          <strong>{details.project.name}</strong>
          <span role="status">{PROJECT_STATUS[details.project.status] || details.project.status}</span>
          {details.project.description && <p>{details.project.description}</p>}
          {done && <span>Файлове · {details.fileCount}</span>}
          {details.project.status === 'FAILED' && <p>Изпълнението е неуспешно. Подробностите за проекта са в Студио.</p>}
        </div>
      )}
      {error && <div className="shark-chat-notice" role="alert">{error} <button type="button" onClick={() => { setError(''); setRetry((value) => value + 1); }}>Опитай отново</button></div>}
      <div className="shark-chat-inspector-links">
        {details && talk && <button type="button" onClick={() => talk(id)}><MessageSquare size={16} /> Обсъди проекта</button>}
        <Link href={`/dashboard?project=${encodeURIComponent(id)}`}><ExternalLink size={16} /> Отвори в Студио</Link>
        {done && details?.previewUrl && <button type="button" aria-expanded={showPreview} onClick={() => setShowPreview((shown) => !shown)}>{showPreview ? 'Затвори прегледа' : 'Преглед'}</button>}
        {done && details?.downloadUrl && <a href={details.downloadUrl}><Download size={16} /> Изтегли ZIP</a>}
      </div>
      {showPreview && done && details?.previewUrl && (
        <iframe title={`Преглед на ${details.project.name}`} className="shark-chat-project-frame" src={details.previewUrl} sandbox="allow-scripts" />
      )}
    </>
  );
}

export function Inspector({ item, close, talk }: { item: InspectorItem; close: () => void; talk?: (project: string) => void }) {
  return (
    <aside className="shark-chat-inspector" aria-label={item.title}>
      <header>
        <h2>{item.title}</h2>
        <button className="shark-chat-icon" type="button" aria-label="Затвори прегледа" onClick={close}><X size={19} /></button>
      </header>
      {item.type === 'project' ? <ProjectInspector key={item.id} id={item.id} talk={talk} /> : (
        <>
          <img className="shark-chat-inspector-image" src={item.url} alt={item.title} />
          <div className="shark-chat-inspector-links">
            <a href={item.url} download><Download size={16} /> Изтегли</a>
          </div>
        </>
      )}
    </aside>
  );
}
