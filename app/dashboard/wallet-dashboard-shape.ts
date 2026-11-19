import type {WalletInvestmentsOwnerDashboard} from '@/lib/wallet-investments-server';

export function isWalletOwnerDashboard(value:unknown):value is WalletInvestmentsOwnerDashboard {
  return typeof value==='object' && value!==null && 'settings' in value && 'wallet' in value && 'wallet_capabilities' in value
    && 'investments' in value && typeof value.investments==='object' && value.investments!==null && 'profit_budget' in value.investments
    && 'forecast' in value && 'broker_activity' in value && 'weekly_report' in value && 'performance_fee' in value;
}
