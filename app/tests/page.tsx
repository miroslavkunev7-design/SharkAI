'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, CircleAlert, CircleCheck, CircleMinus, LoaderCircle, Play } from 'lucide-react';
import { Logo } from '@/components/Logo';
import cases from '@/scripts/test-cases.json';
import '../operator-workspace.css';

type Result = { id: string; status: 'passed' | 'failed' | 'skipped'; duration: number; error?: string };
type Summary = { ranAt: string; passed: number; failed: number; skipped: number; results: Result[] };

const testArt: Readonly<Record<string, string>> = {
  'Ресурси': 'shark',
  'Изолация': 'team',
  'Файлове': 'studio',
  'Студио': 'studio',
  'Уеб': 'studio',
  Windows: 'shark',
};

export default function TestsPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [runnerAvailable, setRunnerAvailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch('/api/tests', { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) {
          setError(response.status === 401 || response.status === 403 ? 'Нужен е администраторски вход.' : 'Проверките са недостъпни.');
          return;
        }
        const data = await response.json();
        setSummary(data.results);
        setAuthorized(true);
        setRunnerAvailable(data.runnerAvailable === true);
      } catch {
        if (!controller.signal.aborted) setError('Връзката със сървъра прекъсна.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  async function run(testId?: string) {
    setRunning(testId || 'all');
    setError('');
    try {
      const response = await fetch('/api/tests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testId }),
      });
      const data = await response.json();
      if (data.results) setSummary(data.results);
      if (!response.ok) setError(data.error || 'Проверката не може да стартира.');
    } catch {
      setError('Връзката със сървъра прекъсна.');
    } finally {
      setRunning(null);
    }
  }

  return (
    <main className="operator-workspace mx-auto max-w-4xl px-3 py-4 sm:px-6 sm:py-6">
      <nav className="operator-topbar" aria-label="Проверки">
        <div className="flex min-w-0 items-center gap-2.5">
          <Link href="/dashboard" aria-label="Към обзора" className="shark-action-secondary operator-icon-button"><ArrowLeft size={17} aria-hidden="true" /></Link>
          <div className="shark-wordmark"><Logo size="sm" /><span aria-hidden="true">Shark<span>AI</span></span></div>
        </div>
        {authorized && runnerAvailable && (
          <button type="button" disabled={!!running} onClick={() => run()} className="shark-action shrink-0">
            {running === 'all' ? <LoaderCircle size={17} className="animate-spin" aria-hidden="true" /> : <Play size={17} aria-hidden="true" />}
            Изпълни всички
          </button>
        )}
      </nav>
      <header className="ice-section operator-hero" data-ice-art="agent">
        <div className="operator-hero-copy">
          <h1>Проверки на SharkAI</h1>
          <p>Тестове на приложението и отчети за резултатите.</p>
        </div>
      </header>
      {loading && <p role="status" className="operator-status shark-glass text-sm text-white/75">Зареждам резултатите…</p>}
      {error && <p role="alert" className="operator-status shark-glass text-sm text-rose-200">{error}</p>}
      {authorized && (
        <section aria-label="Резултати" aria-busy={!!running} className="grid gap-3">
          {summary && (
            <div role="status" className="grid gap-2">
              <dl className="operator-metrics grid-cols-3" aria-label="Обобщение">
                {[
                  { label: 'Успешни', value: summary.passed, icon: CircleCheck },
                  { label: 'Неуспешни', value: summary.failed, icon: CircleAlert },
                  { label: 'С липсваща зависимост', value: summary.skipped ?? 0, icon: CircleMinus },
                ].map(({ label, value, icon: Icon }) => (
                  <div key={label} className="operator-metric">
                    <dt><span className="operator-metric-icon"><Icon size={16} aria-hidden="true" /></span>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs text-white/65">Последно изпълнение {new Date(summary.ranAt).toLocaleString('bg-BG')}</p>
            </div>
          )}
          {!runnerAvailable && <p className="operator-status shark-glass text-sm text-amber-200">Тестовият runner не е наличен в тази среда.</p>}
          <ul className="space-y-2">
            {cases.map(test => {
              const result = summary?.results.find(row => row.id === test.id);
              return (
                <li key={test.id} className="ice-section operator-result" data-ice-art={testArt[test.category] ?? 'agent'}>
                  <div className="operator-result-content">
                    {result?.status === 'passed' && <CircleCheck className="shrink-0 text-emerald-800" size={19} aria-hidden="true" />}
                    {result?.status === 'failed' && <CircleAlert className="shrink-0 text-rose-800" size={19} aria-hidden="true" />}
                    {result?.status === 'skipped' && <CircleMinus className="shrink-0 text-amber-900" size={19} aria-hidden="true" />}
                    <div>
                      <h2 className="font-semibold">{test.name}</h2>
                      <p className="operator-muted text-sm">
                        {test.category} · {result?.status === 'passed' ? 'Успешно' : result?.status === 'failed' ? 'Неуспешно' : result?.status === 'skipped' ? 'Липсва зависимост' : 'Очаква проверка'}
                        {result ? ` · ${result.duration} ms` : ''}
                      </p>
                      {result?.error && <p className="mt-1 text-sm text-amber-950">{result.error}</p>}
                    </div>
                  </div>
                  {runnerAvailable && <button type="button" disabled={!!running} onClick={() => run(test.id)} className="shark-action-secondary operator-icon-button" aria-label={`Изпълни: ${test.name}`}>
                    {running === test.id ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
                  </button>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}
