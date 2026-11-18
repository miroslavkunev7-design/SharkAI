'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Logo } from '@/components/Logo';
import '../entry.css';

export default function LoginPage() {
  const router = useRouter();
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await fetch(`/api/auth/${isRegister ? 'register' : 'login'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Входът не беше успешен.');
      const next = new URLSearchParams(window.location.search).get('next');
      const allowedReturn = next && /^\/(chat|dashboard|pricing)(\?|$)/.test(next);
      router.push(allowedReturn ? next : '/chat');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Връзката със SharkAI прекъсна.');
    } finally {
      setLoading(false);
    }
  }

  function toggleRegistration() {
    setIsRegister(!isRegister);
    setError('');
  }

  return (
    <main className="shark-entry-page shark-entry-auth">
      <section className="ice-section shark-entry-feature shark-entry-auth-panel" data-ice-art="shark" aria-labelledby="login-title">
        <div className="shark-entry-feature-copy shark-entry-auth-copy">
          <Link href="/" className="shark-wordmark w-fit" aria-label="SharkAI, начало">
            <Logo size="sm" />
            <span aria-hidden="true">SharkAI</span>
          </Link>
          <h1 id="login-title">{isRegister ? 'Създай акаунт' : 'Вход в SharkAI'}</h1>
          <form onSubmit={handleSubmit} className="shark-entry-form" aria-busy={loading}>
            {isRegister && (
              <label>
                Име
                <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" />
              </label>
            )}
            <label>
              Имейл
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
            </label>
            <label>
              Парола
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={isRegister ? 'new-password' : 'current-password'} required />
            </label>
            {error && <p role="alert" className="shark-entry-error">{error}</p>}
            <button type="submit" disabled={loading} className="shark-action w-full">
              {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {isRegister ? 'Регистрация' : 'Влез'}
            </button>
          </form>
          <button type="button" onClick={toggleRegistration} disabled={loading} className="shark-entry-text-button">
            {isRegister ? 'Вече имаш акаунт? Влез' : 'Създай акаунт'}
          </button>
        </div>
      </section>
    </main>
  );
}
