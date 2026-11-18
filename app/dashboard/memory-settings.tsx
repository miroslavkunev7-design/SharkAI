'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Brain, PencilLine, Plus, Trash2, X } from 'lucide-react';
import { MAX_MEMORY_NOTE_LENGTH, MAX_MEMORY_NOTES, type MemoryChange, type MemoryNote, type PersonalMemory } from '@/lib/personal-memory';

const endpoint = '/api/settings/memory';

export function MemorySettings() {
  const [memory, setMemory] = useState<PersonalMemory>();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [reload, setReload] = useState(0);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    const request = new AbortController();
    setLoading(true);
    void fetch(endpoint, { cache: 'no-store', signal: request.signal }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (!request.signal.aborted) setMemory(data);
    }).catch((err) => {
      if (!request.signal.aborted) setError(err instanceof Error && err.message ? err.message : 'Бележките не се заредиха.');
    }).finally(() => {
      if (!request.signal.aborted) setLoading(false);
    });
    return () => request.abort();
  }, [reload]);

  async function save(change: MemoryChange, success: string) {
    if (!memory || pending || loading) return false;
    setPending(true);
    setError('');
    setStatus('');
    try {
      const response = await fetch(endpoint, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...change, revision: memory.revision }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409) setReload((count) => count + 1);
        throw new Error(data.error);
      }
      setMemory(data);
      setStatus(success);
      return true;
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Промяната не можа да се запази.');
      return false;
    } finally {
      setPending(false);
    }
  }

  function edit(note?: MemoryNote) {
    setEditing(note?.id ?? null);
    setDraft(note?.text ?? '');
    setError('');
    setStatus('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    const saved = editing
      ? await save({ action: 'edit', id: editing, text }, 'Бележката е запазена.')
      : await save({ action: 'add', text }, 'Бележката е добавена.');
    if (saved) {
      setEditing(null);
      setDraft('');
    }
  }

  async function remove(id: string) {
    if (await save({ action: 'delete', id }, 'Бележката е изтрита.') && id === editing) {
      setEditing(null);
      setDraft('');
    }
  }

  async function clear() {
    if (await save({ action: 'clear' }, 'Всички лични бележки са изтрити.')) {
      setConfirmClear(false);
      setEditing(null);
      setDraft('');
    }
  }

  const busy = loading || pending;

  return (
    <section className="shark-glass module-panel module-memory" aria-labelledby="personal-memory-title">
      <div className="module-heading"><h2 id="personal-memory-title"><Brain size={20} /> Лични бележки</h2></div>
      <p>Запиши предпочитания за език, тон и формат. Когато са включени, асистентът ги използва в общите разговори за този акаунт.</p>
      {loading && <p role="status">Зареждане на личните бележки…</p>}
      {error && <p className="module-error" role="alert">{error}</p>}
      {status && <p className="module-memory-status" role="status">{status}</p>}
      {!memory && !loading && error && <button type="button" className="shark-action-secondary" onClick={() => { setError(''); setReload((count) => count + 1); }}>Опитай отново</button>}
      {memory && (
        <>
          <div className="module-memory-toggle">
            <span id="personal-memory-toggle-label">Използвай личните бележки в чата</span>
            <button type="button" role="switch" aria-labelledby="personal-memory-toggle-label" aria-checked={memory.enabled}
              className={memory.enabled ? 'shark-action' : 'shark-action-secondary'} disabled={busy}
              onClick={() => void save({ action: 'enable', enabled: !memory.enabled }, memory.enabled ? 'Личните бележки са изключени.' : 'Личните бележки са включени.')}>
              {memory.enabled ? 'Включени' : 'Изключени'}
            </button>
          </div>

          {memory.notes.length ? (
            <ul className="module-memory-notes" aria-label="Запазени лични бележки">
              {memory.notes.map((note) => (
                <li key={note.id}>
                  <p>{note.text}</p>
                  <div>
                    <button type="button" className="shark-action-secondary" disabled={busy} onClick={() => edit(note)}><PencilLine size={15} /> Редактирай</button>
                    <button type="button" className="shark-action-secondary" disabled={busy} onClick={() => void remove(note.id)}><Trash2 size={15} /> Изтрий</button>
                  </div>
                </li>
              ))}
            </ul>
          ) : <p>Няма запазени лични бележки.</p>}

          {(editing || (memory.enabled && memory.notes.length < MAX_MEMORY_NOTES)) && (
            <form className="module-form module-memory-form" onSubmit={submit}>
              <label>{editing ? 'Редакция на бележката' : 'Нова бележка'}
                <textarea rows={3} value={draft} maxLength={MAX_MEMORY_NOTE_LENGTH} disabled={busy}
                  aria-describedby="personal-memory-length" onChange={(event) => setDraft(event.target.value)}
                  placeholder="Например „Предпочитам отговори на български в кратки точки.“" required />
              </label>
              <div className="module-memory-form-actions">
                <small id="personal-memory-length">{draft.length} / {MAX_MEMORY_NOTE_LENGTH} знака</small>
                {editing && <button type="button" className="shark-action-secondary" onClick={() => edit()} disabled={busy}><X size={15} /> Отказ</button>}
                <button type="submit" className="shark-action" disabled={busy || !draft.trim()}>
                  {editing ? <PencilLine size={16} /> : <Plus size={16} />}
                  {editing ? 'Запази бележката' : 'Добави бележка'}
                </button>
              </div>
            </form>
          )}
          {memory.notes.length >= MAX_MEMORY_NOTES && <p>Достигнат е броят от {MAX_MEMORY_NOTES} лични бележки.</p>}

          {memory.notes.length > 0 && (
            <div className="module-memory-clear">
              {confirmClear ? (
                <div aria-label="Потвърждение за изтриване">
                  <p>Да се изтрият ли всички лични бележки?</p>
                  <div className="module-actions">
                    <button type="button" className="shark-action-secondary" disabled={busy} onClick={() => setConfirmClear(false)}>Запази бележките</button>
                    <button type="button" className="shark-action-secondary module-memory-danger" disabled={busy} onClick={() => void clear()}>Да, изтрий всички</button>
                  </div>
                </div>
              ) : (
                <button type="button" className="module-link module-memory-danger" disabled={busy} onClick={() => setConfirmClear(true)}><Trash2 size={15} /> Изчисти всички бележки</button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
