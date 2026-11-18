'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Bell, BellOff, Check, Clock3, LoaderCircle, RotateCcw, X } from 'lucide-react';
import { reminderInputSchema, type ReminderInput } from '@/lib/reminder-input';

type ReminderRepeat = ReminderInput['repeat'];
export type { ReminderInput } from '@/lib/reminder-input';
export type Reminder = ReminderInput & { id: string; nextAt: string | null; cancelledAt: string | null };
export type ReminderNotification = { id: string; reminderId: string; text: string; dueAt: string; timeZone: string };
type ReminderData = { reminders: Reminder[]; notifications: ReminderNotification[] };
type Action = 'cancel' | 'acknowledge';

const EMPTY: ReminderData = { reminders: [], notifications: [] };
const API = '/api/chat/reminders';
const REPEAT: Record<ReminderRepeat, string> = {
  NONE: 'Еднократно', DAILY: 'Всеки ден', WEEKLY: 'Всяка седмица', MONTHLY: 'Всеки месец',
};

function readStorage(key: string) {
  try { return localStorage.getItem(key); }
  catch { return null; }
}

function writeStorage(key: string, value: string) {
  try { localStorage.setItem(key, value); }
  catch { /* Browser storage is optional for in-app notifications. */ }
}

async function storageScope(identity: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `sharkai.reminders.${hash}`;
}

async function requestReminders(options?: RequestInit) {
  const response = await fetch(API, { cache: 'no-store', ...options });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error || 'Напомнянията са недостъпни.');
  return data;
}

export function useReminders(identity: string | null) {
  const [snapshot, setSnapshot] = useState<{ identity: string; data: ReminderData } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [device, setDevice] = useState<{ identity: string; key: string; enabled: boolean } | null>(null);
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [deliveryError, setDeliveryError] = useState('');
  const [permissionPending, setPermissionPending] = useState(false);
  const requestNumber = useRef(0);
  const delivered = useRef(new Set<string>());
  const data = snapshot?.identity === identity ? snapshot.data : EMPTY;
  const activeDevice = device?.identity === identity ? device : null;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!identity) return EMPTY;
    const request = ++requestNumber.current;
    try {
      const latest = await requestReminders({ signal }) as ReminderData;
      if (!Array.isArray(latest.reminders) || !Array.isArray(latest.notifications)) throw new Error('Сървърът не върна напомнянията.');
      if (!signal?.aborted && request === requestNumber.current) {
        setSnapshot({ identity, data: latest });
        setError('');
      }
      return latest;
    } catch (cause) {
      if (!signal?.aborted && request === requestNumber.current) {
        setError(cause instanceof Error ? cause.message : 'Напомнянията са недостъпни.');
      }
      return EMPTY;
    } finally {
      if (!signal?.aborted && request === requestNumber.current) setLoading(false);
    }
  }, [identity]);

  useEffect(() => {
    if (!identity) return;
    setLoading(true);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;

    async function poll() {
      if (running) return;
      clearTimeout(timer);
      running = true;
      const latest = await refresh(controller.signal);
      running = false;
      if (controller.signal.aborted) return;
      const now = Date.now();
      const next = latest.reminders.flatMap((reminder) => reminder.nextAt ? [Date.parse(reminder.nextAt)] : [])
        .filter((deadline) => Number.isFinite(deadline) && deadline > now);
      const delay = Math.max(1200, Math.min(15_000, ...next.map((deadline) => deadline - now + 100)));
      timer = setTimeout(poll, delay);
    }

    function resume() { if (document.visibilityState === 'visible') void poll(); }
    void poll();
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
    };
  }, [identity, refresh]);

  useEffect(() => {
    let active = true;
    delivered.current.clear();
    if (!identity || !window.isSecureContext || !('Notification' in window) || !crypto.subtle || /\bElectron\//.test(navigator.userAgent)) return;
    setPermission(Notification.permission);
    void storageScope(identity).then((key) => {
      if (active) setDevice({ identity, key, enabled: readStorage(`${key}.enabled`) === 'true' });
    }).catch(() => {});
    return () => { active = false; };
  }, [identity]);

  const deviceKey = activeDevice?.key;
  useEffect(() => {
    if (!deviceKey) return;
    function syncPermission() { setPermission(Notification.permission); }
    function syncPreference(event: StorageEvent) {
      if (event.key !== `${deviceKey}.enabled` && event.key !== null) return;
      setDevice((current) => current && current.key === deviceKey ? { ...current, enabled: event.newValue === 'true' } : current);
    }
    window.addEventListener('focus', syncPermission);
    window.addEventListener('storage', syncPreference);
    return () => {
      window.removeEventListener('focus', syncPermission);
      window.removeEventListener('storage', syncPreference);
    };
  }, [deviceKey]);

  useEffect(() => {
    if (!activeDevice?.enabled || permission !== 'granted' || Notification.permission !== 'granted'
      || readStorage(`${activeDevice.key}.enabled`) === 'false') return;
    const key = `${activeDevice.key}.delivered`;
    try {
      const seen = JSON.parse(readStorage(key) || '[]');
      if (Array.isArray(seen)) for (const id of seen) if (typeof id === 'string') delivered.current.add(id);
    } catch { /* Continue with this tab's delivery history. */ }
    for (const item of data.notifications) {
      if (delivered.current.has(item.id)) continue;
      try {
        new Notification('Напомняне от SharkAI', { body: item.text, tag: `sharkai-reminder-${item.id}`, icon: '/logo-icon.png' });
        delivered.current.add(item.id);
        writeStorage(key, JSON.stringify(Array.from(delivered.current).slice(-200)));
      } catch {
        setDeliveryError('Браузърът не може да показва системни известия от този прозорец. Напомнянията остават достъпни в чата.');
        writeStorage(`${activeDevice.key}.enabled`, 'false');
        setDevice({ ...activeDevice, enabled: false });
        return;
      }
    }
  }, [activeDevice, data.notifications, permission]);

  async function toggleNotifications() {
    if (!activeDevice || permissionPending) return;
    if (activeDevice.enabled) {
      writeStorage(`${activeDevice.key}.enabled`, 'false');
      setDevice({ ...activeDevice, enabled: false });
      setDeliveryError('');
      return;
    }
    setPermissionPending(true);
    setDeliveryError('');
    try {
      const granted = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      setPermission(granted);
      if (granted === 'granted') {
        writeStorage(`${activeDevice.key}.enabled`, 'true');
        setDevice({ ...activeDevice, enabled: true });
      }
    } catch { setDeliveryError('Разрешението за известия не може да се отвори в този браузър.'); }
    finally { setPermissionPending(false); }
  }

  async function mutate(action: Action, id: string) {
    await requestReminders({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, id }) });
    await refresh();
  }

  return { ...data, loading, error, refresh, mutate, activeDevice, permission, permissionPending, deliveryError, toggleNotifications };
}

export type ReminderStore = ReturnType<typeof useReminders>;

export function formatReminderTime(date: string, timeZone: string) {
  try { return new Intl.DateTimeFormat('bg-BG', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(date)); }
  catch { return date; }
}

export function reminderStatus(reminder: Reminder | undefined, due: boolean) {
  if (reminder?.cancelledAt) return 'Отменено';
  if (due) return 'За прочитане';
  return reminder?.nextAt ? 'Предстоящо' : 'Приключило';
}

export function ReminderPanel({ store, create, writable }: {
  store: ReminderStore; create?: (input: ReminderInput) => Promise<void>; writable: boolean;
}) {
  const [text, setText] = useState('');
  const [localTime, setLocalTime] = useState('');
  const [timeZone, setTimeZone] = useState('');
  const [repeat, setRepeat] = useState<ReminderRepeat>('NONE');
  const [problem, setProblem] = useState('');
  const [notice, setNotice] = useState('');
  const [op, setOp] = useState('');

  useEffect(() => setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!create || !writable || op) return;
    setNotice('');
    setProblem('');
    const parsed = reminderInputSchema.safeParse({ text, localTime, timeZone, repeat });
    if (!parsed.success) { setProblem('Провери текста, датата, часовата зона и повторението.'); return; }
    try { new Intl.DateTimeFormat('bg-BG', { timeZone: parsed.data.timeZone }).format(); }
    catch { setProblem('Въведи разпознаваема часова зона, например Europe/Sofia.'); return; }
    setOp('create');
    try {
      await create(parsed.data);
      setText('');
      setNotice('Напомнянето е записано.');
    } catch (cause) { setProblem(cause instanceof Error ? cause.message : 'Напомнянето не може да се запише.'); }
    finally { setOp(''); }
  }

  async function change(action: Action, id: string) {
    if (op) return;
    setProblem('');
    setNotice('');
    setOp(id);
    try { await store.mutate(action, id); }
    catch (cause) { setProblem(cause instanceof Error ? cause.message : 'Напомнянето не може да се обнови.'); }
    finally { setOp(''); }
  }

  return (
    <div className="shark-chat-reminders">
      <section aria-label="Непрочетени известия">
        <h3>Непрочетени известия</h3>
        {!store.loading && !store.error && !store.notifications.length && <p>Няма непрочетени известия.</p>}
        <ul>{store.notifications.map((item) => <li key={item.id}>
          <strong>{item.text}</strong><span>{formatReminderTime(item.dueAt, item.timeZone)} · {item.timeZone}</span>
          <button type="button" disabled={!!op} onClick={() => void change('acknowledge', item.id)}><Check size={16} /> Маркирай като прочетено</button>
        </li>)}</ul>
      </section>
      {create && <form className="shark-chat-reminder-form" onSubmit={submit}>
        <label>Напомняне<input required maxLength={500} value={text} onChange={(event) => setText(event.target.value)} /></label>
        <label>Дата и час<input type="datetime-local" required value={localTime} onChange={(event) => setLocalTime(event.target.value)} /></label>
        <label>Часова зона<input required maxLength={100} value={timeZone} list="shark-reminder-time-zones" placeholder="Europe/Sofia" onChange={(event) => setTimeZone(event.target.value)} /></label>
        <datalist id="shark-reminder-time-zones"><option value="Europe/Sofia" /><option value="UTC" /></datalist>
        <div className="shark-chat-reminder-field"><label htmlFor="chat-reminder-repeat">Повторение</label><select id="chat-reminder-repeat" value={repeat} onChange={(event) => setRepeat(event.target.value as ReminderRepeat)}>{Object.entries(REPEAT).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
        <button type="submit" className="shark-chat-new" disabled={!writable || !!op || !text.trim() || !localTime || !timeZone.trim()}>
          {op === 'create' ? <LoaderCircle size={16} className="shark-chat-spinner" /> : <Clock3 size={16} />} {op === 'create' ? 'Записване…' : 'Създай напомняне'}
        </button>
      </form>}
      {problem && <p role="alert" className="shark-chat-notice">{problem}</p>}
      {notice && <p role="status" className="shark-chat-status">{notice}</p>}
      <section className="shark-chat-reminder-device" aria-label="Известия на устройството">
        <h3>Известия на устройството</h3>
        <p>Системните известия изискват отворен SharkAI. Пропуснатите напомняния се показват при следващото отваряне.</p>
        {store.activeDevice ? <button type="button" aria-pressed={store.activeDevice.enabled && store.permission === 'granted'} disabled={store.permissionPending || (store.permission === 'denied' && !store.activeDevice.enabled)} onClick={() => void store.toggleNotifications()}>
          {store.activeDevice.enabled ? <BellOff size={16} /> : <Bell size={16} />} {store.activeDevice.enabled ? 'Изключи системните известия' : 'Включи системните известия'}
        </button> : <p>Този прозорец не предоставя системни известия.</p>}
        {store.permission === 'denied' && <p>Разрешението за системни известия е блокирано в браузъра.</p>}
        {store.deliveryError && <p role="alert" className="shark-chat-notice">{store.deliveryError}</p>}
      </section>
      {store.loading && <p role="status" className="shark-chat-status"><LoaderCircle size={16} className="shark-chat-spinner" /> Зареждане…</p>}
      {store.error && <p className="shark-chat-notice" role="alert">{store.error} <button type="button" onClick={() => void store.refresh()}><RotateCcw size={15} /> Опитай отново</button></p>}
      <section aria-label="Записани напомняния">
        <h3>Записани напомняния</h3>
        {!store.loading && !store.error && !store.reminders.length && <p>Още няма записани напомняния.</p>}
        <ul>{store.reminders.map((item) => <li key={item.id}>
          <strong>{item.text}</strong>
          {item.nextAt && <span>{formatReminderTime(item.nextAt, item.timeZone)} · {item.timeZone}</span>}
          <span>{REPEAT[item.repeat]} · {reminderStatus(item, store.notifications.some(({ reminderId }) => reminderId === item.id))}</span>
          {!item.cancelledAt && item.nextAt && <button type="button" disabled={!!op} onClick={() => void change('cancel', item.id)}><X size={16} /> Отмени напомнянето</button>}
        </li>)}</ul>
      </section>
    </div>
  );
}
