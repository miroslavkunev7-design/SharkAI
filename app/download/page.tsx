import Link from 'next/link';
import { Logo } from '@/components/Logo';
import { Download, Monitor, CheckCircle2, ArrowRight } from 'lucide-react';
import { getInstallerInfo } from '@/lib/installer';
import { getSiteUrl } from '@/lib/site-url';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Изтегли SharkAI — Шарк АИ | Download Free for Windows',
  description:
    'Shark AI / Шарк АИ — безплатно изтегляне за Windows. Autonomous AI platform: chat, screenshot to code, 15 agents, ZIP export. Download SharkAI installer.',
  keywords: ['SharkAI', 'Shark AI', 'Шарк АИ', 'шарк аи', 'изтегли', 'download', 'Windows', 'AI software', 'безплатно'],
  alternates: { canonical: '/download' },
  openGraph: {
    title: 'SharkAI — Шарк АИ | Download',
    description: 'Free Windows download — Shark AI autonomous platform',
    type: 'website',
  },
};

export default function DownloadPage() {
  const installer = getInstallerInfo();
  const siteUrl = getSiteUrl();

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'SharkAI',
    alternateName: ['Shark AI', 'Шарк АИ', 'шарк аи'],
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Windows 10, Windows 11',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
    downloadUrl: installer
      ? (installer.url.startsWith('http') ? installer.url : `${siteUrl}${installer.url}`)
      : `${siteUrl}/download`,
    url: `${siteUrl}/download`,
    description: 'Autonomous AI platform — open chat, screenshot to code, 15 agents, ZIP export.',
  };

  return (
    <div className="min-h-screen bg-shark-black circuit-bg">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <div className="max-w-3xl mx-auto px-4 py-20 text-center">
        <Logo size="lg" variant="full" className="mx-auto mb-8 max-w-xs" />

        <h1 className="font-display text-4xl sm:text-5xl font-bold mb-4">
          <span className="gradient-text">SharkAI</span>
          <span className="block text-2xl text-white/60 mt-2 font-normal">Шарк АИ — Изтегли безплатно</span>
        </h1>

        <p className="text-lg text-white/60 mb-10 max-w-xl mx-auto leading-relaxed">
          Shark AI autonomous platform for Windows. Open chat for anything,
          screenshot to code, 15 multi-agents, ZIP export — local &amp; free.
        </p>

        {installer ? (
          <a
            href={installer.url}
            className="btn-primary inline-flex items-center gap-3 text-lg py-4 px-8 mb-6"
          >
            <Download className="w-6 h-6" />
            Download for Windows
            {installer.size && (
              <span className="text-sm opacity-80">({Math.round(installer.size / 1_000_000)} MB)</span>
            )}
          </a>
        ) : (
          <div className="glass rounded-2xl p-6 mb-6 border border-yellow-500/20">
            <p className="text-yellow-400/90 mb-4">Installer се компилира. Ползвай уеб версията:</p>
            <Link href="/chat" className="btn-primary inline-flex items-center gap-2">
              <Monitor className="w-5 h-5" /> Open SharkAI Web
            </Link>
          </div>
        )}

        <div className="grid sm:grid-cols-3 gap-4 text-left mb-12">
          {['Open chat — any topic', 'Screenshot → code + ZIP', '15 agents, no OpenAI fee'].map((item) => (
            <div key={item} className="glass rounded-xl p-4 flex items-start gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
              <span className="text-sm text-white/70">{item}</span>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap justify-center gap-4">
          <Link href="/chat" className="btn-secondary inline-flex items-center gap-2">
            Try in Browser <ArrowRight className="w-4 h-4" />
          </Link>
          <Link href="/tests" className="btn-secondary text-sm">Test Suite ✓</Link>
        </div>

        <p className="text-xs text-white/30 mt-12">Shark AI · Шарк АИ · Windows 10/11</p>
      </div>
    </div>
  );
}
