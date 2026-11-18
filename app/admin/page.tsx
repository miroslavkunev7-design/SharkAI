'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, BarChart3, Boxes, KeyRound, RefreshCw, Shield, TestTube, Users } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { accountPlanLabel, type AccountPlan } from '../account-plan';
import '../operator-workspace.css';

interface AISettings {
  paidAIEnabled: boolean;
  aiConfigured: boolean;
  openai: { hasKey: boolean };
  anthropic: { hasKey: boolean };
}

interface AdminData {
  stats: { totalUsers: number; proUsers: number; ultraUsers: number; totalProjects: number };
  users: Array<{ id: string; email: string; plan: string }>;
  account: AccountPlan;
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
    { label: 'План PRO в профила', value: data.stats.proUsers, icon: BarChart3 },
    { label: 'План ULTRA в профила', value: data.stats.ultraUsers, icon: Shield },
    { label: 'Проекти', value: data.stats.totalProjects, icon: Boxes },
  ] : [];

  return (
    <main className="operator-workspace operator-admin mx-auto max-w-6xl px-3 py-4 sm:px-6 sm:py-6">
      <nav className="operator-topbar" aria-label="Администрация">
        <div className="flex min-w-0 items-center gap-2.5">
          <Link href="/dashboard?view=settings" className="shark-action-secondary operator-icon-button" aria-label="Към настройките на акаунта"><ArrowLeft size={18} aria-hidden="true" /></Link>
          <div className="shark-wordmark"><Logo size="sm" /><span aria-hidden="true">Shark<span>AI</span></span></div>
        </div>
        <button className="shark-action-secondary operator-icon-button" type="button" onClick={() => void load()} disabled={loading || saving} aria-label="Обнови">
          <RefreshCw size={17} aria-hidden="true" className={loading ? 'animate-spin' : undefined} />
        </button>
      </nav>
      <header className="ice-section operator-hero" data-ice-art="team">
        <div className="operator-hero-copy">
          <h1>Администрация</h1>
          <p>Настройки на AI услуги и преглед на потребителите.</p>
          {data && <span className="operator-plan"><Shield size={13} aria-hidden="true" /> {accountPlanLabel(data.account, 'Текущ план ')}</span>}
        </div>
      </header>
      {loading && <div role="status" className="ice-section operator-admin-notice" data-ice-art="team"><p>Зареждане на административните данни…</p></div>}
      {error && <div role="alert" className="ice-section operator-admin-notice" data-ice-art="agent"><p className="operator-admin-error">{error}</p></div>}
      {status && <div role="status" className="ice-section operator-admin-notice" data-ice-art="agent"><p>{status}</p></div>}
      {data && (
        <>
          <dl className="operator-metrics grid-cols-2 md:grid-cols-4" aria-label="Обобщение">
            {cards.map(({ icon: Icon, label, value }) => (
              <div key={label} className="operator-metric">
                <dt><span className="operator-metric-icon"><Icon size={17} aria-hidden="true" /></span>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <div className="grid gap-3 lg:grid-cols-2">
            <section id="settings" className="ice-section operator-panel min-w-0" data-ice-art="agent">
              <header className="operator-admin-panel-heading">
                <h2 className="operator-panel-title"><KeyRound size={19} aria-hidden="true" /> AI доставчици</h2>
                <p className="operator-muted text-sm">{data.ai.aiConfigured ? 'Има конфигуриран доставчик.' : 'Няма разрешен и конфигуриран доставчик.'}</p>
              </header>
              <form className="operator-admin-panel-data grid gap-4" onSubmit={saveSettings}>
                <label className="flex gap-3 items-center min-h-11">
                  <input type="checkbox" className="h-5 w-5 shrink-0 accent-blue-700" checked={paidAI} onChange={(event) => setPaidAI(event.target.checked)} />
                  Разреши конфигурираните AI услуги
                </label>
                <label className="grid gap-2 text-sm">OpenAI API ключ
                  {data.ai.openai.hasKey && <small className="operator-muted">Запазен ключ</small>}
                  <input type="password" value={openaiKey} onChange={(event) => setOpenaiKey(event.target.value)} className="operator-input" autoComplete="off" />
                </label>
                <label className="grid gap-2 text-sm">Anthropic API ключ
                  {data.ai.anthropic.hasKey && <small className="operator-muted">Запазен ключ</small>}
                  <input type="password" value={anthropicKey} onChange={(event) => setAnthropicKey(event.target.value)} className="operator-input" autoComplete="off" />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button className="shark-action" type="submit" disabled={saving}>{saving ? 'Запазване…' : 'Запази настройките'}</button>
                  {data.ai.aiConfigured && <button className="shark-action-secondary" type="button" onClick={testProvider} disabled={testing || saving}>
                    <TestTube size={17} /> {testing ? 'Проверка…' : 'Провери връзката'}
                  </button>}
                </div>
              </form>
            </section>
            <section className="ice-section operator-panel min-w-0" data-ice-art="team">
              <header className="operator-admin-panel-heading">
                <h2 className="operator-panel-title"><Users size={19} aria-hidden="true" /> Потребители</h2>
              </header>
              {!data.users.length ? <p className="operator-admin-panel-data operator-muted text-sm">Няма потребителски записи.</p> : (
                <div className="operator-admin-panel-data operator-table max-h-96 overflow-auto">
                  <table className="w-full table-fixed text-left text-sm"><thead><tr><th className="p-2">Имейл</th><th className="w-[34%] p-2">План в профила</th></tr></thead>
                    <tbody>{data.users.map((user) => <tr key={user.id} className="border-t border-sky-950/20"><td className="p-2 break-all">{user.email}</td><td className="operator-muted p-2 font-semibold">{user.plan}</td></tr>)}</tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
          <nav className="ice-section operator-admin-links" data-ice-art="studio" aria-label="Операторски инструменти">
            <div>
              <Link href="/chat" className="shark-action-secondary">AI чат</Link>
              <Link href="/dashboard?view=studio" className="shark-action-secondary">Студио</Link>
              <Link href="/pricing" className="shark-action-secondary">Планове</Link>
              <Link href="/tests" className="shark-action-secondary">Проверки</Link>
            </div>
          </nav>
        </>
      )}
    </main>
  );
}
