import type { Metadata } from 'next';
import { Inter, Space_Grotesk } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin', 'cyrillic'],
  variable: '--font-inter',
});

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-space',
});

export const metadata: Metadata = {
  title: 'SharkAI — Шарк АИ | Autonomous AI Platform | Download Free',
  description:
    'Shark AI / Шарк АИ — изтегли безплатно за Windows. Open chat, screenshot to code, 15 AI agents, multi-agent build, ZIP export. Локално, без OpenAI.',
  keywords: ['SharkAI', 'Shark AI', 'Шарк АИ', 'шарк аи', 'AI software', 'download', 'изтегли', 'autonomous AI', 'screenshot to code'],
  openGraph: {
    title: 'SharkAI — Шарк АИ',
    description: 'Build anything with autonomous AI. Download free for Windows.',
    type: 'website',
  },
  icons: {
    icon: '/logo.png',
    apple: '/logo.png',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="bg" className={`${inter.variable} ${spaceGrotesk.variable}`}>
      <body className="font-sans min-h-screen">{children}</body>
    </html>
  );
}
