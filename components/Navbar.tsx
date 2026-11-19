'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { Logo } from './Logo';

const links = [
  { href: '/chat', label: 'Шарк агент' },
  { href: '/dashboard?view=studio', label: 'Студио' },
  { href: '#features', label: 'Модули' },
  { href: '/download', label: 'За Windows' },
];

export function Navbar() {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        toggle.current?.focus();
      }
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  return (
    <header className="shark-header shark-glass">
      <a href="#main-content" className="shark-skip-link">Към съдържанието</a>
      <nav className="shark-nav" aria-label="Основна навигация">
        <Link href="/" className="shark-wordmark" aria-label="SharkAI, начало">
          <Logo size="sm" />
          <span aria-hidden="true">SharkAI</span>
        </Link>
        <button
          ref={toggle}
          type="button"
          className="shark-nav-toggle"
          onClick={() => setOpen(!open)}
          aria-label={open ? 'Затвори менюто' : 'Отвори менюто'}
          aria-controls="public-navigation"
          aria-expanded={open}
        >
          {open ? <X size={22} /> : <Menu size={22} />}
        </button>
        <div id="public-navigation" className={`shark-nav-links${open ? ' is-open' : ''}`}>
          {links.map(({ href, label }) => (
            <Link key={href} href={href} onClick={() => setOpen(false)}>{label}</Link>
          ))}
          <Link href="/login" className="shark-action-secondary" onClick={() => setOpen(false)}>Вход</Link>
        </div>
      </nav>
    </header>
  );
}
