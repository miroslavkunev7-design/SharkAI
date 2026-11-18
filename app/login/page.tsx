'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Logo } from '@/components/Logo';
import sharkHero from '@/public/sharkai/shark-hero.webp';

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
    <main className="shark-hero shark-auth">
      <Image src={sharkHero} alt="" fill sizes="100vw" priority className="shark-hero-image shark-auth-image" />
      <section className="shark-auth-card shark-glass" aria-labelledby="login-title">
        <Link href="/" className="shark-wordmark w-fit" aria-label="SharkAI, начало">
          <Logo size="sm" />
          <span aria-hidden="true">SharkAI</span>
        </Link>
        <h1 id="login-title" className="!text-2xl mt-5 mb-5">{isRegister ? 'Създай акаунт' : 'Вход в SharkAI'}</h1>
        <form onSubmit={handleSubmit} className="space-y-3" aria-busy={loading}>
          {isRegister && (
            <label className="block text-sm text-white/85">
              Име
              <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" className="shark-auth-input" />
            </label>
          )}
          <label className="block text-sm text-white/85">
            Имейл
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required className="shark-auth-input" />
          </label>
          <label className="block text-sm text-white/85">
            Парола
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={isRegister ? 'new-password' : 'current-password'} required className="shark-auth-input" />
          </label>
          {error && <p role="alert" className="text-red-300 text-sm">{error}</p>}
          <button type="submit" disabled={loading} className="shark-action w-full">
            {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {isRegister ? 'Регистрация' : 'Влез'}
          </button>
        </form>
        <button type="button" onClick={toggleRegistration} disabled={loading} className="mt-4 text-sm text-sky-200 hover:underline min-h-8">
          {isRegister ? 'Вече имаш акаунт? Влез' : 'Създай акаунт'}
        </button>
      </section>
    </main>
  );
}
