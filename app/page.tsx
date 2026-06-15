import { Navbar } from '@/components/Navbar';
import { Hero } from '@/components/Hero';
import { Features } from '@/components/Features';
import { AgentSystem } from '@/components/AgentSystem';
import { AutonomousLoop } from '@/components/AutonomousLoop';
import { Pricing } from '@/components/Pricing';
import { Footer } from '@/components/Footer';

export default function HomePage() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <Features />
        <AgentSystem />
        <AutonomousLoop />
        <Pricing />
      </main>
      <Footer />
    </>
  );
}
