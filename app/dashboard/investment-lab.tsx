'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { PortfolioHome } from './portfolio-home';
import { PortfolioMarkets } from './portfolio-markets';
import { usePortfolioAccount } from './portfolio-account';
import { WalletInvestments } from './wallet-investments';
import './investment-lab.css';

const portfolioHref = '/dashboard?view=investments';
const positionsHref = portfolioHref + '&panel=portfolio';
const marketsHref = portfolioHref + '&panel=markets';
const accountHref = portfolioHref + '&panel=account';
const managementHref = accountHref + '&section=manage';
const signIn = (destination: string) => '/login?next=' + encodeURIComponent(destination);

function ReturnToPortfolio() {
  return <Link className="portfolio-return" href={portfolioHref}>
    <ChevronLeft size={17} aria-hidden="true" /> Инвестиции
  </Link>;
}

function AccountOverview({ ownerKey }: { ownerKey?: string }) {
  const router = useRouter();
  const account = usePortfolioAccount(true, ownerKey);
  return <PortfolioHome
    account={account}
    market={<PortfolioMarkets initialView="watchlist" syncPreferences />}
    signInHref={signIn(positionsHref)}
    onOpenMarkets={() => router.push(marketsHref)}
    onOpenAccount={() => router.push(managementHref)}
    onOpenCalculator={() => router.push(portfolioHref + '&tab=calculator')}
    onAction={(action) => {
      const destination = accountHref + '&action=' + action;
      router.push(account.status === 'guest' ? signIn(destination) : destination);
    }}
  />;
}

export function InvestmentLab({ ownerKey }: { ownerKey?: string }) {
  const params = useSearchParams();
  const panel = params.get('panel');
  const tab = params.get('tab');
  if (panel === 'portfolio') return <div className="portfolio-subpage">
    <ReturnToPortfolio />
    <AccountOverview ownerKey={ownerKey} />
  </div>;
  if (panel === 'markets') {
    return <div className="portfolio-subpage">
      <ReturnToPortfolio />
      <h1 className="portfolio-section-heading">Пазари</h1>
      <PortfolioMarkets initialView="markets" syncPreferences />
    </div>;
  }
  const action = params.get('action');
  if (panel === 'account' && (params.get('section') === 'manage' || action === 'funding' || action === 'withdrawal')) {
    const destination = action === 'funding' || action === 'withdrawal' ? accountHref + '&action=' + action : managementHref;
    return <div className="portfolio-subpage">
      <ReturnToPortfolio />
      <h1 className="portfolio-section-heading">Управление на сметката</h1>
      <WalletInvestments signInHref={signIn(destination)} />
    </div>;
  }
  return <div className="portfolio-subpage">
    <nav className="investment-account-links" aria-label="Портфейл и пазари">
      <Link className="shark-action" href="/wallet">Отвори портфейла</Link>
      <Link className="shark-action-secondary" href={positionsHref}>Позиции и следени активи</Link>
      <Link className="shark-action-secondary" href={marketsHref}>Пазари</Link>
    </nav>
    <WalletInvestments signInHref={signIn(portfolioHref + (tab ? '&tab=' + encodeURIComponent(tab) : ''))} />
  </div>;
}
