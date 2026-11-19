import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { Navbar } from '@/components/Navbar';
import { Footer } from '@/components/Footer';
import { HomeHero } from './home-hero';
import { homeModules } from './home-modules';
import './home.css';

export default function HomePage() {
  return (
    <div className="shark-launch-home">
      <Navbar />
      <main id="main-content" className="shark-launch-main">
        <HomeHero />
        <nav id="features" aria-label="Модули на SharkAI" className="shark-launch-summary">
          {homeModules.slice(1).map(({ id, href, title, summary, icon: Icon }) => (
            <Link key={id} href={href} id={id === 'studio' ? 'loop' : id}>
              <Icon className="shark-launch-summary-icon" size={24} aria-hidden="true" />
              <span><strong>{title}</strong><small>{summary}</small></span>
              <ArrowUpRight className="shark-launch-summary-arrow" size={16} aria-hidden="true" />
            </Link>
          ))}
        </nav>
      </main>
      <Footer />
    </div>
  );
}
