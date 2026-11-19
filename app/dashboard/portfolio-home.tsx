'use client';

import { useId, useState, type ReactNode } from 'react';
import {
  ArrowDownLeft, ArrowUpRight, BarChart3, ChartCandlestick, ChevronDown,
  Eye, EyeOff, FlaskConical, History, Layers3, Settings2,
  type LucideIcon,
} from 'lucide-react';
import type { PortfolioAccount } from './portfolio-account';
import './portfolio-home.css';

export type PortfolioAction = 'funding' | 'withdrawal';

type PortfolioHomeProps = {
  account: PortfolioAccount;
  market: ReactNode;
  onOpenMarkets: () => void;
  onOpenAccount: () => void;
  onOpenSimulator: () => void;
  onAction: (action: PortfolioAction) => void;
  signInHref?: string;
};

const sofiaDate = new Intl.DateTimeFormat('bg-BG', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Sofia',
});
const dayMs = 86_400_000;

function dateLabel(value: string | number | null) {
  if (value === null) return '';
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? sofiaDate.format(date) : '';
}

function ActionButton({ icon: Icon, label, onClick, description }: {
  icon: LucideIcon; label: string; onClick: () => void; description?: string;
}) {
  return <button className="pf-home-action" type="button" onClick={onClick}
    aria-label={description || label} title={description}>
    <span className="pf-home-action-icon"><Icon size={20} aria-hidden="true" /></span>
    <span>{label}</span>
  </button>;
}

function HistoryChart({ history, currency }: Pick<PortfolioAccount, 'history' | 'currency'>) {
  const [days, setDays] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const gradientId = useId().replace(/:/g, '');
  const end = history.at(-1)?.time;
  if (history.length < 2 || end == null || !currency) return null;
  const points = days === 0 ? history : history.filter(point => point.time >= end - days * dayMs);
  if (points.length === 0) return null;
  const first = points[0], last = points[points.length - 1];
  const values = points.map(point => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const x = (time: number) => 4 + 592 * (time - first.time) / (last.time - first.time || 1);
  const y = (value: number) => max === min ? 48 : 87 - 78 * (value - min) / (max - min);
  const path = points.map((point, index) => (index ? 'L' : 'M') + x(point.time) + ' ' + y(point.value)).join(' ');
  const selected = cursor === null ? null : points[Math.min(cursor, points.length - 1)];
  const formatter = new Intl.NumberFormat('bg-BG', { style: 'currency', currency });
  const ranges = [7, 30, 90, 365].filter(period =>
    history[0].time < end - period * dayMs &&
    history.filter(point => point.time >= end - period * dayMs).length > 1);
  return <section className="pf-home-history" aria-label="История на потвърдените оценки">
    <div className="pf-home-history-title">
      <h2>Стойност във времето</h2>
      {ranges.length > 0 && <div className="pf-home-ranges" role="group" aria-label="Период на оценките">
        {[...ranges, 0].map(period => <button type="button" key={period} aria-pressed={days === period}
          onClick={() => { setDays(period); setCursor(null); }}>
          {period === 0 ? 'Всички' : period === 365 ? '1г' : period + 'д'}
        </button>)}
      </div>}
    </div>
    <div className="pf-home-history-canvas">
      <svg viewBox="0 0 600 98" preserveAspectRatio="none" role="img"
        aria-label={'Потвърдени оценки от ' + dateLabel(first.time) + ' до ' + dateLabel(last.time)}>
        <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#9c9bff" stopOpacity=".23"/><stop offset="100%" stopColor="#7dc8ff" stopOpacity="0"/>
        </linearGradient></defs>
        <path d={path + ' L' + x(last.time) + ' 98 L4 98 Z'} fill={'url(#' + gradientId + ')'}/>
        <path d={path} fill="none" stroke="#9fcaff" strokeWidth="2.5" vectorEffect="non-scaling-stroke"/>
        {selected && <line x1={x(selected.time)} x2={x(selected.time)} y1="1" y2="96" stroke="#bac5e4" strokeDasharray="3 4" />}
      </svg>
      <input className="pf-home-timeline" type="range" min="0" max={points.length - 1}
        aria-label="Разгледай потвърдените оценки" value={cursor === null ? points.length - 1 : Math.min(cursor, points.length - 1)}
        aria-valuetext={formatter.format((selected || last).value) + ' · ' + dateLabel((selected || last).time)}
        onChange={event => setCursor(Number(event.target.value))} />
    </div>
    <div className="pf-home-history-legend">
      {selected ? <><span>{dateLabel(selected.time)}</span><strong>{formatter.format(selected.value)}</strong></> :
        <><span>{dateLabel(first.time)}</span><span>{dateLabel(last.time)}</span></>}
    </div>
  </section>;
}

function AccountLists({ account, hidden, onOpenAccount }: {
  account: PortfolioAccount; hidden: boolean; onOpenAccount: () => void;
}) {
  const [view, setView] = useState<'holdings' | 'activity'>('holdings');
  const [expanded, setExpanded] = useState(false);
  const holdings = view === 'holdings';
  const count = holdings ? account.holdings.length : account.activity.length;
  const visibleCount = expanded ? count : 4;
  const guest = account.status === 'guest';
  const unavailable = account.status === 'unavailable' || (holdings ? account.holdingsStatus : account.activityStatus) === 'unavailable';
  const unlinked = (holdings ? account.holdingsStatus : account.activityStatus) === 'unlinked';
  const emptyText = account.status === 'loading' ? 'Зареждане на сметката…'
    : guest ? (holdings ? 'Влез, за да видиш позициите си.' : 'Влез, за да видиш движенията по сметката си.')
    : unavailable ? (holdings ? 'Позициите са временно недостъпни.' : 'Движенията са временно недостъпни.')
    : unlinked ? 'Няма потвърдена брокерска сметка.'
    : holdings ? (account.holdingsStatus === 'partial' ? 'Изчаква се сверяване на позициите.' : 'Няма отворени позиции.')
    : 'Няма регистрирани движения.';
  const EmptyIcon = holdings ? Layers3 : History;
  const prefix = useId();
  return <section className="pf-home-account" aria-label="Позиции и движения">
    <div className="pf-home-tabs" role="group" aria-label="Съдържание на сметката">
      {(['holdings', 'activity'] as const).map((name, index) => <button type="button" key={name}
        aria-pressed={view === name} aria-controls={prefix + '-list'} onClick={() => { setView(name); setExpanded(false); }}>
        {index === 0 ? <Layers3 size={16} aria-hidden="true"/> : <History size={16} aria-hidden="true"/>}
        {index === 0 ? 'Позиции' : 'Движения'}
      </button>)}
    </div>
    <div className="pf-home-list-box" id={prefix + '-list'} aria-live="polite">
      {count === 0 ? <div className="pf-home-empty">
        <span className="pf-home-empty-icon"><EmptyIcon size={26} strokeWidth={1.45} aria-hidden="true" /></span>
        <h2>{holdings ? 'Моите позиции' : 'Последни движения'}</h2>
        <p>{emptyText}</p>
        {account.status === 'ready' && unlinked && <button className="pf-home-text-link" type="button" onClick={onOpenAccount}>Преглед на сметката</button>}
      </div> : <ul className="pf-home-rows">
        {holdings ? account.holdings.slice(0, visibleCount).map(row => <li key={row.id}>
          <span className="pf-home-row-icon"><ChartCandlestick size={17} aria-hidden="true"/></span>
          <div><b>{row.symbol}</b><small>{row.provider}{row.asOf && ' · ' + dateLabel(row.asOf)}</small></div>
          <strong>{hidden ? '••••' : row.units + ' бр.'}</strong>
        </li>) : account.activity.slice(0, visibleCount).map(row => <li key={row.id}>
          <span className="pf-home-row-icon"><History size={17} aria-hidden="true"/></span>
          <div><b>{row.title}</b><small>{dateLabel(row.time)}{!hidden && row.detail && ' · ' + row.detail}</small></div>
          <span className="pf-home-row-status">{row.status}</span>
        </li>)}
      </ul>}
    </div>
    {count > 4 && <button className="pf-home-list-more" type="button" aria-expanded={expanded}
      onClick={() => setExpanded(!expanded)}>{expanded ? 'Покажи по-малко' : 'Покажи всички (' + count + ')'}<ChevronDown size={15}/></button>}
    {holdings && count > 0 && account.holdingsStatus === 'partial' && <p className="pf-home-list-note">Показани са потвърдените позиции. За част от сметките се изчаква сверяване.</p>}
  </section>;
}

export function PortfolioHome({ account, market, onOpenMarkets, onOpenAccount, onOpenSimulator, onAction, signInHref }: PortfolioHomeProps) {
  const [hidden, setHidden] = useState(false);
  const guest = account.status === 'guest';
  const ready = account.status === 'ready';
  const signIn = guest && signInHref ? signInHref : undefined;
  const hasPrivateValues = Boolean(account.value || account.walletCash || account.brokerCash || account.weeklyResult
    || account.holdings.length || account.activity.length || account.history.length);
  const value = (amount: string | null) => hidden ? '••••' : amount;
  const summary = account.status === 'loading' ? 'Зареждане на сметката…'
    : guest ? 'Влез в SharkAI за баланса, позициите и движенията си.'
    : account.status === 'unavailable' ? 'Връзката със сметката е временно недостъпна.'
    : account.holdingsStatus === 'unlinked' ? 'Няма свързана брокерска сметка.'
    : 'Изчаква се потвърдена оценка от брокера.';
  return <div className="pf-home">
    <div className="pf-home-overview">
      <section className="pf-home-hero" aria-labelledby="pf-home-title">
        <div className="pf-home-hero-content">
          <div className="pf-home-topline">
            <h1 id="pf-home-title" className={account.value ? 'has-value' : undefined}>Моят портфейл</h1>
            {ready && <div className="pf-home-tools">
              {hasPrivateValues && <button type="button" onClick={() => setHidden(!hidden)} aria-pressed={hidden}
                aria-label={hidden ? 'Покажи стойностите в обзора' : 'Скрий стойностите в обзора'} title={hidden ? 'Покажи стойностите' : 'Скрий стойностите'}>
                {hidden ? <EyeOff size={17}/> : <Eye size={17}/>}
              </button>}
              <button type="button" onClick={onOpenAccount} title="Управление на сметката" aria-label="Управление на сметката"><Settings2 size={17}/></button>
            </div>}
          </div>
          {account.value ? <div className="pf-home-value-block">
            <p className="pf-home-caption">Стойност при брокера</p>
            <p className="pf-home-value">{value(account.value)}</p>
            <p className="pf-home-subline">{[account.provider, dateLabel(account.asOf)].filter(Boolean).join(' · ')}</p>
          </div> : <div className="pf-home-intro">
            <p>{summary}</p>
            {guest && (signIn ? <a className="pf-home-cta" href={signIn}>Вход в портфейла</a> :
              <button type="button" className="pf-home-cta" onClick={onOpenAccount}>Вход в портфейла</button>)}
            {account.status === 'unavailable' && <button type="button" className="pf-home-cta" onClick={onOpenAccount}>Преглед на сметката</button>}
          </div>}
          {ready && (account.walletCash || account.brokerCash || account.weeklyResult) && <dl className="pf-home-balances">
            {account.brokerCash && <div><dt>Свободни при брокера</dt><dd>{value(account.brokerCash)}</dd></div>}
            {account.walletCash && <div><dt>Портфейл Wise</dt><dd>{value(account.walletCash)}</dd></div>}
            {account.weeklyResult && <div><dt>Последен седмичен резултат</dt><dd>{value(account.weeklyResult)}</dd></div>}
          </dl>}
        </div>
        <div className="pf-home-actions" role="group" aria-label="Действия с портфейла">
          <ActionButton label="Захранване" icon={ArrowDownLeft}
            description={guest ? 'Вход за захранване на портфейла' : account.canFund ? 'Захранване на портфейла' : 'Условия за захранване на сметката'}
            onClick={() => onAction('funding')}/>
          <ActionButton label="Теглене" icon={ArrowUpRight}
            description={guest ? 'Вход за теглене от портфейла' : account.canWithdraw ? 'Теглене от портфейла' : 'Условия за теглене от сметката'}
            onClick={() => onAction('withdrawal')}/>
          <ActionButton label="Пазари" icon={BarChart3} onClick={onOpenMarkets}/>
          <ActionButton label="Симулатор" icon={FlaskConical} onClick={onOpenSimulator}/>
        </div>
      </section>
      <AccountLists account={account} hidden={hidden} onOpenAccount={onOpenAccount}/>
    </div>
    {!hidden && account.history.length > 1 && account.currency && <HistoryChart history={account.history} currency={account.currency}/>}
    {market}
  </div>;
}
