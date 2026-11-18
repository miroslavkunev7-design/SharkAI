import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, MessageSquare, PanelsTopLeft, UsersRound } from 'lucide-react';
import { Navbar } from '@/components/Navbar';
import { Hero } from '@/components/Hero';
import { Footer } from '@/components/Footer';

const modules = [
  { href: '/chat', title: 'AI чат', description: 'Питай, прикачи изображение или продължи разговор.', anchor: undefined, image: 'agent', icon: MessageSquare },
  { href: '/dashboard?view=studio', title: 'Студио', description: 'Създай проект от описание или екранна снимка.', anchor: 'loop', image: 'studio', icon: PanelsTopLeft },
  { href: '/dashboard?view=agents', title: 'AI агенти', description: 'Виж ролите на агентите и изпълненията по проектите си.', anchor: 'agents', image: 'team', icon: UsersRound },
];

export default function HomePage() {
  return (
    <>
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
                className="shark-home-module shark-glass"
                id={anchor}
              >
                <Image
                  src={`/sharkai/${image}.webp`}
                  alt=""
                  fill
                  sizes="(max-width: 760px) 90vw, 30vw"
                  className="shark-module-image"
                />
                <Icon className="shark-module-icon" size={22} aria-hidden="true" />
                <h3>{title}<ArrowRight size={17} aria-hidden="true" /></h3>
                <p>{description}</p>
              </Link>
            ))}
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
