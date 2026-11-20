'use client';

import { usePathname } from 'next/navigation';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Minus } from 'lucide-react';

const ChatWorkspace = lazy(() => import('./chat/chat-workspace'));

function Launcher() {
  const [started, setStarted] = useState(false);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (open) panel.current?.focus({ preventScroll: true });
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }, []);

  return (
    <div className="shark-quick-dock">
      <button type="button" ref={trigger} className="shark-quick-trigger" hidden={open}
        aria-label="Отвори Shark Assistant" title="Отвори Shark Assistant" aria-haspopup="dialog"
        aria-expanded={open} aria-controls={started ? 'shark-quick-panel' : undefined}
        onClick={() => { setStarted(true); setOpen(true); }} />
      {started && <section id="shark-quick-panel" className="shark-quick-panel" role="dialog"
        aria-label="Бърз чат с Шарк" tabIndex={-1} ref={panel} hidden={!open} inert={!open}
        onKeyDown={(event) => {
          if (event.target === event.currentTarget && event.key === 'Escape') {
            const minimize = panel.current?.querySelector<HTMLButtonElement>('[data-quick-minimize]');
            if (minimize) minimize.click();
            else close();
          }
        }}>
        <Suspense fallback={<header className="shark-quick-header">
          <span role="status">Зареждане на чата…</span>
          <div className="shark-quick-actions"><button type="button" onClick={close} aria-label="Минимизирай чата"><Minus size={20} /></button></div>
        </header>}>
          <ChatWorkspace compact active={open} onMinimize={close} />
        </Suspense>
      </section>}
    </div>
  );
}

export function QuickChatWidget() {
  const pathname = usePathname();
  if (!pathname || pathname === '/chat' || pathname.startsWith('/chat/')) return null;
  return <Launcher key={pathname === '/login' ? 'sign-in' : 'workspace'} />;
}
