'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, CircleAlert, CircleCheck, CircleMinus, LoaderCircle, Play } from 'lucide-react';
import { PublicShell } from '@/components/PublicShell';
import cases from '@/scripts/test-cases.json';
import '../operator-workspace.css';
import './tests.css';

type Result = { id: string; status: 'passed' | 'failed' | 'skipped'; duration: number; error?: string };
type Summary = { ranAt: string; passed: number; failed: number; skipped: number; results: Result[] };

const testScenes: Readonly<Record<string, string>> = {
  'files-logo': 'identity',
  'files-agents': 'models',
  'api-status': 'network',
  'api-chat-private': 'security',
  'api-projects-private': 'projects',
  'api-upload': 'documents',
  'build-prompt-software': 'studio',
  'seo-sitemap': 'search',
  'installer-file': 'desktop',
  'download-route': 'access',
};
const categories = Array.from(new Set(cases.map(test => test.category)));

export default function TestsPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [runnerAvailable, setRunnerAvailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch('/api/tests', { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) {
          setNeedsLogin(response.status === 401);
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
    <PublicShell mainClassName="operator-workspace operator-tests">
      <header className="ice-section operator-hero" data-scene="tests" data-scene-tone="light">
        <div className="operator-hero-copy">
          <Link href="/dashboard" className="tests-back"><ArrowLeft size={16} aria-hidden="true" />Към обзора</Link>
          <h1>Проверки на SharkAI</h1>
          <p>Тестове на приложението и отчети за резултатите.</p>
        {authorized && runnerAvailable && (
          <button type="button" disabled={!!running} onClick={() => run()} className="shark-action shrink-0">
            {running === 'all' ? <LoaderCircle size={17} className="animate-spin" aria-hidden="true" /> : <Play size={17} aria-hidden="true" />}
            Изпълни всички
          </button>
        )}
        </div>
      </header>
      {loading && <div className="ice-section operator-status operator-test-status" data-scene="monitoring" data-scene-tone="light">
        <p role="status">Зареждам резултатите…</p>
      </div>}
      {error && <div className="ice-section operator-status operator-test-status" data-scene="security" data-scene-tone="light">
        <p role="alert" className="text-rose-950">{error}</p>
        {needsLogin && <Link className="shark-action" href="/login?next=/tests">Вход</Link>}
      </div>}
      {authorized && (
        <section aria-label="Резултати" aria-busy={!!running} className="grid gap-3">
          {summary && (
            <div role="status" className="grid gap-2">
              <dl className="operator-metrics grid-cols-3" aria-label="Обобщение">
                {[
                  { label: 'Успешни', value: summary.passed, icon: CircleCheck, scene: 'health' },
                  { label: 'Неуспешни', value: summary.failed, icon: CircleAlert, scene: 'diagnostics' },
                  { label: 'С липсваща зависимост', value: summary.skipped ?? 0, icon: CircleMinus, scene: 'metrics' },
                ].map(({ label, value, icon: Icon, scene }) => (
                  <div key={label} className="operator-metric" data-scene={scene} data-scene-tone="light">
                    <dt><span className="operator-metric-icon"><Icon size={16} aria-hidden="true" /></span>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="tests-timestamp">Последно изпълнение {new Date(summary.ranAt).toLocaleString('bg-BG')}</p>
            </div>
          )}
          {!runnerAvailable && <div className="ice-section operator-status operator-test-status" data-scene="tools" data-scene-tone="light">
            <p className="text-amber-950">Тестовият runner не е наличен в тази среда.</p>
          </div>}
          {categories.map(category => <section className="tests-group" key={category} aria-label={category}>
            <h2>{category}</h2>
            <ul className="tests-group-grid">
            {cases.filter(test => test.category === category).map(test => {
              const result = summary?.results.find(row => row.id === test.id);
              return (
                <li key={test.id} className="ice-section operator-result" data-scene={testScenes[test.id] ?? 'diagnostics'} data-scene-tone="light">
                  <div className="operator-result-content">
                    {result?.status === 'passed' && <CircleCheck className="shrink-0 text-emerald-800" size={19} aria-hidden="true" />}
                    {result?.status === 'failed' && <CircleAlert className="shrink-0 text-rose-800" size={19} aria-hidden="true" />}
                    {result?.status === 'skipped' && <CircleMinus className="shrink-0 text-amber-900" size={19} aria-hidden="true" />}
                    <div>
                      <h3 className="font-semibold">{test.name}</h3>
                      <p className="operator-muted text-sm">
                        {result?.status === 'passed' ? 'Успешно' : result?.status === 'failed' ? 'Неуспешно' : result?.status === 'skipped' ? 'Липсва зависимост' : 'Очаква проверка'}
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
          </section>)}
        </section>
      )}
    </PublicShell>
  );
}
