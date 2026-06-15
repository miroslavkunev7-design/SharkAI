'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Logo } from '@/components/Logo';
import {
  Users, DollarSign, Cpu, Server, AlertTriangle,
  BarChart3, Settings, Shield, ArrowLeft, RefreshCw,
  MessageSquare, Key, Check, Zap, TestTube,
} from 'lucide-react';

interface AdminStats {
  totalUsers: number;
  proUsers: number;
  ultraUsers: number;
  totalProjects: number;
  revenue: number;
  activeAgents: number;
  serverUptime: number;
  errorRate: number;
}

interface AISettings {
  paidAIEnabled: boolean;
  aiConfigured: boolean;
  localMode: boolean;
  openai: { hasKey: boolean; preview: string | null };
  anthropic: { hasKey: boolean; preview: string | null };
}

export default function AdminPage() {
  const router = useRouter();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<Array<{ id: string; email: string; plan: string; role: string; tokensUsed: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [paidAI, setPaidAI] = useState(false);
  const [ai, setAi] = useState<AISettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [adminRes, settingsRes] = await Promise.all([
      fetch('/api/admin'),
      fetch('/api/settings'),
    ]);

    if (adminRes.status === 403) {
      router.push('/login');
      return;
    }

    const admin = await adminRes.json();
    const settings = await settingsRes.json();

    setStats(admin.stats);
    setUsers(admin.users || []);
    setAi(settings);
    setPaidAI(settings.paidAIEnabled);
    setLoading(false);
  }, [router]);

  useEffect(() => { load(); }, [load]);

  async function saveSettings() {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paidAIEnabled: paidAI,
        openaiKey: openaiKey || undefined,
        anthropicKey: anthropicKey || undefined,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      setAi(data);
      setOpenaiKey('');
      setAnthropicKey('');
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    }
  }

  async function testApi() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/admin/ai-test', { method: 'POST' });
      const data = await res.json();
      setTestResult(data.ok ? `✅ ${data.reply}` : `❌ ${data.error}`);
    } catch {
      setTestResult('❌ Тестът не успя');
    } finally {
      setTesting(false);
    }
  }

  const cards = stats ? [
    { icon: Users, label: 'Total Users', value: stats.totalUsers, color: 'text-shark-cyan' },
    { icon: DollarSign, label: 'Monthly Revenue', value: `€${stats.revenue}`, color: 'text-green-400' },
    { icon: Cpu, label: 'Active Agents', value: stats.activeAgents, color: 'text-shark-purple' },
    { icon: Server, label: 'Server Uptime', value: `${stats.serverUptime}%`, color: 'text-shark-blue' },
    { icon: BarChart3, label: 'Total Projects', value: stats.totalProjects, color: 'text-shark-cyan' },
    { icon: AlertTriangle, label: 'Error Rate', value: `${stats.errorRate}%`, color: 'text-yellow-400' },
  ] : [];

  return (
    <div className="min-h-screen bg-shark-black">
      <header className="glass border-b border-white/5">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-white/50 hover:text-white"><ArrowLeft className="w-5 h-5" /></Link>
            <Logo size="sm" />
            <span className="font-display font-bold gradient-text">Admin Panel</span>
            <span className="text-xs bg-shark-purple/30 text-shark-purple px-2 py-1 rounded-full flex items-center gap-1">
              <Shield className="w-3 h-3" /> ULTRA
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/chat" className="btn-primary text-sm py-2 px-4 flex items-center gap-2">
              <MessageSquare className="w-4 h-4" /> Supreme Brain Chat
            </Link>
            <button onClick={() => load()} className="btn-secondary text-sm py-2 px-3">
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 py-8">
        {loading ? (
          <div className="text-center py-20 text-white/50">Loading...</div>
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 mb-8">
              {cards.map(({ icon: Icon, label, value, color }) => (
                <div key={label} className="glass rounded-xl p-4">
                  <Icon className={`w-5 h-5 ${color} mb-2`} />
                  <p className="text-2xl font-bold">{value}</p>
                  <p className="text-xs text-white/40">{label}</p>
                </div>
              ))}
            </div>

            <div className="grid lg:grid-cols-2 gap-8">
              <div id="settings" className="glass rounded-2xl p-6 border-shark-cyan/20">
                <h3 className="font-semibold mb-4 flex items-center gap-2">
                  <Key className="w-5 h-5 text-shark-cyan" /> AI API Settings
                </h3>

                <label className="flex items-center gap-3 mb-4 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={paidAI}
                    onChange={(e) => setPaidAI(e.target.checked)}
                    className="w-4 h-4 rounded accent-shark-cyan"
                  />
                  <span className="text-sm">
                    {paidAI
                      ? '✅ Платен AI включен (OpenAI / Anthropic)'
                      : '⚡ Локален режим — безплатно, без API ключ'}
                  </span>
                </label>

                {ai?.localMode && !paidAI && (
                  <p className="text-xs text-white/40 mb-4 flex items-center gap-1">
                    <Zap className="w-3 h-3" /> Чат, screenshot и ZIP работят локално
                  </p>
                )}

                <div className="space-y-3 mb-4">
                  <div>
                    <label className="text-xs text-white/50 mb-1 block">OpenAI API Key</label>
                    {ai?.openai.hasKey && (
                      <p className="text-xs text-green-400/80 mb-1">Запазен: {ai.openai.preview}</p>
                    )}
                    <input
                      type="password"
                      value={openaiKey}
                      onChange={(e) => setOpenaiKey(e.target.value)}
                      placeholder="sk-..."
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-shark-cyan/50"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-white/50 mb-1 block">Anthropic API Key (опционално)</label>
                    {ai?.anthropic.hasKey && (
                      <p className="text-xs text-green-400/80 mb-1">Запазен: {ai.anthropic.preview}</p>
                    )}
                    <input
                      type="password"
                      value={anthropicKey}
                      onChange={(e) => setAnthropicKey(e.target.value)}
                      placeholder="sk-ant-..."
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-shark-cyan/50"
                    />
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={saveSettings}
                    className="btn-primary flex-1 flex items-center justify-center gap-2"
                  >
                    {saved ? <><Check className="w-4 h-4" /> Запазено!</> : 'Запази настройки'}
                  </button>
                  {paidAI && (
                    <button
                      onClick={testApi}
                      disabled={testing}
                      className="btn-secondary flex items-center gap-2 px-4"
                    >
                      <TestTube className="w-4 h-4" />
                      {testing ? '...' : 'Test'}
                    </button>
                  )}
                </div>
                {testResult && <p className="text-xs mt-2 text-white/60">{testResult}</p>}
              </div>

              <div className="glass rounded-2xl p-6">
                <h3 className="font-semibold mb-4 flex items-center gap-2">
                  <Users className="w-5 h-5 text-shark-cyan" /> Users
                </h3>
                <div className="overflow-x-auto max-h-64">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-white/40 border-b border-white/10">
                        <th className="text-left py-2">Email</th>
                        <th className="text-left py-2">Plan</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((user) => (
                        <tr key={user.id} className="border-b border-white/5">
                          <td className="py-2 truncate max-w-[200px]">{user.email}</td>
                          <td className="py-2"><span className="text-xs text-shark-cyan">{user.plan}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="glass rounded-2xl p-6 lg:col-span-2">
                <h3 className="font-semibold mb-4 flex items-center gap-2">
                  <Settings className="w-5 h-5 text-shark-purple" /> Quick Links
                </h3>
                <div className="grid sm:grid-cols-3 gap-3">
                  <Link href="/chat" className="bg-white/5 rounded-xl p-4 hover:bg-white/10 transition-colors text-center">
                    <MessageSquare className="w-6 h-6 mx-auto mb-2 text-shark-cyan" />
                    <span className="text-sm">AI Chat</span>
                  </Link>
                  <Link href="/dashboard" className="bg-white/5 rounded-xl p-4 hover:bg-white/10 transition-colors text-center">
                    <Cpu className="w-6 h-6 mx-auto mb-2 text-shark-purple" />
                    <span className="text-sm">Studio</span>
                  </Link>
                  <Link href="/pricing" className="bg-white/5 rounded-xl p-4 hover:bg-white/10 transition-colors text-center">
                    <DollarSign className="w-6 h-6 mx-auto mb-2 text-green-400" />
                    <span className="text-sm">Pricing</span>
                  </Link>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
