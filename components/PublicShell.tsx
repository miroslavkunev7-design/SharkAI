import type { ReactNode } from 'react';
import { Navbar } from './Navbar';
import { Footer } from './Footer';
import './public-shell.css';

export function PublicShell({ children, mainClassName }: { children: ReactNode; mainClassName: string }) {
  return (
    <div className="shark-public-shell">
      <Navbar />
      <main id="main-content" className={mainClassName}>{children}</main>
      <Footer />
    </div>
  );
}
