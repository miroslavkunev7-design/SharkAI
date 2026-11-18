'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Download, ExternalLink, LoaderCircle, MessageSquare, Pencil, Save, X } from 'lucide-react';
import { artifactDownloadUrl, CANVAS_CONTENT_LIMIT, CANVAS_MIME_TYPES, projectInProgress, projectStatusLabel, type Attachment, type InspectorItem, type Project } from './workspace-types';

import { ReminderPanel, type ReminderInput, type ReminderStore } from './reminders';

type SaveCanvas = (file: Attachment, content: string) => Promise<void>;

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
        if (projectInProgress(data.project)) {
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
          <span role="status">{projectStatusLabel(details.project)}</span>
          {details.project.description && <p>{details.project.description}</p>}
          {done && <span>Файлове · {details.fileCount}</span>}
          {details.project.status === 'FAILED' && <p>Изпълнението е неуспешно. Подробностите за проекта са в Студио.</p>}
        </div>
      )}
      {error && <div className="shark-chat-notice" role="alert">{error} <button type="button" onClick={() => { setError(''); setRetry((value) => value + 1); }}>Опитай отново</button></div>}
      <div className="shark-chat-inspector-links">
        {details?.project.statusUnknown && <button type="button" onClick={() => setRetry((value) => value + 1)}>Провери статуса</button>}
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

function TextInspector({ item, save, disabled }: { item: Extract<InspectorItem, { type: 'text' }>; save?: SaveCanvas; disabled?: boolean }) {
  const { url, attachment } = item;
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [value, setValue] = useState<string | null>(null);
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const lengthRef = useRef<HTMLParagraphElement>(null);
  const isEditable = !!save && !!attachment && CANVAS_MIME_TYPES.includes(attachment.mimeType || '');

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok || !response.body) throw new Error('Файлът не можа да се зареди.');
        const limit = 256 * 1024;
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
        let value = '';
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > limit) {
              await reader.cancel();
              throw new Error('Файлът е над 256 KB. Изтегли го за пълен преглед.');
            }
            value += decoder.decode(chunk.value, { stream: true });
          }
        } finally { reader.releaseLock(); }
        if (!controller.signal.aborted) setText(value + decoder.decode());
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Връзката с файла прекъсна.');
      }
    }
    void load();
    return () => controller.abort();
  }, [url]);

  if (error) return <p className="shark-chat-notice" role="alert">{error}</p>;
  if (text === null) return <p className="shark-chat-status" role="status"><LoaderCircle className="shark-chat-spinner" size={16} /> Зареждане на файла…</p>;
  if (value === null) return (
    <>
      {item.saved && <p className="shark-chat-status" role="status">Запазено е отделно копие в разговора.</p>}
      <pre className="shark-chat-text-preview">{text || 'Файлът е празен.'}</pre>
      {isEditable && <div className="shark-chat-inspector-links">
        <button type="button" disabled={disabled} onClick={() => { setValue(text); requestAnimationFrame(() => editRef.current?.focus()); }}><Pencil size={16} /> Редактирай в платното</button>
      </div>}
    </>
  );

  const tooLong = value.length > CANVAS_CONTENT_LIMIT;

  async function saveRevision(event: FormEvent) {
    event.preventDefault();
    if (!save || !attachment || value === null || value === text || disabled || saving) return;
    if (value.length > CANVAS_CONTENT_LIMIT) { lengthRef.current?.focus(); return; }
    if (!value.trim()) { setSaveError('Въведи съдържание за копието.'); return; }
    if (attachment.mimeType === 'application/json') {
      try { JSON.parse(value); }
      catch { setSaveError('Въведи валиден JSON.'); return; }
    }
    setSaving(true);
    setSaveError('');
    try { await save(attachment, value); }
    catch (cause) { setSaveError(cause instanceof Error ? cause.message : 'Копието не можа да се запази.'); }
    finally { setSaving(false); }
  }

  return (
    <form className="shark-chat-canvas" onSubmit={saveRevision} aria-busy={saving}>
      <label htmlFor="shark-chat-canvas-input">Съдържание на файла</label>
      <textarea id="shark-chat-canvas-input" ref={editRef} rows={12} value={value} disabled={saving} spellCheck={false} wrap="off"
        aria-describedby="shark-chat-canvas-length" aria-invalid={tooLong || !!saveError || undefined}
        onChange={(event) => { setValue(event.target.value); setSaveError(''); }} />
      <p id="shark-chat-canvas-length" ref={lengthRef} tabIndex={-1} className={tooLong ? 'shark-chat-notice' : 'shark-chat-status'}>
        {value.length} / {CANVAS_CONTENT_LIMIT} знака{tooLong ? ' · Съкрати текста, за да запазиш копието.' : ''}
      </p>
      {saveError && <p className="shark-chat-notice" role="alert">{saveError}</p>}
      <div className="shark-chat-inspector-links">
        <button type="submit" disabled={disabled || saving || !isEditable || value === text || tooLong}>
          {saving ? <LoaderCircle className="shark-chat-spinner" size={16} /> : <Save size={16} />} {saving ? 'Запазвам…' : 'Запази като копие'}
        </button>
        <button type="button" disabled={saving} onClick={() => { setValue(null); setSaveError(''); }}>Отмени</button>
      </div>
    </form>
  );
}

export function Inspector({ item, close, talk, save, disabled, reminders, createReminder }: {
  item: InspectorItem; close: () => void; talk?: (project: string) => void; save?: SaveCanvas; disabled?: boolean;
  reminders: ReminderStore; createReminder?: (input: ReminderInput) => Promise<void>;
}) {
  return (
    <aside className="shark-chat-inspector" aria-label={item.title}>
      <header>
        <h2>{item.title}</h2>
        <button className="shark-chat-icon" type="button" aria-label="Затвори прегледа" onClick={close}><X size={19} /></button>
      </header>
      {item.type === 'project' ? <ProjectInspector key={item.id} id={item.id} talk={talk} /> : item.type === 'reminders' ? (
        <ReminderPanel store={reminders} create={createReminder} writable={!disabled} />
      ) : (
        <>
          {item.type === 'text' ? <TextInspector key={item.url} item={item} save={save} disabled={disabled} /> : <img className="shark-chat-inspector-image" src={item.url} alt={item.title} />}
          <div className="shark-chat-inspector-links">
            <a href={artifactDownloadUrl(item.url, item.type === 'text' ? item.attachment : undefined)} download={item.title}><Download size={16} /> Изтегли</a>
          </div>
        </>
      )}
    </aside>
  );
}
