'use client';

import { useEffect, useState } from 'react';
import { currencyMinorDigits, displayMinor } from '../../lib/wallet-investments-contract';
import type { WalletInvestmentsOwnerDashboard } from '../../lib/wallet-investments-server';

export type PortfolioAccount = {
  status: 'guest' | 'loading' | 'ready' | 'unavailable';
  currency: string | null;
  value: string | null;
  brokerCash: string | null;
  walletCash: string | null;
  provider: string | null;
  asOf: string | null;
  weeklyResult: string | null;
  history: { time: number; value: number }[];
  holdings: { id: string; symbol: string; provider: string; units: string; asOf: string | null }[];
  activity: { id: string; title: string; detail: string; status: string; time: string }[];
  holdingsStatus: 'verified' | 'partial' | 'unlinked' | 'unavailable';
  activityStatus: 'available' | 'unlinked' | 'unavailable';
  canFund: boolean;
  canWithdraw: boolean;
};

export const GUEST_PORTFOLIO: PortfolioAccount = {
  status: 'guest', currency: null, value: null, brokerCash: null, walletCash: null, provider: null, asOf: null,
  weeklyResult: null, history: [], holdings: [], activity: [], holdingsStatus: 'unlinked', activityStatus: 'unlinked',
  canFund: false, canWithdraw: false,
};

const providerLabels = { ibkr: 'Interactive Brokers', saxo: 'Saxo' };
type Order = WalletInvestmentsOwnerDashboard['broker_activity']['accounts'][number]['recent_orders'][number];
export const portfolioOrderLabels: Record<Order['status'], string> = {
  RESERVED: 'Резервирана', SUBMITTING: 'Очаква потвърждение за изпращане', ACKNOWLEDGED: 'Приета от брокера',
  PENDING: 'Изчакваща', WORKING: 'Активна', PARTIALLY_FILLED: 'Частично изпълнена',
  CANCEL_PENDING: 'Изчаква отмяна', REVIEW_REQUIRED: 'Изисква преглед', FILLED: 'Изпълнена',
  CANCELED: 'Отменена', REJECTED: 'Отхвърлена', UNKNOWN: 'Неустановена', VOIDED: 'Прекратена преди изпращане',
};

export function portfolioFromDashboard(data: WalletInvestmentsOwnerDashboard): PortfolioAccount {
  const { investments, wallet, weekly_report: report, broker_activity: ledger } = data;
  const verified = investments.status === 'verified';
  const currency = investments.currency ?? data.settings.currency;
  const accounts = ledger.accounts.filter(account =>
    (!investments.provider || account.provider === investments.provider) && (!currency || account.currency === currency));
  const reconciled = accounts.filter(account => account.reconciliation === 'verified' && account.positions !== null);
  const activityStatus = ledger.status === 'unavailable' ? 'unavailable' : accounts.length ? 'available' : 'unlinked';
  const holdingsStatus = activityStatus !== 'available' ? activityStatus
    : reconciled.length === accounts.length ? 'verified' : reconciled.length ? 'partial' : 'unavailable';
  const units = new Intl.NumberFormat('bg-BG');
  const holdings = reconciled.flatMap((account, accountIndex) => (account.positions ?? []).map((p, row) => ({
    id: accountIndex + '/' + row, symbol: p.instrument, provider: providerLabels[account.provider] + ' · ' + account.currency,
    units: units.format(BigInt(p.units)), asOf: account.snapshot_at,
  })));
  const activity = accounts.flatMap((account, accountIndex) => account.recent_orders.map((order, index) => {
    const hasFill = order.provider_observed_at && ['PARTIALLY_FILLED', 'FILLED', 'CANCELED'].includes(order.status);
    const fill = hasFill ? ' · изпълнени ' + units.format(BigInt(order.filled_units)) : '';
    return {
      id: accountIndex + '/' + index, title: (order.side === 'BUY' ? 'Покупка · ' : 'Продажба · ') + order.instrument,
      detail: providerLabels[account.provider] + ' · ' + units.format(BigInt(order.units)) + ' бр.' + fill,
      time: order.provider_observed_at ?? order.recorded_at,
      status: portfolioOrderLabels[order.status] + (order.reconciliation_required ? ' · изисква сверяване' : ''),
    };
  })).sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  const digits = currency ? currencyMinorDigits(currency) : null;
  const history = digits === null ? [] : (data.portfolio_valuations ?? []).flatMap(row => {
    const time = Date.parse(row.observed_at);
    const minor = Number(row.equity_minor);
    return Number.isFinite(time) && Number.isSafeInteger(minor) ? [{ time, value: minor / 10 ** digits }] : [];
  });
  const canUseWise = wallet.status === 'verified';
  return {
    status: 'ready', currency, provider: investments.provider ? providerLabels[investments.provider] : null,
    value: verified && investments.equity_minor !== null ? displayMinor(investments.equity_minor, currency) : null,
    brokerCash: verified && investments.cash_available_minor !== null ? displayMinor(investments.cash_available_minor, currency) : null,
    walletCash: canUseWise ? displayMinor(wallet.balance_minor, wallet.currency) : null,
    asOf: verified ? investments.observed_at : null,
    weeklyResult: report.status === 'available' && report.net_minor !== null ? displayMinor(report.net_minor, report.currency) : null,
    history, holdings, activity, holdingsStatus, activityStatus, canFund: canUseWise, canWithdraw: canUseWise,
  };
}

export function usePortfolioAccount(enabled: boolean, ownerKey = ''): PortfolioAccount {
  const [state, setState] = useState<{ owner: string; account: PortfolioAccount } | null>(null);
  useEffect(() => {
    if (!enabled) {
      setState(null);
      return;
    }
    const controller = new AbortController();
    let pending = false;
    async function load() {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const response = await fetch('/api/wallet-investments', {
          cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
        });
        if (!response.ok && response.status !== 401) throw new Error('Account unavailable');
        const account = response.status === 401 ? GUEST_PORTFOLIO : portfolioFromDashboard(await response.json());
        if (!controller.signal.aborted) setState({ owner: ownerKey, account });
      } catch {
        if (!controller.signal.aborted) setState({ owner: ownerKey, account: { ...GUEST_PORTFOLIO, status: 'unavailable' } });
      } finally {
        pending = false;
      }
    }
    void load();
    const timer = window.setInterval(load, 60_000);
    document.addEventListener('visibilitychange', load);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [enabled, ownerKey]);
  if (!enabled) return GUEST_PORTFOLIO;
  return state?.owner === ownerKey ? state.account : { ...GUEST_PORTFOLIO, status: 'loading' };
}
