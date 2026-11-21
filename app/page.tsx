import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { PublicShell } from '@/components/PublicShell';
import { HomeHero } from './home-hero';
import { homeModules } from './home-modules';
import './home.css';

export default function HomePage() {
  return (
    <PublicShell mainClassName="shark-launch-home shark-launch-main">
      <HomeHero />
      <nav id="features" aria-label="Модули на SharkAI" className="shark-launch-summary">
        {homeModules.slice(1).map(({ id, href, title, summary, cardScene, icon: Icon }) => (
          <Link key={id} href={href} data-scene={cardScene} data-scene-tone="light" id={id === 'studio' ? 'loop' : id}>
            <Icon className="shark-launch-summary-icon" size={24} aria-hidden="true" />
            <span><strong>{title}</strong><small>{summary}</small></span>
            <ArrowUpRight className="shark-launch-summary-arrow" size={16} aria-hidden="true" />
          </Link>
        ))}
      </nav>
    </PublicShell>
  );
}
