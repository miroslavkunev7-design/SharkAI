import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SharkAI — AI чат и работно пространство',
  description:
    'Разговаряй с SharkAI, създавай проекти по описание или референция и ги организирай в едно работно пространство.',
  keywords: ['SharkAI', 'Shark AI', 'Шарк АИ', 'шарк аи', 'AI software', 'download', 'изтегли', 'autonomous AI', 'screenshot to code'],
  openGraph: {
    title: 'SharkAI — Шарк АИ',
    description: 'AI чат, Студио и агенти в SharkAI.',
    type: 'website',
  },
  icons: {
    icon: '/logo-icon.png',
    apple: '/logo-icon.png',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
  themeColor: '#080e1d',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="bg">
      <body className="font-sans min-h-screen">{children}</body>
    </html>
  );
}
