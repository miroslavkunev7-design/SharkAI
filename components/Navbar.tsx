'use client';

import Link from 'next/link';
import { Logo } from './Logo';
import { useState } from 'react';
import { Menu, X } from 'lucide-react';

const links = [
  { href: '/download', label: 'Download' },
  { href: '/chat', label: 'Chat' },
  { href: '#features', label: 'Features' },
  { href: '/dashboard', label: 'Studio' },
];

export function Navbar() {
  const [open, setOpen] = useState(false);

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 glass border-b border-white/5">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 lg:h-20">
          <Link href="/" className="flex items-center gap-3 group">
            <Logo size="md" className="group-hover:drop-shadow-[0_0_12px_rgba(0,210,255,0.5)] transition-all" />
            <span className="font-display font-bold text-xl gradient-text hidden sm:block">
              SharkAI
            </span>
          </Link>

          <div className="hidden md:flex items-center gap-8">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm text-white/70 hover:text-shark-cyan transition-colors"
              >
                {link.label}
              </Link>
            ))}
          </div>

          <div className="hidden md:flex items-center gap-3">
            <Link href="/login" className="btn-secondary text-sm py-2 px-4">
              Sign In
            </Link>
            <Link href="/chat" className="btn-primary text-sm py-2 px-4">
              Start Chat
            </Link>
          </div>

          <button
            className="md:hidden p-2 text-white/70"
            onClick={() => setOpen(!open)}
            aria-label="Menu"
          >
            {open ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>

        {open && (
          <div className="md:hidden pb-4 space-y-3 animate-in">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="block text-white/70 hover:text-shark-cyan py-2"
                onClick={() => setOpen(false)}
              >
                {link.label}
              </Link>
            ))}
            <div className="flex flex-col gap-2 pt-2">
              <Link href="/login" className="btn-secondary text-center text-sm">
                Sign In
              </Link>
              <Link href="/dashboard" className="btn-primary text-center text-sm">
                Start Building
              </Link>
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
