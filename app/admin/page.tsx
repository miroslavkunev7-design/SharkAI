'use client';

import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Banknote, BarChart3, Boxes, CalendarCheck, ChevronLeft, ChevronRight, Crown, KeyRound, Landmark, MessageSquare, RefreshCw, Shield, TestTube, Users, Zap, type LucideIcon } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { PerformanceFeesPanel } from './performance-fees';
import { accountPlanLabel, type AccountPlan } from '../account-plan';
import '../operator-workspace.css';
import './workspace.css';

interface AISettings {
  paidAIEnabled: boolean;
  aiConfigured: boolean;
  openai: { hasKey: boolean };
  anthropic: { hasKey: boolean };
}

interface AdminData {
  stats: { totalUsers: number; proUsers: number; ultraUsers: number; totalProjects: number };
  users: AccountRow[];
  account: AccountPlan;
  ai: AISettings;
  billing?: BillingData | null;
  billingError?: string;
  pagination?: { users: PageInfo };
}

type Plan = 'PRO' | 'ULTRA';
type PageInfo = { page: number; pageSize: number; total: number };
type AccountRow = AccountPlan & {
  id: string; email: string; createdAt: string; currentPeriodEnd?: string | null; effectivePlan?: string;
};
type PlanMember = AccountRow & {
  currentPeriodStart: string | null;
  source: 'lifetime' | 'stripe' | 'paypal' | 'bank' | 'mobile' | 'recorded' | 'profile';
  paymentVerified: boolean;
};
type Money = { minor: number; currency: string };
type PendingPayment = { id: string; user: { email: string }; plan: string; amountEur: number | null; paymentMethod: 'bank' | 'mobile'; bankReference: string | null; approvable: boolean };
type PendingPayments = { availability: 'available' | 'unavailable'; reason: string | null; items: PendingPayment[]; total?: number };
type BillingData = {
  metrics: { activeSubscriptions: number; collected: Money | null; mrr: Money | null };
  byPlan: Record<Plan, { items: PlanMember[]; pagination: PageInfo }>;
  pendingPayments: PendingPayments;
  amountsUnavailableReason?: string | null;
};

const dates = new Intl.DateTimeFormat('bg-BG', { dateStyle: 'short' });
const counts = new Intl.NumberFormat('bg-BG');
const euro = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR' });
const sourceLabel = {
  lifetime: 'Администраторски достъп', stripe: 'Stripe', paypal: 'PayPal',
  bank: 'Банков превод', mobile: 'Мобилно плащане', recorded: 'Записан период', profile: 'План в профила',
};

function formatMoney(amount?: Money | null) {
  if (!amount || !Number.isSafeInteger(amount.minor)) return null;
  try {
    const format = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: amount.currency });
    return format.format(amount.minor / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
  } catch { return null; }
}

function DateCell({ value }: { value?: string | null }) {
  const date = value ? new Date(value) : null;
  if (!value || !date || !Number.isFinite(date.valueOf())) return <span aria-label="Няма записана дата">—</span>;
  return <time dateTime={value}>{dates.format(date)}</time>;
}

function AdminSection({ title, icon: Icon, art, id, count, children }: {
  title: string; icon: LucideIcon; art: string; id?: string; count?: number; children: ReactNode;
}) {
  return (
    <section id={id} className="ice-section operator-panel shark-admin-section" data-ice-art={art}>
      <header className="operator-admin-panel-heading shark-admin-section-heading">
        <h2 className="operator-panel-title"><Icon size={19} aria-hidden="true" /> {title}</h2>
        {count !== undefined && <span className="shark-admin-count">{counts.format(count)}</span>}
      </header>
      {children}
    </section>
  );
}

function Pager({ pagination, label, busy, go }: { pagination?: PageInfo; label: string; busy: boolean; go: (page: number) => void }) {
  if (!pagination) return null;
  const { page, pageSize, total } = pagination;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (lastPage === 1 && page === 1) return null;
  const start = (page - 1) * pageSize + 1;
  const range = page > lastPage ? 'Няма записи на тази страница.' : `${counts.format(start)}–${counts.format(Math.min(page * pageSize, total))} от ${counts.format(total)}`;
  return (
    <nav className="shark-admin-pager" aria-label={label}>
      <span>{range}</span>
      <button type="button" className="shark-action-secondary" disabled={busy || page <= 1} aria-label={`Предишна страница · ${label}`} onClick={() => go(Math.min(page - 1, lastPage))}><ChevronLeft size={17} aria-hidden="true" /></button>
      <button type="button" className="shark-action-secondary" disabled={busy || page >= lastPage} aria-label={`Следваща страница · ${label}`} onClick={() => go(page + 1)}><ChevronRight size={17} aria-hidden="true" /></button>
    </nav>
  );
}

function PlanSection({ plan, data, loading, go }: { plan: Plan; data?: BillingData['byPlan'][Plan]; loading: boolean; go: (page: number) => void }) {
  const title = `${plan} абонаменти и достъп`;
  const empty = data ? (data.pagination.total ? 'Няма записи на тази страница.' : `Няма потребители с активен ${plan} достъп.`) : 'Данните за достъпа са недостъпни.';
  return (
    <AdminSection title={title} icon={plan === 'PRO' ? Crown : Zap} art={plan === 'PRO' ? 'agent' : 'team'} count={data?.pagination.total}>
      {!data?.items.length ? <p className="operator-admin-panel-data">{empty}</p> : (
        <div className="operator-admin-panel-data operator-table shark-admin-table">
          <table>
            <thead><tr><th scope="col">Имейл</th><th scope="col">От</th><th scope="col">До</th><th scope="col">Основание</th></tr></thead>
            <tbody>{data.items.map((member) => <tr key={member.id}>
              <td>{member.email}</td>
              <td><DateCell value={member.lifetime ? null : member.currentPeriodStart} /></td>
              <td>{member.lifetime ? 'Безсрочен достъп' : <DateCell value={member.currentPeriodEnd} />}</td>
              <td>{sourceLabel[member.source]}{member.source === 'stripe' && !member.paymentVerified && <small>Без потвърдено плащане</small>}</td>
            </tr>)}</tbody>
          </table>
        </div>
      )}
      <Pager pagination={data?.pagination} label={title} busy={loading} go={go} />
    </AdminSection>
  );
}

function UsersSection({ users, pagination, loading, go }: { users: AccountRow[]; pagination?: PageInfo; loading: boolean; go: (page: number) => void }) {
  return (
    <AdminSection title="Всички потребители" icon={Users} art="team" count={pagination?.total}>
      {!users.length ? <p className="operator-admin-panel-data">{pagination?.total ? 'Няма записи на тази страница.' : 'Няма потребителски записи.'}</p> : (
        <div className="operator-admin-panel-data operator-table shark-admin-table shark-admin-users">
          <table>
            <thead><tr><th scope="col">Имейл</th><th scope="col">План</th><th scope="col">Достъп до</th><th scope="col">Регистрация</th></tr></thead>
            <tbody>{users.map((user) => <tr key={user.id}>
              <td>{user.email}</td>
              <td><span className="shark-admin-tier" data-plan={user.effectivePlan ?? user.plan}>{user.effectivePlan ?? user.plan}</span></td>
              <td>{user.lifetime ? 'Безсрочен достъп' : <DateCell value={user.currentPeriodEnd} />}</td>
              <td><DateCell value={user.createdAt} /></td>
            </tr>)}</tbody>
          </table>
        </div>
      )}
      <Pager pagination={pagination} label="Всички потребители" busy={loading} go={go} />
    </AdminSection>
  );
}

function TransfersSection({ data, busy, approve }: { data?: PendingPayments; busy: boolean; approve: (item: PendingPayment, reference: string, amount: number) => Promise<void> }) {
  const [target, setTarget] = useState<PendingPayment | null>(null);
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const referenceField = useRef<HTMLInputElement>(null);
  const available = data?.availability === 'available';
  const total = available ? data.total ?? data.items.length : undefined;

  useEffect(() => {
    if (target) referenceField.current?.focus();
  }, [target]);

  function choose(item: PendingPayment) {
    setTarget(item);
    setReference('');
    setAmount('');
    setError('');
    setNotice('');
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !target || !data?.items.some((item) => item.id === target.id && item.approvable)) return;
    const receivedAmount = Number(amount.trim().replace(',', '.'));
    if (!reference.trim() || !Number.isFinite(receivedAmount) || receivedAmount <= 0) {
      setError('Въведи получената сума и основанието от платежния документ.');
      return;
    }
    setError('');
    try {
      await approve(target, reference.trim(), receivedAmount);
      setTarget(null);
      setNotice('Плащането е потвърдено и планът е активиран.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Плащането не можа да се потвърди.');
    }
  }

  return (
    <AdminSection title="Чакащи банкови и мобилни плащания" icon={Landmark} art="markets" count={total}>
      {notice && <p className="operator-admin-panel-data" role="status">{notice}</p>}
      {!available ? <p className="operator-admin-panel-data">{data?.reason || 'Няма потвърден източник за банкови и мобилни плащания.'}</p>
        : !data.items.length ? <p className="operator-admin-panel-data">Няма чакащи плащания.</p> : (
          <>
            <div className="operator-admin-panel-data operator-table shark-admin-table">
            <table>
              <thead><tr><th scope="col">Имейл</th><th scope="col">План</th><th scope="col">Сума</th><th scope="col">Метод</th></tr></thead>
              <tbody>{data.items.map((item) => <Fragment key={item.id}>
                <tr><td>{item.user.email}</td><td>{item.plan}</td><td>{item.amountEur === null ? '—' : euro.format(item.amountEur)}</td>
                  <td>{sourceLabel[item.paymentMethod]}{item.bankReference && <small>Основание {item.bankReference}</small>}</td></tr>
                {item.approvable && target?.id !== item.id && <tr><td colSpan={4}>
                  <button className="shark-action-secondary" type="button" disabled={busy} onClick={() => choose(item)}>Свери полученото плащане</button>
                </td></tr>}
              </Fragment>)}</tbody>
            </table>
            </div>
            {total !== undefined && total > data.items.length && <p className="operator-admin-panel-data text-sm">Показани са {data.items.length} от {total} чакащи заявки.</p>}
          </>
        )}
      {target && available && data.items.some((item) => item.id === target.id && item.approvable) && (
        <form className="operator-admin-panel-data grid gap-3" aria-busy={busy} onSubmit={confirm}>
          <p className="text-sm">Свери получения превод за {target.user.email} и план {target.plan} с платежния документ.</p>
          <label className="grid gap-1 text-sm">Основание на получения превод
            <input ref={referenceField} className="operator-input" disabled={busy} required value={reference} onChange={(event) => setReference(event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm">Получена сума в EUR
            <input className="operator-input" disabled={busy} required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
          </label>
          {error && <p role="alert" className="operator-admin-error">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="shark-action" disabled={busy}>Потвърди получения превод</button>
            <button type="button" className="shark-action-secondary" disabled={busy} onClick={() => setTarget(null)}>Отказ</button>
          </div>
        </form>
      )}
    </AdminSection>
  );
}

function TelegramPairingPanel() {
  const [state, setState] = useState<{ linked: boolean; configured: boolean } | null>(null);
  const [challenge, setChallenge] = useState<{ code: string; expires_at: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const command = challenge ? '/start ' + challenge.code : '';

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setError('');
    setBusy(true);
    try {
      const response = await fetch('/api/admin/telegram', { cache: 'no-store', signal });
      if (!response.ok) throw new Error('Pairing status unavailable');
      const latest: { linked: boolean; configured: boolean } = await response.json();
      if (signal?.aborted) return;
      setState(latest);
      if (latest.linked) setChallenge(null);
    } catch {
      if (!signal?.aborted) setError('Статусът на Telegram връзката е недостъпен.');
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  async function changePairing(method: 'POST' | 'DELETE') {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/admin/telegram', { method, cache: 'no-store' });
      if (!response.ok) throw new Error('Pairing change failed');
      if (method === 'POST') {
        const issued: { code: string; expires_at: string } = await response.json();
        setChallenge(issued);
      } else {
        setState((previous) => previous && { ...previous, linked: false });
        setChallenge(null);
        setNotice('Връзката и активният код са отменени.');
      }
    } catch {
      setError('Промяната не можа да се извърши. Обнови статуса и опитай отново.');
    } finally {
      setBusy(false);
    }
  }

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setNotice('Командата е копирана.');
    } catch {
      setNotice('Маркирай и копирай командата от полето.');
    }
  }

  return (
    <AdminSection id="telegram" title="Telegram" icon={MessageSquare} art="agent">
      <div className="operator-admin-panel-data grid gap-3" aria-busy={busy}>
        {state?.linked && <p>Свързан администраторски Telegram чат.</p>}
        {state && !state.linked && (
          <p>{state.configured ? 'Свържи своя частен чат за работа с Shark AI.' : 'Telegram услугата предстои да се настрои.'}</p>
        )}
        {challenge && (
          <label className="grid gap-2 text-sm">
            Изпрати еднократната команда на потвърдения Shark AI бот в частен чат.
            <input className="operator-input font-mono" readOnly value={command} onFocus={(event) => event.target.select()} />
            <small className="operator-muted">
              Валидна до {new Date(challenge.expires_at).toLocaleTimeString('bg-BG', {
                timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit',
              })} софийско време.
            </small>
          </label>
        )}
        {error && <p role="alert" className="operator-admin-error">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <div className="flex flex-wrap gap-2">
          {state?.configured && !state.linked && (
            <button className="shark-action" type="button" disabled={busy} onClick={() => void changePairing('POST')}>
              {challenge ? 'Издай нов код' : 'Издай код'}
            </button>
          )}
          {challenge && (
            <button className="shark-action-secondary" type="button" disabled={busy} onClick={() => void copyCommand()}>
              Копирай командата
            </button>
          )}
          {(state?.linked || challenge) && (
            <button className="shark-action-secondary" type="button" disabled={busy} onClick={() => void changePairing('DELETE')}>
              {state?.linked ? 'Прекъсни връзката' : 'Отмени кода'}
            </button>
          )}
          <button className="shark-action-secondary" type="button" disabled={busy} onClick={() => void refresh()}>
            Обнови статуса
          </button>
        </div>
      </div>
    </AdminSection>
  );
}

export default function AdminPage() {
  const router = useRouter();
  const [data, setData] = useState<AdminData | null>(null);
  const [loading, setLoading] = useState(true);
  const [pages, setPages] = useState({ users: 1, PRO: 1, ULTRA: 1 });
  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [paidAIOverride, setPaidAIOverride] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const paidAI = paidAIOverride ?? data?.ai.paidAIEnabled ?? false;
  const approvalLock = useRef(false);
  const busy = loading || saving || testing || approving;

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ usersPage: String(pages.users), proPage: String(pages.PRO), ultraPage: String(pages.ULTRA) });
      const response = await fetch(`/api/admin?${query}`, { cache: 'no-store', signal });
      if (response.status === 403) {
        setData(null);
        router.replace('/login');
        return;
      }
      if (!response.ok) throw new Error('Административните данни са недостъпни.');
      const admin: AdminData = await response.json();
      if (!signal?.aborted) setData(admin);
    } catch (err) {
      if (!signal?.aborted) setError(err instanceof Error ? err.message : 'Зареждането прекъсна.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [pages, router]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function go(target: keyof typeof pages, page: number) {
    setPages((current) => ({ ...current, [target]: page }));
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setSettingsError('');
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
      const result = await response.json().catch(() => null);
      if (!response.ok || typeof result?.paidAIEnabled !== 'boolean') throw new Error(result?.error || 'Настройките не бяха запазени.');
      setData((previous) => previous ? { ...previous, ai: result } : previous);
      setPaidAIOverride(null);
      setOpenaiKey('');
      setAnthropicKey('');
      setStatus('Настройките са запазени.');
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Настройките не бяха запазени.');
    } finally {
      setSaving(false);
    }
  }

  async function testProvider() {
    if (busy) return;
    setTesting(true);
    setSettingsError('');
    setStatus('');
    try {
      const response = await fetch('/api/admin/ai-test', { method: 'POST' });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok || typeof result.reply !== 'string') throw new Error(result?.error || 'AI проверката не беше успешна.');
      setStatus(result.reply);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'AI проверката не беше успешна.');
    } finally {
      setTesting(false);
    }
  }

  async function approveTransfer(item: PendingPayment, reference: string, amount: number) {
    if (!item.approvable || busy || approvalLock.current) throw new Error('Действието временно е недостъпно.');
    approvalLock.current = true;
    setApproving(true);
    try {
      const response = await fetch('/api/admin/payments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionId: item.id, verified: true, reference, amount }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true || result.subscription?.id !== item.id || result.subscription.status !== 'active') {
        throw new Error(result?.error || 'Плащането не можа да се потвърди.');
      }
      setData((previous) => previous?.billing ? { ...previous, billing: { ...previous.billing, pendingPayments: {
        ...previous.billing.pendingPayments,
        items: previous.billing.pendingPayments.items.filter(({ id }) => id !== item.id),
        total: previous.billing.pendingPayments.total === undefined ? undefined : Math.max(0, previous.billing.pendingPayments.total - 1),
      } } } : previous);
      await load();
    } finally {
      approvalLock.current = false;
      setApproving(false);
    }
  }

  const metrics = data?.billing?.metrics;
  const transfers = data?.billing?.pendingPayments;
  const collected = formatMoney(metrics?.collected);
  const mrr = formatMoney(metrics?.mrr);
  const cards = data ? [
    { label: 'Регистрирани', value: data.stats.totalUsers, icon: Users, art: 'team' },
    { label: 'PRO в профила', value: data.stats.proUsers, icon: Crown, art: 'agent' },
    { label: 'ULTRA в профила', value: data.stats.ultraUsers, icon: Zap, art: 'team' },
    { label: 'Събрани плащания', value: collected, icon: Banknote, art: 'markets' },
    { label: 'Месечен приход (MRR)', value: mrr, icon: BarChart3, art: 'markets' },
    { label: 'Активни абонаменти', value: metrics?.activeSubscriptions ?? null, icon: CalendarCheck, art: 'agent' },
    { label: 'Чакащи плащания', value: transfers?.availability === 'available' ? transfers.total ?? transfers.items.length : null, icon: Landmark, art: 'markets' },
    { label: 'Проекти', value: data.stats.totalProjects, icon: Boxes, art: 'studio' },
  ] : [];

  return (
    <main className="operator-workspace operator-admin shark-admin mx-auto max-w-6xl px-3 py-4 sm:px-6 sm:py-6">
      <header className="operator-topbar shark-admin-topbar">
        <div className="shark-admin-brand">
          <Link href="/dashboard?view=settings" className="shark-action-secondary operator-icon-button" aria-label="Към настройките на акаунта"><ArrowLeft size={18} aria-hidden="true" /></Link>
          <Logo size="sm" />
          <h1>Администрация</h1>
        </div>
        {data && <span className="operator-plan shark-admin-plan"><Shield size={14} aria-hidden="true" /> {accountPlanLabel(data.account, 'План ')}</span>}
        <Link href="/chat" className="shark-action shark-admin-chat"><MessageSquare size={17} aria-hidden="true" /> Чат</Link>
        <button className="shark-action-secondary operator-icon-button shark-admin-refresh" type="button" onClick={() => void load()} disabled={busy} aria-label="Обнови">
          <RefreshCw size={17} aria-hidden="true" className={loading ? 'animate-spin' : undefined} />
        </button>
      </header>
      {loading && !data && <div role="status" className="ice-section operator-admin-notice" data-ice-art="team"><p>Зареждане на административните данни…</p></div>}
      {error && <div role="alert" className="ice-section operator-admin-notice" data-ice-art="agent"><p className="operator-admin-error">{error}</p></div>}
      {data && (
        <>
          <dl className="shark-admin-metrics" aria-label="Обобщение" aria-busy={loading}>
            {cards.map(({ icon: Icon, label, value, art }) => (
              <div key={label} className="ice-section shark-admin-metric" data-ice-art={art}>
                <dt><Icon size={17} aria-hidden="true" />{label}</dt>
                <dd data-unavailable={value === null || undefined}>{value === null ? 'Недостъпно' : typeof value === 'number' ? counts.format(value) : value}</dd>
              </div>
            ))}
          </dl>
          {(collected === null || mrr === null) && <p className="shark-admin-metrics-note">{data.billingError || data.billing?.amountsUnavailableReason || 'Липсват потвърдени данни за паричните показатели.'}</p>}
          <div className="shark-admin-columns">
            <PlanSection plan="PRO" data={data.billing?.byPlan?.PRO} loading={busy} go={(page) => go('PRO', page)} />
            <PlanSection plan="ULTRA" data={data.billing?.byPlan?.ULTRA} loading={busy} go={(page) => go('ULTRA', page)} />
          </div>
          <UsersSection users={data.users} pagination={data.pagination?.users} loading={busy} go={(page) => go('users', page)} />
          <div className="shark-admin-columns">
            <AdminSection id="settings" title="AI настройки" icon={KeyRound} art="agent">
              <form className="operator-admin-panel-data grid gap-3" onSubmit={saveSettings} aria-busy={saving || testing}>
                <p className="operator-muted text-sm">{data.ai.aiConfigured ? 'Има конфигуриран доставчик.' : 'Няма разрешен и конфигуриран доставчик.'}</p>
                <label className="flex gap-3 items-center min-h-11">
                  <input type="checkbox" className="h-5 w-5 shrink-0 accent-blue-700" checked={paidAI} disabled={saving || testing} onChange={(event) => setPaidAIOverride(event.target.checked)} />
                  Разреши конфигурираните AI услуги
                </label>
                <label className="grid gap-2 text-sm">OpenAI API ключ
                  {data.ai.openai.hasKey && <small className="operator-muted">Запазен ключ</small>}
                  <input type="password" value={openaiKey} onChange={(event) => setOpenaiKey(event.target.value)} disabled={saving || testing} className="operator-input" autoComplete="off" />
                </label>
                <label className="grid gap-2 text-sm">Anthropic API ключ
                  {data.ai.anthropic.hasKey && <small className="operator-muted">Запазен ключ</small>}
                  <input type="password" value={anthropicKey} onChange={(event) => setAnthropicKey(event.target.value)} disabled={saving || testing} className="operator-input" autoComplete="off" />
                </label>
                {settingsError && <p role="alert" className="operator-admin-error">{settingsError}</p>}
                {status && <p role="status">{status}</p>}
                <div className="flex flex-wrap gap-2">
                  <button className="shark-action" type="submit" disabled={busy}>{saving ? 'Запазване…' : 'Запази настройките'}</button>
                  {data.ai.aiConfigured && <button className="shark-action-secondary" type="button" onClick={testProvider} disabled={busy}>
                    <TestTube size={17} aria-hidden="true" /> {testing ? 'Проверка…' : 'Провери връзката'}
                  </button>}
                </div>
              </form>
            </AdminSection>
            <TransfersSection data={transfers} busy={busy} approve={approveTransfer} />
          </div>
          <TelegramPairingPanel />
          <AdminSection id="performance-fees" title="Регистрации и комисиони" icon={Banknote} art="markets">
            <PerformanceFeesPanel />
          </AdminSection>
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
