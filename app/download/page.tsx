import Link from 'next/link';
import { ArrowRight, Download } from 'lucide-react';
import type { Metadata } from 'next';
import { PublicShell } from '@/components/PublicShell';
import { getInstallerInfo } from '@/lib/installer';
import '../entry.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Изтегли SharkAI за Windows',
  description: 'Настолното приложение SharkAI за Windows x64 използва същия акаунт, чат и проекти като уеб приложението.',
  alternates: { canonical: '/download' },
};

export default function DownloadPage() {
  const installer = getInstallerInfo();

  return (
    <PublicShell mainClassName="shark-entry-page shark-entry-download">
      <section className="ice-section shark-entry-feature" data-scene="desktop" data-scene-tone="light" aria-labelledby="download-title">
        <div className="shark-entry-feature-copy shark-entry-download-copy">
          <h1 id="download-title">SharkAI <span>за Windows</span></h1>
          <p className="shark-entry-lede">
            Влез със съществуващия си SharkAI акаунт. Чатът и проектите използват интернет връзка.
          </p>
          {installer ? (
            <div className="shark-entry-installer">
              <a href={installer.url} className="shark-action">
                <Download aria-hidden="true" className="h-5 w-5" /> Изтегли за Windows
              </a>
              <p>{installer.name} · x64{installer.size ? ` · ${Math.round(installer.size / 1_000_000)} MB` : ''}</p>
            </div>
          ) : <p className="shark-entry-status">Инсталаторът за тази версия още не е достъпен.</p>}
          <Link href="/chat" className="shark-entry-inline-link">
            Чат с Шарк агент в браузъра <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </PublicShell>
  );
}
