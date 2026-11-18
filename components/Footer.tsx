import Link from 'next/link';
import { Logo } from './Logo';

export function Footer() {
  return (
    <footer className="shark-footer">
      <Link href="/" className="shark-wordmark" aria-label="SharkAI, начало">
        <Logo size="sm" />
        <span aria-hidden="true">SharkAI</span>
      </Link>
      <nav aria-label="Допълнителни връзки">
        <Link href="/dashboard">Обзор</Link>
        <Link id="pricing" href="/pricing">Планове</Link>
        <Link href="/download">За Windows</Link>
      </nav>
    </footer>
  );
}
