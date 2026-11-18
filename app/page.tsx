import Link from 'next/link';
import { ArrowRight, MessageSquare, PanelsTopLeft, UsersRound } from 'lucide-react';
import { Navbar } from '@/components/Navbar';
import { Hero } from '@/components/Hero';
import { Footer } from '@/components/Footer';
import './entry.css';

const modules = [
  { href: '/chat', title: 'AI чат', description: 'Питай, прикачи изображение или продължи разговор.', anchor: undefined, image: 'agent', icon: MessageSquare },
  { href: '/dashboard?view=studio', title: 'Студио', description: 'Създай проект от описание или екранна снимка.', anchor: 'loop', image: 'studio', icon: PanelsTopLeft },
  { href: '/dashboard?view=agents', title: 'AI агенти', description: 'Виж ролите на агентите и изпълненията по проектите си.', anchor: 'agents', image: 'team', icon: UsersRound },
];

export default function HomePage() {
  return (
    <div className="shark-entry-home">
      <Navbar />
      <main id="main-content">
        <Hero />
        <section id="features" className="shark-home-modules" aria-labelledby="modules-heading">
          <h2 id="modules-heading">Модули</h2>
          <div className="shark-home-grid">
            {modules.map(({ href, title, description, anchor, image, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className="ice-section shark-entry-module"
                data-ice-art={image}
                id={anchor}
              >
                <div className="shark-entry-module-copy">
                  <div className="shark-entry-module-heading">
                    <Icon size={18} aria-hidden="true" />
                    <h3>{title}</h3>
                  </div>
                  <p>{description}</p>
                </div>
                <span className="shark-entry-module-arrow" aria-hidden="true"><ArrowRight size={16} /></span>
              </Link>
            ))}
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
