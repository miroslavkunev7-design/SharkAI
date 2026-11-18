'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, BarChart3, KeyRound, RefreshCw, Shield, TestTube, Users } from 'lucide-react';
import { Logo } from '@/components/Logo';

interface AISettings {
  paidAIEnabled: boolean;
  aiConfigured: boolean;
  openai: { hasKey: boolean };
  anthropic: { hasKey: boolean };
}

interface AdminData {
  stats: { totalUsers: number; proUsers: number; ultraUsers: number; totalProjects: number };
  users: Array<{ id: string; email: string; plan: string }>;
  account: { plan: string };
  ai: AISettings;
}

export default function AdminPage() {
  const router = useRouter();
  const [data, setData] = useState<AdminData | null>(null);
  const [loading, setLoading] = useState(true);
  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [paidAI, setPaidAI] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/admin', { cache: 'no-store' });
      if (response.status === 403) {
        router.replace('/login');
        return;
      }
      if (!response.ok) throw new Error('Административните данни са недостъпни.');
      const admin: AdminData = await response.json();
      setData(admin);
      setPaidAI(admin.ai.paidAIEnabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Зареждането прекъсна.');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { void load(); }, [load]);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setStatus('');
    setSaving(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paidAIEnabled: paidAI,
          openaiKey: openaiKey.trim() || undefined,
          anthropicKey: anthropicKey.trim() || undefined,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Настройките не бяха запазени.');
      setData((previous) => previous ? { ...previous, ai: result } : previous);
      setPaidAI(result.paidAIEnabled);
      setOpenaiKey('');
      setAnthropicKey('');
      setStatus('Настройките са запазени.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Настройките не бяха запазени.');
    } finally {
      setSaving(false);
    }
  }

  async function testProvider() {
    setTesting(true);
    setError('');
    setStatus('');
    try {
      const response = await fetch('/api/admin/ai-test', { method: 'POST' });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'AI проверката не беше успешна.');
      setStatus(result.reply);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI проверката не беше успешна.');
    } finally {
      setTesting(false);
    }
  }

  const cards = data ? [
    { label: 'Потребители', value: data.stats.totalUsers, icon: Users },
    { label: 'План PRO в профила', value: data.stats.proUsers, icon: Users },
    { label: 'План ULTRA в профила', value: data.stats.ultraUsers, icon: Users },
    { label: 'Проекти', value: data.stats.totalProjects, icon: BarChart3 },
  ] : [];

  return (
    <main className="min-h-screen max-w-6xl mx-auto px-4 py-5">
      <header className="shark-glass rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/dashboard?view=settings" className="shark-action-secondary" aria-label="Към настройките на акаунта"><ArrowLeft size={18} /></Link>
          <Logo size="md" />
          <h1 className="text-xl font-bold">Администрация</h1>
          {data && <span className="inline-flex items-center gap-2 text-sm text-white/75"><Shield size={16} /> {data.account.plan}</span>}
        </div>
        <button className="shark-action-secondary" type="button" onClick={() => void load()} disabled={loading || saving} aria-label="Обнови">
          <RefreshCw size={17} className={loading ? 'animate-spin' : undefined} />
        </button>
      </header>
      {loading && <p role="status" className="my-4 text-white/70">Зареждане на административните данни…</p>}
      {error && <p role="alert" className="my-4 text-rose-200">{error}</p>}
      {status && <p role="status" className="my-4 text-cyan-200">{status}</p>}
      {data && (
        <>
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 my-5">
            {cards.map(({ icon: Icon, label, value }) => (
              <div key={label} className="shark-glass rounded-xl p-4">
                <Icon className="mb-2 text-cyan-200" size={19} aria-hidden="true" />
                <dt className="text-sm text-white/75">{label}</dt><dd className="text-2xl font-bold">{value}</dd>
              </div>
            ))}
          </dl>
          <div className="grid lg:grid-cols-2 gap-4">
            <section id="settings" className="shark-glass rounded-2xl p-5">
              <h2 className="mb-4 flex items-center gap-2 font-bold"><KeyRound size={19} /> AI доставчици</h2>
              <form className="grid gap-4" onSubmit={saveSettings}>
                <label className="flex gap-3 items-center min-h-11">
                  <input type="checkbox" className="w-5 h-5 accent-cyan-400" checked={paidAI} onChange={(event) => setPaidAI(event.target.checked)} />
                  Разреши конфигурираните AI услуги
                </label>
                <p className="text-sm text-white/75">{data.ai.aiConfigured ? 'Има конфигуриран доставчик.' : 'Няма разрешен и конфигуриран доставчик.'}</p>
                <label className="grid gap-2 text-sm">OpenAI API ключ
                  {data.ai.openai.hasKey && <small className="text-cyan-200">Запазен ключ</small>}
                  <input type="password" value={openaiKey} onChange={(event) => setOpenaiKey(event.target.value)} className="rounded-xl border border-white/20 bg-black/35 p-3" autoComplete="off" />
                </label>
                <label className="grid gap-2 text-sm">Anthropic API ключ
                  {data.ai.anthropic.hasKey && <small className="text-cyan-200">Запазен ключ</small>}
                  <input type="password" value={anthropicKey} onChange={(event) => setAnthropicKey(event.target.value)} className="rounded-xl border border-white/20 bg-black/35 p-3" autoComplete="off" />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button className="shark-action" type="submit" disabled={saving}>{saving ? 'Запазване…' : 'Запази настройките'}</button>
                  {data.ai.aiConfigured && <button className="shark-action-secondary" type="button" onClick={testProvider} disabled={testing || saving}>
                    <TestTube size={17} /> {testing ? 'Проверка…' : 'Провери връзката'}
                  </button>}
                </div>
              </form>
            </section>
            <section className="shark-glass rounded-2xl p-5 min-w-0">
              <h2 className="mb-4 flex items-center gap-2 font-bold"><Users size={19} /> Потребители</h2>
              {!data.users.length ? <p className="text-sm text-white/75">Няма потребителски записи.</p> : (
                <div className="overflow-x-auto max-h-96">
                  <table className="w-full text-left text-sm"><thead><tr><th className="p-2">Имейл</th><th className="p-2">План в профила</th></tr></thead>
                    <tbody>{data.users.map((user) => <tr key={user.id} className="border-t border-white/10"><td className="p-2 break-all">{user.email}</td><td className="p-2 text-cyan-200">{user.plan}</td></tr>)}</tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
          <div className="flex flex-wrap gap-2 mt-4">
            <Link href="/chat" className="shark-action-secondary">AI чат</Link>
            <Link href="/dashboard?view=studio" className="shark-action-secondary">Студио</Link>
            <Link href="/pricing" className="shark-action-secondary">Планове</Link>
            <Link href="/tests" className="shark-action-secondary">Проверки</Link>
          </div>
        </>
      )}
    </main>
  );
}
