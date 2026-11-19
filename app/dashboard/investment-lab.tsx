'use client';

import Link from 'next/link';
import { ChartCandlestick, WalletCards } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import './investment-lab.css';

const marketHref = '/dashboard?view=investments';
export const investmentAccountHref = `${marketHref}&panel=account`;

/** The market lab is also published as a standalone SharkAI Site. */
function MarketFrame() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(880);

  useEffect(() => {
    function fit(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      const message = event.data;
      if (message?.type === 'sharkai-investments-resize' && Number.isSafeInteger(message.height) && message.height > 0) {
        setHeight(Math.min(message.height, 60_000));
      }
    }
    window.addEventListener('message', fit);
    return () => window.removeEventListener('message', fit);
  }, []);

  return (
    <iframe ref={frame} className="module-investment-frame" title="Инвестиционна лаборатория на SharkAI"
      src="/investment-lab/index.html?embed=1" style={{ height }} />
  );
}

export function InvestmentLab({ account, children }: { account: boolean; children: ReactNode }) {
  return (
    <>
      <nav className="module-investment-switch" aria-label="Инвестиционно пространство">
        <Link href={marketHref} aria-current={account ? undefined : 'page'} scroll={false}>
          <ChartCandlestick size={18} aria-hidden="true" /> Пазари
        </Link>
        <Link href={investmentAccountHref} aria-current={account ? 'page' : undefined} scroll={false}>
          <WalletCards size={18} aria-hidden="true" /> Моят портфейл
        </Link>
      </nav>
      {account ? children : <MarketFrame />}
    </>
  );
}
