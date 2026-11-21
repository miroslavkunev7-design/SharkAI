'use client';

import { usePathname } from 'next/navigation';
import Image from 'next/image';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Ellipsis, Minus } from 'lucide-react';
import { consumeQuickChat, currentReturnPath } from '@/lib/auth-return';

const ChatWorkspace = lazy(() => import('./chat/chat-workspace'));

function Launcher() {
  const [started, setStarted] = useState(false);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLElement>(null);

  const launch = useCallback(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : trigger.current;
    setStarted(true);
    setOpen(true);
  }, []);

  useEffect(() => {
    window.addEventListener('sharkai:open-chat', launch);
    if (consumeQuickChat(currentReturnPath('/chat'))) launch();
    return () => window.removeEventListener('sharkai:open-chat', launch);
  }, [launch]);

  useEffect(() => {
    if (open) {
      if (!dialog.current?.open) dialog.current?.showModal();
      panel.current?.focus({ preventScroll: true });
    }
  }, [open]);

  const close = useCallback(() => {
    dialog.current?.close();
    setOpen(false);
    requestAnimationFrame(() => {
      const target = opener.current?.isConnected ? opener.current : trigger.current;
      target?.focus({ preventScroll: true });
    });
  }, []);

  // Closing through the workspace also releases the microphone and any audio playback.
  function minimize() {
    const control = panel.current?.querySelector<HTMLButtonElement>('[data-quick-minimize]');
    if (control) control.click();
    else close();
  }

  return (
    <div className="original-chat-dock">
      <button type="button" ref={trigger} className="original-chat-launch" hidden={open}
        aria-label="Отвори Shark Assistant" title="Shark Assistant" aria-haspopup="dialog"
        aria-expanded={open} aria-controls={started ? 'shark-quick-panel' : undefined} onClick={launch}>
        <span className="original-chat-launch-avatar" aria-hidden="true"><Image src="/wallet-original/reference-avatar.png" alt="" width={91} height={91} unoptimized /></span>
        <span className="original-chat-mark" aria-hidden="true"><Ellipsis size={16} /></span>
        <i className="original-chat-dot" aria-hidden="true" />
      </button>
      {started && <dialog className="original-chat-overlay" ref={dialog} aria-label="Shark Assistant"
        onCancel={(event) => { event.preventDefault(); minimize(); }}>
        <button type="button" className="original-chat-backdrop" aria-label="Свий Shark Assistant" tabIndex={-1} onClick={minimize} />
        <section id="shark-quick-panel" ref={panel} className="original-chat-dialog" tabIndex={-1}>
          <Suspense fallback={<div className="original-chat-widget">
            <div className="original-chat-scene" aria-hidden="true" />
            <header className="original-chat-header">
              <span className="original-chat-avatar" aria-hidden="true"><Image src="/wallet-original/image-22.png" alt="" width={1254} height={1254} unoptimized /></span>
              <div className="original-chat-identity"><h2>Shark Assistant</h2><p className="original-chat-online" role="status">Зареждане…</p></div>
              <button type="button" className="original-chat-window-button" onClick={close} aria-label="Свий чата"><Minus size={23} /></button>
            </header>
          </div>}>
            <ChatWorkspace compact active={open} onMinimize={close} />
          </Suspense>
        </section>
      </dialog>}
    </div>
  );
}

export function QuickChatWidget() {
  const pathname = usePathname();
  if (!pathname || pathname === '/chat' || pathname.startsWith('/chat/')) return null;
  return <Launcher key={pathname === '/login' ? 'sign-in' : 'workspace'} />;
}
