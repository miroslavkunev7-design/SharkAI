'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { PublicShell } from '@/components/PublicShell';
import { rememberQuickChat, safeReturnPath } from '@/lib/auth-return';
import { announceSessionChange } from '../session-boundary';
import '../entry.css';

export default function LoginPage() {
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError('');

    try {
      const response = await fetch(`/api/auth/${isRegister ? 'register' : 'login'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password, name }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 401) setError('Имейлът или паролата са неправилни.');
        else if (response.status === 429) setError('Твърде много опити. Опитай след малко.');
        else if (data?.error === 'Email already registered') setError('Вече има акаунт с този имейл. Избери „Влез“.');
        else setError(isRegister ? 'Регистрацията не беше успешна. Опитай отново.' : 'Входът временно е недостъпен. Опитай отново.');
        return;
      }
      if (typeof data?.user?.id !== 'string') {
        setError('SharkAI не потвърди входа. Опитай отново.');
        return;
      }
      const query = new URLSearchParams(window.location.search);
      const next = safeReturnPath(query.get('next')) ?? '/chat';
      announceSessionChange();
      if (query.get('quickChat') === '1' && new URL(next, location.origin).pathname !== '/chat') rememberQuickChat(next);
      window.location.replace(next);
    } catch {
      setError('Връзката със SharkAI прекъсна. Опитай отново.');
    } finally {
      setLoading(false);
    }
  }

  function toggleRegistration() {
    setIsRegister(!isRegister);
    setError('');
  }

  return (
    <PublicShell mainClassName="shark-entry-page shark-entry-auth">
      <section className="ice-section shark-entry-feature shark-entry-auth-panel" data-scene={isRegister ? 'identity' : 'access'} data-scene-tone="light" aria-labelledby="login-title">
        <div className="shark-entry-feature-copy shark-entry-auth-copy">
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
              {loading ? (isRegister ? 'Създаване на акаунта…' : 'Влизане…') : (isRegister ? 'Регистрация' : 'Влез')}
            </button>
          </form>
          <button type="button" onClick={toggleRegistration} disabled={loading} className="shark-entry-text-button">
            {isRegister ? 'Вече имаш акаунт? Влез' : 'Създай акаунт'}
          </button>
        </div>
      </section>
    </PublicShell>
  );
}
