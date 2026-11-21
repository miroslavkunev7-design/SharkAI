'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Minus, Settings, X } from 'lucide-react';
import type { Model } from './chat/workspace-types';
import { walletUrl } from './wallet/wallet-routes';

interface QuickChatHeaderProps {
  active: boolean;
  online: boolean;
  loading: boolean;
  signedIn: boolean;
  models: Model[];
  model: string;
  selectModel: (id: string) => void;
  disabled: boolean;
  fullChatHref: string | null;
  voiceLabel: string;
  voiceReason: string;
  startVoice: () => void;
  dictationLabel: string;
  dictationReason: string;
  startDictation: () => void;
  minimize: () => void;
}

export function QuickChatHeader(props: QuickChatHeaderProps) {
  const [menu, setMenu] = useState<'model' | 'settings' | null>(null);
  const header = useRef<HTMLElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const popover = useRef<HTMLDivElement>(null);
  const menuOpen = props.active && menu !== null;
  useEffect(() => {
    if (!menuOpen) return;
    popover.current?.focus({ preventScroll: true });
    function outside(event: PointerEvent) {
      if (!header.current?.contains(event.target as Node)) setMenu(null);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setMenu(null);
      opener.current?.focus({ preventScroll: true });
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [menuOpen]);

  function toggle(next: typeof menu, trigger: HTMLButtonElement) {
    opener.current = trigger;
    setMenu(menu === next ? null : next);
  }

  function choose(action: () => void) {
    setMenu(null);
    opener.current?.focus({ preventScroll: true });
    action();
  }

  return <header className="original-chat-header" ref={header}>
    <span className="original-chat-avatar" aria-hidden="true"><Image src="/wallet-original/image-22.png" alt="" width={1254} height={1254} unoptimized /></span>
    <div className="original-chat-identity">
      <h2>Shark Assistant</h2>
      <p className="original-chat-online" data-online={props.online}><span aria-hidden="true" />
        {props.loading ? 'Свързване…' : props.online ? 'На линия' : props.signedIn ? 'Недостъпно' : 'Изисква вход'}
      </p>
      <button type="button" className="original-chat-model" aria-haspopup="dialog" aria-expanded={menuOpen && menu === 'model'}
        aria-controls="original-chat-models" onClick={(event) => toggle('model', event.currentTarget)}>
        {props.model === 'auto' ? 'n8n · ChatGPT' : props.models.find(({ id }) => id === props.model)?.label ?? 'n8n · ChatGPT'}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
    </div>
    <div className="original-chat-window-actions">
      <button type="button" className="original-chat-round original-chat-gear" title="Настройки" aria-label="Настройки на чата"
        aria-haspopup="dialog" aria-controls="original-chat-settings" aria-expanded={menuOpen && menu === 'settings'}
        onClick={(event) => toggle('settings', event.currentTarget)}><Settings size={20} /></button>
      <button type="button" className="original-chat-window-button" data-quick-minimize title="Свий" aria-label="Свий чата"
        onClick={props.minimize}><Minus size={23} /></button>
      <button type="button" className="original-chat-window-button original-chat-close" title="Затвори" aria-label="Затвори чата"
        onClick={props.minimize}><X size={17} /></button>
    </div>
    {menuOpen && menu === 'model' && <div className="original-chat-popover original-chat-model-popover" id="original-chat-models"
      ref={popover} role="dialog" tabIndex={-1} aria-label="Модел на Шарк агента">
      <strong>Модел на Шарк агента</strong>
      {props.models.length ? props.models.map((item) => <button key={item.id} type="button" aria-pressed={item.id === props.model}
        disabled={props.disabled} onClick={() => choose(() => props.selectModel(item.id))}>{item.label}{item.id === props.model && <Check size={16} />}</button>)
        : <p>{props.signedIn ? 'Няма достъпен модел.' : 'Влез в профила си, за да видиш достъпните модели.'}</p>}
    </div>}
    {menuOpen && menu === 'settings' && <div className="original-chat-popover" id="original-chat-settings" ref={popover}
      role="dialog" tabIndex={-1} aria-label="Настройки на чата">
      <Link href={walletUrl('settings')} onClick={props.minimize}>Настройки</Link>
      <Link href={walletUrl('privacy')} onClick={props.minimize}>Поверителност</Link>
      <Link href={walletUrl('help')} onClick={props.minimize}>Помощ</Link>
      {props.fullChatHref && <Link href={props.fullChatHref} onClick={props.minimize}>Отвори пълния чат</Link>}
      {props.signedIn && <>
        <button type="button" disabled={props.disabled || !!props.dictationReason} title={props.dictationReason}
          onClick={() => choose(props.startDictation)}>{props.dictationLabel}</button>
        <button type="button" disabled={props.disabled || !!props.voiceReason} title={props.voiceReason}
          onClick={() => choose(props.startVoice)}>{props.voiceLabel}</button>
      </>}
    </div>}
  </header>;
}
