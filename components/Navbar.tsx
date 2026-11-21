'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Menu, Wallet, X } from 'lucide-react';
import { Logo } from './Logo';

const links = [
  { href: '/chat', label: 'Шарк агент' },
  { href: '/dashboard?view=studio', label: 'Студио' },
  { href: '/#features', label: 'Модули' },
  { href: '/pricing', label: 'Планове' },
  { href: '/download', label: 'За Windows' },
];

export function Navbar() {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();

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
    <header className="shark-header shark-glass" data-scene="overview">
      <a href="#main-content" className="shark-skip-link">Към съдържанието</a>
      <nav className="shark-nav" aria-label="Основна навигация">
        <Link href="/" className="shark-wordmark" aria-label="SharkAI, начало">
          <Logo size="sm" />
          <span aria-hidden="true">SharkAI</span>
        </Link>
        <Link href="/wallet" className="public-wallet-link" onClick={() => setOpen(false)}><Wallet size={18} aria-hidden="true" />Портфейл</Link>
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
            <Link key={href} href={href} aria-current={pathname === href ? 'page' : undefined} onClick={() => setOpen(false)}>{label}</Link>
          ))}
          <Link href="/login" className="shark-action-secondary" aria-current={pathname === '/login' ? 'page' : undefined} onClick={() => setOpen(false)}>Вход</Link>
        </div>
      </nav>
    </header>
  );
}
