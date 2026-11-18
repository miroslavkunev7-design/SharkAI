'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, CircleAlert, CircleCheck, LoaderCircle, Play } from 'lucide-react';
import { Logo } from '@/components/Logo';
import cases from '@/scripts/test-cases.json';

type Result = { id: string; status: 'passed' | 'failed' | 'skipped'; duration: number; error?: string };
type Summary = { ranAt: string; passed: number; failed: number; skipped: number; results: Result[] };

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
    <main className="max-w-4xl mx-auto px-4 py-7 min-h-screen">
      <header className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <Link href="/dashboard" aria-label="Към обзора" className="shark-action-secondary"><ArrowLeft size={17} /></Link>
          <Logo size="sm" />
          <h1 className="font-semibold text-xl">Проверки на SharkAI</h1>
        </div>
        {authorized && runnerAvailable && (
          <button type="button" disabled={!!running} onClick={() => run()} className="shark-action">
            {running === 'all' ? <LoaderCircle size={17} className="animate-spin" /> : <Play size={17} />}
            Изпълни всички
          </button>
        )}
      </header>
      {loading && <p role="status">Зареждам резултатите…</p>}
      {error && <p role="alert" className="text-red-300 mb-4">{error}</p>}
      {authorized && (
        <section aria-label="Резултати" aria-busy={!!running}>
          {summary && (
            <p role="status" className="text-sm text-white/70 mb-4">
              {summary.passed} успешни · {summary.failed} неуспешни · {summary.skipped ?? 0} с липсваща зависимост
              {' • '}{new Date(summary.ranAt).toLocaleString('bg-BG')}
            </p>
          )}
          {!runnerAvailable && <p className="text-sm text-amber-200 mb-4">Тестовият runner не е наличен в тази среда.</p>}
          <ul className="space-y-2">
            {cases.map(test => {
              const result = summary?.results.find(row => row.id === test.id);
              return (
                <li key={test.id} className="shark-glass rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-start gap-3">
                    {result?.status === 'passed' && <CircleCheck className="text-emerald-300 shrink-0" size={20} />}
                    {result?.status === 'failed' && <CircleAlert className="text-red-300 shrink-0" size={20} />}
                    <div>
                      <h2 className="font-semibold">{test.name}</h2>
                      <p className="text-sm text-white/65">
                        {test.category} · {result?.status === 'passed' ? 'Успешно' : result?.status === 'failed' ? 'Неуспешно' : result?.status === 'skipped' ? 'Липсва зависимост' : 'Очаква проверка'}
                        {result ? ` · ${result.duration} ms` : ''}
                      </p>
                      {result?.error && <p className="text-sm text-amber-200 mt-1">{result.error}</p>}
                    </div>
                  </div>
                  {runnerAvailable && <button type="button" disabled={!!running} onClick={() => run(test.id)} className="shark-action-secondary" aria-label={`Изпълни: ${test.name}`}>
                    {running === test.id ? <LoaderCircle size={16} className="animate-spin" /> : <Play size={16} />}
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
