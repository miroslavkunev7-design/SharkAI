import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="site-missing">
      <article data-scene="search">
        <h1>Страницата не е намерена</h1>
        <p>Провери адреса или отвори основен раздел на SharkAI.</p>
        <nav aria-label="Към SharkAI">
          <Link className="shark-action" href="/">Към началото</Link>
          <Link className="shark-action-secondary" href="/wallet">Портфейл</Link>
        </nav>
      </article>
    </main>
  );
}
