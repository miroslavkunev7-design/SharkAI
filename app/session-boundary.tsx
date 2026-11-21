'use client';

import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

const sessionChange = 'sharkai:session-change';

/** The marker contains no identity or credential. Each tab checks its own cookie. */
export function announceSessionChange() {
  try { localStorage.setItem(sessionChange, crypto.randomUUID()); } catch { /* Other tabs also check on focus. */ }
  window.dispatchEvent(new Event(sessionChange));
}

export function SessionBoundary({ children }: { children: ReactNode }) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current: string | undefined;
    let request: AbortController | null = null;
    let timer: number | undefined;
    let disposed = false;
    const root = document.documentElement;
    const mask = () => root.setAttribute('data-session-checking', '');
    const unmask = () => root.removeAttribute('data-session-checking');
    const reset = () => flushSync(() => setRevision(value => value + 1));
    async function check(force = false) {
      if (disposed || document.hidden || (request && !force)) return;
      request?.abort();
      window.clearTimeout(timer);
      const controller = new AbortController();
      request = controller;
      try {
        const response = await fetch('/api/auth/session', {
          cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
        });
        if (!response.ok) throw Error();
        const data = await response.json();
        if (disposed || controller.signal.aborted) return;
        if (data.owner !== null && (typeof data.owner !== 'string' || typeof data.role !== 'string'
          || typeof data.plan !== 'string' || !Number.isFinite(data.remainingMs) || data.remainingMs <= 0)) throw Error();
        const next = JSON.stringify([data.owner, data.role, data.plan]);
        if (current !== undefined && current !== next) reset();
        current = next;
        if (data.owner) {
          timer = window.setTimeout(() => { mask(); void check(true); }, Math.min(2147483647, Math.ceil(data.remainingMs) + 1));
        }
      } catch {
        if (disposed || controller.signal.aborted) return;
        if (current !== 'unavailable') reset();
        current = 'unavailable';
        timer = window.setTimeout(() => void check(), 30000);
      } finally {
        if (request === controller && !disposed) {
          request = null;
          if (!document.hidden) unmask();
        }
      }
    }
    function onLeave() { mask(); request?.abort(); request = null; }
    function onReturn() { if (!document.hidden) { mask(); void check(); } }
    function onVisibility() { if (document.hidden) onLeave(); else onReturn(); }
    function onRestore(event: PageTransitionEvent) { if (event.persisted) onReturn(); }
    function onChange() {
      mask();
      request?.abort();
      request = null;
      current = undefined;
      reset();
      void check(true);
    }
    function onStorage(event: StorageEvent) { if (event.key === sessionChange) onChange(); }

    void check();
    window.addEventListener(sessionChange, onChange);
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onReturn);
    window.addEventListener('pagehide', onLeave);
    window.addEventListener('pageshow', onRestore);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      request?.abort();
      window.clearTimeout(timer);
      unmask();
      window.removeEventListener(sessionChange, onChange);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onReturn);
      window.removeEventListener('pagehide', onLeave);
      window.removeEventListener('pageshow', onRestore);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  return <Fragment key={revision}>{children}</Fragment>;
}
