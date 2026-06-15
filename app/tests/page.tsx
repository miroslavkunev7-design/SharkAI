'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Logo } from '@/components/Logo';
import {
  CheckCircle2, XCircle, Loader2, Play, RefreshCw,
  ArrowLeft, Download, AlertCircle,
} from 'lucide-react';

interface TestResult {
  id: string;
  name: string;
  category: string;
  status: 'passed' | 'failed';
  error?: string;
  duration?: number;
  at?: string;
}

interface TestSummary {
  ranAt: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  results: TestResult[];
}

export default function TestsPage() {
  const [summary, setSummary] = useState<TestSummary | null>(null);
  const [running, setRunning] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [log, setLog] = useState('');
  const [installer, setInstaller] = useState<{ available: boolean; name?: string; size?: number } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/tests');
    const data = await res.json();
    if (data.results) setSummary(data.results);
    setInstaller(data.installer);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function runAll() {
    setRunning(true);
    setLog('Стартирам всички тестове...\n');
    try {
      const res = await fetch('/api/tests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json();
      setLog(data.output || '');
      if (data.results) setSummary(data.results);
    } catch (e) {
      setLog(String(e));
    } finally {
      setRunning(false);
      setRunningId(null);
      load();
    }
  }

  async function runOne(id: string) {
    setRunning(true);
    setRunningId(id);
    setLog(`Тест: ${id}...\n`);
    try {
      const res = await fetch('/api/tests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testId: id }),
      });
      const data = await res.json();
      setLog(data.output || '');
      if (data.results) setSummary(data.results);
    } finally {
      setRunning(false);
      setRunningId(null);
      load();
    }
  }

  async function fixAndRetry() {
    const failed = summary?.results.filter((r) => r.status === 'failed') || [];
    for (const t of failed) {
      await runOne(t.id);
      await new Promise((r) => setTimeout(r, 500));
    }
    await load();
  }

  const results = summary?.results || [];
  const allPassed = summary && summary.failed === 0 && summary.total > 0;

  const PIPELINE = [
    { key: 'Assets', ids: ['files-logo'] },
    { key: 'Config', ids: ['files-agents'] },
    { key: 'API', ids: ['api-status'] },
    { key: 'Chat', ids: ['api-chat-casual', 'api-chat-instant', 'api-chat-context', 'api-chat-doing', 'api-chat-open'] },
    { key: 'Upload', ids: ['api-upload'] },
    { key: 'Build', ids: ['build-screenshot', 'build-api-gen', 'build-db-gen', 'build-prompt-software', 'build-ai-security', 'preview-html'] },
    { key: 'SEO', ids: ['seo-sitemap'] },
    { key: 'Desktop', ids: ['installer-file'] },
    { key: 'Download', ids: ['download-route'] },
  ];

  function nodeStatus(ids: string[]) {
    const matched = results.filter((r) => ids.includes(r.id));
    if (!matched.length) return 'pending';
    if (matched.every((r) => r.status === 'passed')) return 'passed';
    if (matched.some((r) => r.status === 'failed')) return 'failed';
    return 'pending';
  }

  return (
    <div className="min-h-screen bg-shark-black">
      <header className="glass border-b border-white/5">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="text-white/50 hover:text-white"><ArrowLeft className="w-5 h-5" /></Link>
            <Logo size="sm" />
            <span className="font-display font-bold gradient-text">Test Suite</span>
          </div>
          <div className="flex gap-2">
            <button onClick={runAll} disabled={running} className="btn-primary text-sm py-2 px-4 flex items-center gap-2 disabled:opacity-50">
              {running && !runningId ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              Run All
            </button>
            {summary && summary.failed > 0 && (
              <button onClick={fixAndRetry} disabled={running} className="btn-secondary text-sm py-2 px-4 flex items-center gap-2">
                <RefreshCw className="w-4 h-4" /> Retry Failed
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-4 py-8">
        {summary && (
          <div className={`glass rounded-2xl p-6 mb-6 border ${allPassed ? 'border-green-500/30 bg-green-500/5' : 'border-white/10'}`}>
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div>
                <p className="text-2xl font-bold">
                  {allPassed ? (
                    <span className="text-green-400 flex items-center gap-2"><CheckCircle2 /> Всички тестове минаха!</span>
                  ) : (
                    <span>{summary.passed}/{summary.total} passed ({summary.passRate}%)</span>
                  )}
                </p>
                <p className="text-sm text-white/40 mt-1">Последен run: {new Date(summary.ranAt).toLocaleString('bg-BG')}</p>
              </div>
              {installer?.available && (
                <a href="/api/download/installer" className="btn-primary text-sm py-2 px-4 flex items-center gap-2">
                  <Download className="w-4 h-4" /> {installer.name}
                </a>
              )}
            </div>
          </div>
        )}

        <div className="glass rounded-2xl p-6 mb-6 border border-white/10 overflow-x-auto">
          <p className="text-xs uppercase tracking-wider text-white/40 mb-4">Test pipeline graph</p>
          <div className="flex items-center gap-1 min-w-max pb-2">
            {PIPELINE.map((node, i) => {
              const status = nodeStatus(node.ids);
              const passedCount = results.filter((r) => node.ids.includes(r.id) && r.status === 'passed').length;
              const totalCount = node.ids.length;
              return (
                <div key={node.key} className="flex items-center">
                  <div
                    className={`relative rounded-xl px-3 py-3 min-w-[88px] text-center border transition-colors ${
                      status === 'passed'
                        ? 'border-green-500/40 bg-green-500/10'
                        : status === 'failed'
                          ? 'border-red-500/40 bg-red-500/10'
                          : 'border-white/10 bg-white/5'
                    }`}
                  >
                    <div className="flex justify-center mb-1">
                      {status === 'passed' ? (
                        <CheckCircle2 className="w-5 h-5 text-green-400" />
                      ) : status === 'failed' ? (
                        <XCircle className="w-5 h-5 text-red-400" />
                      ) : (
                        <div className="w-5 h-5 rounded-full border border-white/20" />
                      )}
                    </div>
                    <p className="text-xs font-semibold">{node.key}</p>
                    {results.length > 0 && (
                      <p className="text-[10px] text-white/40 mt-0.5">{passedCount}/{totalCount}</p>
                    )}
                  </div>
                  {i < PIPELINE.length - 1 && (
                    <div className={`w-6 h-0.5 mx-0.5 ${status === 'passed' ? 'bg-green-500/50' : 'bg-white/10'}`} />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-2">
          {results.length === 0 && !running && (
            <p className="text-white/40 text-center py-12">Натисни Run All за първи тест</p>
          )}
          {results.map((t) => (
            <div
              key={t.id}
              className={`glass rounded-xl p-4 flex items-center justify-between gap-4 ${
                t.status === 'passed' ? 'border border-green-500/20' : 'border border-red-500/20'
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                {t.status === 'passed' ? (
                  <CheckCircle2 className="w-6 h-6 text-green-400 shrink-0" />
                ) : (
                  <XCircle className="w-6 h-6 text-red-400 shrink-0" />
                )}
                <div className="min-w-0">
                  <p className="font-medium truncate">{t.name}</p>
                  <p className="text-xs text-white/40">{t.category} · {t.id}{t.duration ? ` · ${t.duration}ms` : ''}</p>
                  {t.error && <p className="text-xs text-red-400/80 mt-1">{t.error}</p>}
                </div>
              </div>
              {t.status === 'failed' && (
                <button
                  onClick={() => runOne(t.id)}
                  disabled={running}
                  className="btn-secondary text-xs py-1.5 px-3 shrink-0 flex items-center gap-1"
                >
                  {runningId === t.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  Retry
                </button>
              )}
            </div>
          ))}
        </div>

        {running && (
          <div className="mt-6 glass rounded-xl p-4 flex items-center gap-2 text-sm text-shark-cyan">
            <Loader2 className="w-4 h-4 animate-spin" /> Тестване в ход...
          </div>
        )}

        {log && (
          <pre className="mt-6 text-xs text-white/40 bg-black/40 rounded-xl p-4 overflow-x-auto max-h-48">{log}</pre>
        )}

        {!installer?.available && (
          <div className="mt-6 glass rounded-xl p-4 flex items-start gap-2 text-sm text-yellow-400/80">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <p>Installer липсва — пусни <code className="text-shark-cyan">npm run electron:build</code> за Windows .exe</p>
          </div>
        )}
      </div>
    </div>
  );
}
