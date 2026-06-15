import Link from 'next/link';
import { Logo } from './Logo';

export function Footer() {
  return (
    <footer className="border-t border-white/5 py-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <Logo size="sm" />
            <span className="font-display font-bold gradient-text">SharkAI</span>
          </div>
          <p className="text-sm text-white/40 text-center">
            © 2026 SharkAI. Autonomous AI Software Engineering Platform.
          </p>
          <div className="flex gap-6 text-sm text-white/50">
            <Link href="/dashboard" className="hover:text-shark-cyan transition-colors">Dashboard</Link>
            <Link href="/admin" className="hover:text-shark-cyan transition-colors">Admin</Link>
            <Link href="/pricing" className="hover:text-shark-cyan transition-colors">Pricing</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
