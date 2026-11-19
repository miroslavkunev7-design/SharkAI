'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { portfolioOrderLabels } from './portfolio-account';
import { useCallback, useEffect, useState } from 'react';
import { displayMinor, minorToInput, type WalletSettingsInput } from '@/lib/wallet-investments-contract';
import type { WalletInvestmentsDashboard, WalletInvestmentsOwnerDashboard } from '@/lib/wallet-investments-server';
import { WalletInvestmentsForm } from './wallet-investments-form';
import { WalletProviderActions } from './wallet-provider-actions';
import { TradingConsent } from './trading-consent';
import { ResearchPanel } from './research';
import {isWalletOwnerDashboard} from './wallet-dashboard-shape';
import {InvestmentNavigation,type InvestmentTab} from './investment-navigation';
import {InvestmentFeeCalculator} from './investment-fee-calculator';
import {InvestmentProgress,InvestmentOpportunities} from './investment-progress';
import {CryptoMarketPanel} from './crypto-market';
import {SharkStrategyChat} from './shark-strategy-chat';
import WalletForecast from './wallet-forecast';
import './wallet-investments.css';

const API = '/api/wallet-investments';

const sourceNames: Record<string, string> = {
  wise_balance_api: 'Wise · Баланс',
  ibkr_portfolio_analyst_net_strategy: 'Interactive Brokers · PortfolioAnalyst',
  saxo_account_history_net_strategy: 'Saxo · История на сметката',
  ibkr_broker_settled_cash: 'Interactive Brokers · Разполагаеми средства',
  saxo_broker_settled_cash: 'Saxo · Разполагаеми средства',
  'ibkr:ibkr_verified_weekly_report': 'Interactive Brokers · Седмичен отчет',
  'saxo:saxo_verified_weekly_report': 'Saxo · Седмичен отчет',
};

function sourceName(value: string | null) {
  return value ? sourceNames[value] ?? value : 'Недостъпно';
}

async function request(path: string, options?: RequestInit) {
  const response = await fetch(API + path, { cache: 'no-store', ...options });
  const body = await response.json().catch(() => null);
  return { response, body };
}

function dateLabel(value: string | null, includeTime = false) {
  if (!value) return 'Недостъпно';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return 'Недостъпно';
  return new Intl.DateTimeFormat('bg-BG', {
    dateStyle: 'medium', timeZone: includeTime ? 'Europe/Sofia' : 'UTC',
    ...(includeTime && { timeStyle: 'short' }),
  }).format(parsed);
}

const walletProviderCopy = {
  provider_unconfigured: 'Доставчик на портфейла предстои да бъде свързан.',
  provider_unlinked: 'Няма потвърдена връзка на портфейла към този профил и валута.',
  unavailable: 'Данните от доставчика са временно недостъпни.',
  stale: 'Последните данни от доставчика са остарели.',
  verified: 'Балансът е проверен при доставчика.',
} as const;

const brokerProviderCopy = {
  provider_unconfigured: 'Връзката с брокер предстои да бъде настроена.',
  provider_unlinked: 'Няма потвърдена брокерска сметка за този профил и валута.',
  unavailable: 'Данните от брокера са временно недостъпни.',
  stale: 'Последните данни от брокера са остарели.',
  verified: 'Наличността е проверена при брокера.',
} as const;

type BrokerActivity = WalletInvestmentsOwnerDashboard['broker_activity'];
const reconciliationStatus = {
  verified: 'Сверени позиции', pending: 'Предстои сверяване на позициите',
  stale: 'Данните за позициите са остарели', unavailable: 'Данните за позициите са недостъпни',
} as const;

function BrokerActivityPanel({ activity }: { activity: BrokerActivity }) {
  if (activity.status !== 'available') {
    return <p role="status">{activity.status === 'unavailable' ? 'Данните за сделки са временно недостъпни.' : 'Липсва потвърдена връзка с брокера за позиции и поръчки.'}</p>;
  }
  return activity.accounts.map((account, index) => (
    <div className="module-wallet-broker-activity" key={index}>
      <h3>{account.provider === 'ibkr' ? 'Interactive Brokers' : 'Saxo'} · {account.currency}</h3>
      {account.halted_at && <p>Новите автоматични поръчки са спрени от {dateLabel(account.halted_at, true)}.</p>}
      <p>{reconciliationStatus[account.reconciliation]}{account.snapshot_at && ' · ' + dateLabel(account.snapshot_at, true)}</p>
      {account.positions && <>
        <h4>Сверени управлявани позиции</h4>
        {account.positions.length === 0 ? <p>Няма сверени управлявани позиции към проверката.</p> : (
          <ul>{account.positions.map((position, row) => <li key={row}>{position.instrument} · {position.units} бр.</li>)}</ul>
        )}
      </>}
      <h4>Последни поръчки</h4>
      {account.recent_orders.length === 0 ? <p>Няма записи за поръчки.</p> : (
        <ul>{account.recent_orders.map((order, row) => (
          <li key={row}>
            <strong>{order.side === 'BUY' ? 'Покупка' : 'Продажба'} · {order.instrument}</strong>
            <span>{portfolioOrderLabels[order.status]} · {order.units} бр.</span>
            {order.provider_observed_at && ['FILLED', 'PARTIALLY_FILLED', 'CANCELED'].includes(order.status) && <span>Изпълнени {order.filled_units} бр.</span>}
            <span>{order.provider_observed_at ? 'Данни от брокера към ' + dateLabel(order.provider_observed_at, true) : 'Записано на ' + dateLabel(order.recorded_at, true)}</span>
            {order.reconciliation_required && <span>Изисква сверяване с брокера</span>}
          </li>
        ))}</ul>
      )}
    </div>
  ));
}

function Forecast({ data }: { data: WalletInvestmentsDashboard }) {
  const { forecast, settings } = data;
  const budget=data.investments.profit_budget;
  const available = forecast.status === 'available';
  return (
    <section className="ice-section module-panel module-wallet-panel" data-ice-art="markets" aria-labelledby="wallet-forecast-title">
      <h2 id="wallet-forecast-title">{available ? 'Исторически диапазон на печалба или загуба' : 'Очакван диапазон на печалба или загуба'}</h2>
      <p>Агентът може да използва само вече реализирана нетна печалба, потвърдена като отделени и разполагаеми средства при брокера. Личният депозит е извън търговския бюджет.</p>
      <dl className="module-wallet-metrics">
        <div><dt>Защитена главница</dt><dd>{displayMinor(budget.protected_principal_minor,budget.currency)}</dd></div>
        <div><dt>Реализиран резултат след такси и загуби</dt><dd>{displayMinor(budget.settled_realized_profit_minor,budget.currency)}</dd></div>
        <div><dt>Свободна отделена печалба</dt><dd>{budget.status==='verified' ? displayMinor(budget.available_profit_minor,budget.currency) : 'Непотвърдена'}</dd></div>
        <div><dt>Нереализирани загуби по позиции</dt><dd>{budget.unrealized_loss_minor===null ? 'Непотвърдени' : displayMinor(budget.unrealized_loss_minor==='0' ? '0' : '-'+budget.unrealized_loss_minor,budget.currency)}</dd></div>
        <div><dt>Резерв за такса върху печалбата</dt><dd>{displayMinor(budget.performance_fee_hold_minor,budget.currency)}</dd></div>
        <div><dt>Допустим търговски бюджет</dt><dd>{forecast.authorized_funded_minor==='0' && !forecast.currency ? '0' : displayMinor(forecast.authorized_funded_minor,forecast.currency)}</dd></div>
      </dl>
      {!available ? <p role="status">{forecast.reason === 'unverified_profit_capital'
        ? 'Няма потвърдена отделена печалба за търговия. Бюджетът е нула.'
        : forecast.reason === 'no_authorized_capital' ? 'Няма разрешена печалба за търговия при текущия лимит.'
        : 'Няма достатъчно проверени исторически данни за оценка.'}</p> : (
        <>
          <p>Сценариите са изчислени от исторически резултати след потвърдените брокерски разходи, преди евентуалната бъдеща такса на Shark AI. В края на периода таксата е 10% върху новата уредена нетна печалба над предишния таксуван връх. Възможни са загуби.</p>
          <dl className="module-wallet-metrics">
            <div><dt>Долна оценка (P5)</dt><dd>{displayMinor(forecast.lower_minor, forecast.currency)}</dd></div>
            <div><dt>Медианна оценка (P50)</dt><dd>{displayMinor(forecast.median_minor, forecast.currency)}</dd></div>
            <div><dt>Горна оценка (P95)</dt><dd>{displayMinor(forecast.upper_minor, forecast.currency)}</dd></div>
          </dl>
          <dl className="module-wallet-metrics module-wallet-source">
            <div><dt>Най-нисък наблюдаван резултат</dt><dd>{displayMinor(forecast.worst_observed_minor, forecast.currency)}</dd></div>
            <div><dt>Най-висок наблюдаван резултат</dt><dd>{displayMinor(forecast.best_observed_minor, forecast.currency)}</dd></div>
            <div><dt>Период на данните</dt><dd>{dateLabel(forecast.window_start)} – {dateLabel(forecast.window_end)}</dd></div>
            <div><dt>Неприпокриващи се исторически периоди</dt><dd>{forecast.sample_count}</dd></div>
            <div><dt>Източник</dt><dd>{sourceName(forecast.source)}</dd></div>
            <div><dt>Проверено към</dt><dd>{dateLabel(forecast.as_of, true)}</dd></div>
          </dl>
        </>
      )}
      <dl className="module-wallet-metrics">
        <div><dt>Личен лимит върху отделената печалба</dt><dd>{displayMinor(settings.authorized_amount_minor, settings.currency)}</dd></div>
        <div><dt>Актив</dt><dd>{forecast.instrument_code ?? settings.instrument_code ?? 'Няма потвърден актив'}</dd></div>
        <div><dt>Стратегия</dt><dd>{forecast.strategy_label ?? settings.strategy_label ?? 'Няма потвърдена стратегия'}</dd></div>
        {settings.horizon && <div><dt>Избран период</dt><dd>{settings.horizon.horizon_days} {settings.horizon.horizon_days === 1 ? 'ден' : 'дни'}, до {dateLabel(settings.horizon.target_date)}</dd></div>}
        {settings.target && <div><dt>Зададена цел за печалба</dt><dd>{settings.target.amount_minor!==null
          ?displayMinor(settings.target.amount_minor,settings.currency):minorToInput(settings.target.return_bps?.toString()??null,2)+' %'}</dd></div>}
      </dl>
    </section>
  );
}

function StrategyWorkspace({data}:{data:WalletInvestmentsOwnerDashboard}) {
  const [selected,setSelected]=useState<{id:string;label:string}|null>(null);
  const choose=(id:string,label:string)=>{
    setSelected({id,label});
    requestAnimationFrame(()=>document.getElementById('investment-strategy-conversation')?.focus());
  };
  return <>
    <ResearchPanel domain="investments" currency={data.settings.currency} horizonDays={data.settings.horizon?.horizon_days} onStrategy={choose}/>
    <div id="investment-strategy-conversation" tabIndex={-1}>
      <SharkStrategyChat key={selected?.id??'general'} strategyId={selected?.id??null} strategyLabel={selected?.label??null} currency={data.settings.currency??undefined} horizonDays={data.settings.horizon?.horizon_days}/>
    </div>
  </>;
}

export function WalletInvestments({ signInHref }: { signInHref: string }) {
  const queryAction = useSearchParams().get('action');
  const walletAction = queryAction === 'funding' || queryAction === 'withdrawal' ? queryAction : null;
  const [data, setData] = useState<WalletInvestmentsOwnerDashboard | null>(null);
  const [state, setState] = useState<'loading' | 'signed_out' | 'ready' | 'unavailable'>('loading');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    setState('loading');
    try {
      const { response, body } = await request('', { signal });
      if (signal?.aborted) return;
      if (response.status === 401) {
        setData(null);
        setState('signed_out');
      } else if (response.ok && isWalletOwnerDashboard(body)) {
        setData(body);
        setState('ready');
      } else {
        setData(null);
        setState('unavailable');
      }
    } catch {
      if (!signal?.aborted) {setData(null);setState('unavailable');}
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function change(input?: WalletSettingsInput) {
    if (saving) return;
    setSaving(true);
    setNotice('');
    setError('');
    try {
      const { response, body } = await request(input ? '' : '/revoke', input
        ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }
        : { method: 'POST' });
      if (response.status === 401) {
        setData(null);
        setState('signed_out');
        return;
      }
      if (!response.ok || !isWalletOwnerDashboard(body)) {
        setError(response.status === 400 ? 'Провери въведените стойности.' : 'Промяната временно е недостъпна.');
        return;
      }
      setData(body);
      setNotice(input ? 'Настройките са запазени.' : 'Автоматичният достъп е прекратен.');
    } catch {
      setError('Промяната временно е недостъпна.');
    } finally {
      setSaving(false);
    }
  }

  function renderTab(tab:InvestmentTab) {
    const owner=state==='ready'?data:null;
    const authHref=tab==='overview'?signInHref:'/login?next='+encodeURIComponent('/dashboard?view=investments&tab='+tab);
    if(tab==='crypto')return <CryptoMarketPanel/>;
    if(tab==='calculator')return <>
      <WalletForecast currency={owner?.settings.currency??'EUR'} initialAmountMinor={owner?.wallet.status==='verified'?owner.wallet.balance_minor:null}/>
      {owner&&<Forecast data={owner}/>}
      <InvestmentFeeCalculator data={owner}/>
      {owner&&<FeeReport fee={owner.performance_fee}/>}
    </>;
    if (state === 'loading') return <><Link className="shark-action" href="/wallet">Отвори портфейла</Link>
      <p role="status">Зареждане на портфейла и инвестициите…</p></>;
    if(tab==='opportunities'&&state==='signed_out')return <InvestmentOpportunities publicOnly/>;
    if (state === 'signed_out') return (
      <section className="ice-section module-panel module-wallet-panel" data-ice-art="markets">
        <h2>Достъп до профила</h2>
        <Link className="shark-action" href="/wallet">Създай портфейл</Link>
        <Link className="shark-action" href={authHref}>Вход</Link>
      </section>
    );
    if (state === 'unavailable' || !data) return (
      <section className="ice-section module-panel module-wallet-panel" data-ice-art="markets">
        <p role="alert">Данните временно са недостъпни.</p>
        <Link className="shark-action" href="/wallet">Отвори портфейла</Link>
        <button className="shark-action-secondary" type="button" onClick={() => void load()}>Опитай отново</button>
      </section>
    );

    const { settings, wallet, investments } = data;
    if(tab==='opportunities')return <InvestmentOpportunities currency={settings.currency}/>;
    if(tab==='strategies')return <StrategyWorkspace key={settings.currency??'unknown'} data={data}/>;
    const brokerCashStatus = investments.status === 'provider_unlinked' && (!settings.currency || !settings.instrument_code || !settings.strategy_label)
      ? 'При една свързана стратегия за валутата тя се избира автоматично. При няколко избери актив и стратегия в настройките.'
      : brokerProviderCopy[investments.status];
    const canRevoke = settings.ai_access === 'analysis_only' || data.broker_activity.status === 'unavailable'
      || data.broker_activity.accounts.some((account) => !account.halted_at);
    const target = settings.target;
    const targetAmount = target && (target.amount_minor !== null
      ? displayMinor(target.amount_minor, settings.currency)
      : minorToInput(target.return_bps?.toString() ?? null, 2) + ' %');
    return (
      <>
        <InvestmentProgress/>
        <div className="module-wallet-split">
          <section className="ice-section module-panel module-wallet-panel" data-ice-art="markets" aria-labelledby="wallet-account-title">
            <h2 id="wallet-account-title">Портфейл</h2>
            <Link className="shark-action" href="/wallet">{wallet.status==='verified'?'Отвори портфейла':'Създай портфейл'}</Link>
            <p>{walletProviderCopy[wallet.status]}</p>
            <dl className="module-wallet-metrics">
              <div><dt>Баланс</dt><dd>{displayMinor(wallet.balance_minor, wallet.currency)}</dd></div>
              {wallet.source && <div><dt>Източник</dt><dd>{sourceName(wallet.source)}</dd></div>}
              {wallet.observed_at && <div><dt>Проверено към</dt><dd>{dateLabel(wallet.observed_at, true)}</dd></div>}
            </dl>
            <WalletProviderActions data={data} action={walletAction} key={settings.currency ?? ''} />
          </section>
          <section className="ice-section module-panel module-wallet-panel" data-ice-art="markets" aria-labelledby="broker-account-title">
            <h2 id="broker-account-title">Инвестиции</h2>
            <p>{brokerCashStatus}</p>
            <dl className="module-wallet-metrics">
              <div><dt>Налични средства</dt><dd>{displayMinor(investments.cash_available_minor, investments.currency)}</dd></div>
              <div><dt>Стойност на брокерската сметка</dt><dd>{displayMinor(investments.equity_minor, investments.currency)}</dd></div>
              {investments.source && <div><dt>Източник</dt><dd>{sourceName(investments.source)}</dd></div>}
              {investments.observed_at && <div><dt>Проверено към</dt><dd>{dateLabel(investments.observed_at, true)}</dd></div>}
              {target && <div><dt>Целева печалба</dt><dd>{targetAmount} до {dateLabel(target.target_date)}</dd></div>}
            </dl>
            <BrokerActivityPanel activity={data.broker_activity} />
          </section>
        </div>
        <section className="ice-section module-panel module-wallet-panel" data-ice-art="markets" aria-labelledby="wallet-settings-title">
          <h2 id="wallet-settings-title">Настройки</h2>
          <WalletInvestmentsForm key={JSON.stringify(settings)} settings={settings} busy={saving} onSave={change} />
          {canRevoke && <>
            <p id="wallet-revoke-description">Изключва AI достъпа и спира нови автоматични поръчки.</p>
            <button className="shark-action-secondary" type="button" aria-describedby="wallet-revoke-description" disabled={saving} onClick={() => void change()}>Прекрати автоматичния достъп</button>
          </>}
          {notice && <p role="status">{notice}</p>}
          {error && <p className="module-error" role="alert">{error}</p>}
        </section>
        <TradingConsent key={JSON.stringify(settings)} />
        <section className="ice-section module-panel module-wallet-panel" data-ice-art="markets" aria-labelledby="wallet-weekly-title">
          <h2 id="wallet-weekly-title">Резултат за последната завършена седмица</h2>
          {data.weekly_report.status === 'available' ? <>
            <p>Период от {dateLabel(data.weekly_report.window_start)} до {dateLabel(new Date(Date.parse(data.weekly_report.window_end)-1).toISOString())} (UTC)</p>
            <dl className="module-wallet-metrics">
              <div><dt>Нетен резултат</dt><dd>{displayMinor(data.weekly_report.net_minor,data.weekly_report.currency)}</dd></div>
              <div><dt>Реализиран резултат след такси</dt><dd>{displayMinor(data.weekly_report.realized_after_fees_minor,data.weekly_report.currency)}</dd></div>
              <div><dt>Промяна в нереализирания резултат</dt><dd>{displayMinor(data.weekly_report.unrealized_minor,data.weekly_report.currency)}</dd></div>
              <div><dt>Нереализиран резултат в края на периода</dt><dd>{displayMinor(data.weekly_report.unrealized_closing_minor,data.weekly_report.currency)}</dd></div>
              <div><dt>Такси</dt><dd>{displayMinor(data.weekly_report.fees_minor,data.weekly_report.currency)}</dd></div>
              <div><dt>Постъпления</dt><dd>{displayMinor(data.weekly_report.deposits_minor,data.weekly_report.currency)}</dd></div>
              <div><dt>Тегления</dt><dd>{displayMinor(data.weekly_report.withdrawals_minor,data.weekly_report.currency)}</dd></div>
              <div><dt>Източник</dt><dd>{sourceName(data.weekly_report.source)}</dd></div>
              <div><dt>Проверено към</dt><dd>{dateLabel(data.weekly_report.reported_as_of,true)}</dd></div>
            </dl>
            <p>Нетният резултат е сумата на реализирания резултат и промяната в нереализирания резултат след приспадане на таксите.</p>
          </> : <p>Няма потвърден седмичен отчет от брокера.</p>}
        </section>
      </>
    );
  }
  return <InvestmentNavigation>{renderTab}</InvestmentNavigation>;
}

function FeeReport({fee}:{fee:WalletInvestmentsOwnerDashboard['performance_fee']}) {
  return <section className="ice-section module-panel module-wallet-panel" data-ice-art="markets" aria-labelledby="wallet-fee-title">
    <h2 id="wallet-fee-title">Последна отчетена такса върху печалбата</h2>
    {fee.status==='available' ? <>
      <p>{fee.fee_minor==='0' ? 'Периодът е приключен с нулева такса.'
        : fee.settlement==='reversed' ? 'Брокерът потвърди анулиране на заверката по административната сметка.'
        : fee.settlement==='credited' ? 'Брокерът потвърди заверяването на таксата по административната сметка.'
        : 'Таксата е начислена. Очаква се потвърждение от брокера за заверяване по административната сметка.'}</p>
      <dl className="module-wallet-metrics">
        <div><dt>Край на периода</dt><dd>{dateLabel(fee.period_end)}</dd></div>
        <div><dt>Реализиран резултат за периода</dt><dd>{displayMinor(fee.period_result_minor,fee.currency)}</dd></div>
        <div><dt>Нова допустима нетна печалба</dt><dd>{displayMinor(fee.eligible_profit_minor,fee.currency)}</dd></div>
        <div><dt>Такса 10%</dt><dd>{displayMinor(fee.fee_minor,fee.currency)}</dd></div>
        <div><dt>Печалба за собственика след таксата</dt><dd>{displayMinor(fee.client_net_minor,fee.currency)}</dd></div>
      </dl>
    </> : <p>Няма потвърдено приключване на период с отчет за такса.</p>}
  </section>;
}
