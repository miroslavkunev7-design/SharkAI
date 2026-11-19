import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChevronLeft } from 'lucide-react';
import { GUEST_PORTFOLIO } from '../app/dashboard/portfolio-account';
import { PortfolioHome, type PortfolioAction } from '../app/dashboard/portfolio-home';
import { PortfolioMarkets } from '../app/dashboard/portfolio-markets';
import './investments-site.css';

type SiteHost = 'workspace' | 'standalone';
type SiteOptions = { host: SiteHost; moduleBase: string };
const productOrigin = 'https://mm-auto-green.vercel.app';
const portfolioRoute = '/dashboard?view=investments';
const loginFor = (route: string) => productOrigin + '/login?next=' + encodeURIComponent(route);

function SitePortfolio({ host, moduleBase }: SiteOptions) {
  const [hash, setHash] = useState(() => location.hash);
  const marketHash = host === 'workspace' ? '#investments/markets' : '#markets';
  const portfolioHash = host === 'workspace' ? '#investments' : '#portfolio';
  const marketView = hash === marketHash || hash === '#chart-panel';
  const base = new URL(moduleBase, document.baseURI);
  const feedUrl = new URL('market-feed.mjs', base).href;

  useEffect(() => {
    function changed() {
      setHash(location.hash);
      window.scrollTo(0, 0);
    }
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);

  function startAction(action: PortfolioAction) {
    location.assign(loginFor(portfolioRoute + '&panel=account&action=' + action));
  }

  if (marketView) return <div className="shark-site-markets">
    <a className="shark-site-return" href={portfolioHash}><ChevronLeft size={17} aria-hidden="true"/> Моят портфейл</a>
    <PortfolioMarkets initialView="markets" feedUrl={feedUrl}/>
  </div>;

  return <PortfolioHome account={GUEST_PORTFOLIO}
    market={<PortfolioMarkets feedUrl={feedUrl}/>}
    onOpenMarkets={() => { location.hash = marketHash; }}
    onOpenAccount={() => location.assign(loginFor(portfolioRoute + '&panel=account&section=manage'))}
    onOpenSimulator={() => location.assign(new URL('simulator.html', base).href)}
    onAction={startAction} signInHref={loginFor(portfolioRoute)}/>;
}

export function mountPortfolio(element: HTMLElement, options: SiteOptions) {
  const root = createRoot(element);
  const base = new URL(options.moduleBase, document.baseURI);
  const image = new URL('assets/investments.webp', base);
  element.style.setProperty('--portfolio-hero-image', 'url("' + image.href + '")');
  root.render(<SitePortfolio {...options}/>);
  return () => root.unmount();
}
