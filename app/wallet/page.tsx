import type {Metadata} from 'next';
import {WalletHome} from './wallet-home';
import {readWalletRoute} from './wallet-routes';
import './wallet.css';

export const metadata: Metadata = {
  title: 'Портфейл | SharkAI',
  description: 'Личен портфейл, движения по сметката и пазарни справки.',
};

export default async function WalletPage({searchParams}: {searchParams: Promise<Record<string, string | string[] | undefined>>}) {
  const {tab, wallet_review, wallet_transfer, pair, kind} = await searchParams;
  return <WalletHome section={readWalletRoute(wallet_review === 'unavailable' ? 'settings' : tab)}
    pair={typeof pair==='string'&&/^[a-z0-9_.-]{2,40}$/i.test(pair)?pair:null} equities={kind==='invest'}
    transferUnavailable={wallet_transfer === 'unavailable'}/>;
}
