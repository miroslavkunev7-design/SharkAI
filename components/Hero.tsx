import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, PanelsTopLeft } from 'lucide-react';
import sharkHero from '@/public/sharkai/shark-hero.webp';

export function Hero() {
  return (
    <section className="shark-hero" aria-labelledby="home-title">
      <Image src={sharkHero} alt="" fill sizes="100vw" priority className="shark-hero-image" />
      <div className="shark-hero-content">
        <h1 id="home-title">Твоето AI <span>работно пространство</span></h1>
        <p>Разговаряй с SharkAI, работи по проекти и превръщай идеи и референции в уеб приложения.</p>
        <div className="shark-hero-actions">
          <Link href="/chat" className="shark-action">
            Отвори чата <ArrowRight size={18} aria-hidden="true" />
          </Link>
          <Link href="/dashboard?view=studio" className="shark-action-secondary">
            <PanelsTopLeft size={18} aria-hidden="true" /> Към Студиото
          </Link>
        </div>
      </div>
    </section>
  );
}
