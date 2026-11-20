'use client';

import { useEffect, useState } from 'react';

export function DesktopWebUpdate({ revision }: { revision?: string }) {
  const [update, setUpdate] = useState('');
  const [dismissed, setDismissed] = useState('');

  useEffect(() => {
    if (!revision || !/\bElectron\//.test(navigator.userAgent)) return;
    const controller = new AbortController();
    let lastCheck = 0;
    let checking = false;
    async function check() {
      if (checking || document.visibilityState !== 'visible' || Date.now() - lastCheck < 60_000) return;
      lastCheck = Date.now();
      checking = true;
      try {
        const res = await fetch('/api/status', { cache: 'no-store', credentials: 'omit',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
        if (!res.ok) return;
        const status = await res.json();
        const deployed = status.revision ?? status.commit;
        if (status.ok !== true || typeof deployed !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(deployed)) return;
        if (deployed === revision) { setUpdate(''); return; }
        // An opened quick chat may still contain a draft or an active request after minimizing.
        if (location.pathname === '/download' && !location.search && !location.hash
          && !document.getElementById('shark-quick-panel')
          && sessionStorage.getItem('sharkai-desktop-reload') !== deployed) {
          sessionStorage.setItem('sharkai-desktop-reload', deployed);
          location.reload();
        } else setUpdate(deployed);
      } catch {
        // The next focus or periodic check will retry when the service is available.
      } finally { checking = false; }
    }
    void check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    const timer = window.setInterval(check, 5 * 60_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [revision]);

  if (!update || update === dismissed) return null;
  return (
    <aside role="status" className="fixed bottom-4 right-4 z-50 max-w-sm rounded-xl border border-white/20 bg-slate-950 p-4 text-sm text-white shadow-xl">
      <p>Има обновление на SharkAI. Запази започнатата работа преди презареждане.</p>
      <div className="mt-3 flex gap-4">
        <button type="button" className="font-semibold underline" onClick={() => location.reload()}>Обнови сега</button>
        <button type="button" onClick={() => setDismissed(update)}>По-късно</button>
      </div>
    </aside>
  );
}
