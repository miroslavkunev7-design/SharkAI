import Link from 'next/link';
import { ArrowRight, Download } from 'lucide-react';
import type { Metadata } from 'next';
import { Logo } from '@/components/Logo';
import { getInstallerInfo } from '@/lib/installer';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Изтегли SharkAI за Windows',
  description: 'Настолното приложение SharkAI за Windows x64 използва същия акаунт, чат и проекти като уеб приложението.',
  alternates: { canonical: '/download' },
};

export default function DownloadPage() {
  const installer = getInstallerInfo();

  return (
    <main className="min-h-svh px-4 py-16 sm:py-24">
      <div className="shark-glass mx-auto max-w-2xl rounded-[30px] px-6 py-10 text-center sm:p-12">
        <Logo size="lg" className="mx-auto mb-8 max-w-xs" />
        <h1 className="font-display text-3xl font-bold sm:text-5xl">SharkAI за Windows</h1>
        <p className="mx-auto mb-8 mt-4 max-w-lg leading-relaxed text-white/70">
          Влез със съществуващия си SharkAI акаунт. Чатът и проектите използват интернет връзка.
        </p>
        {installer ? (
          <>
            <a href={installer.url} className="shark-action">
              <Download aria-hidden="true" className="h-5 w-5" /> Изтегли за Windows
            </a>
            <p className="mt-3 text-sm text-white/70">
              {installer.name} · x64{installer.size ? ` · ${Math.round(installer.size / 1_000_000)} MB` : ''}
            </p>
          </>
        ) : (
          <p className="rounded-2xl border border-white/15 px-4 py-3 text-white/80">
            Инсталаторът за тази версия още не е достъпен.
          </p>
        )}
        <Link href="/chat" className="shark-action-secondary mt-8">
          Отвори SharkAI в браузъра <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </Link>
      </div>
    </main>
  );
}
