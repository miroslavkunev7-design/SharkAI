import type {Metadata} from 'next';
import {WalletHome} from './wallet-home';
import './wallet.css';

export const metadata:Metadata={title:'Портфейл | Shark AI',description:'Портфейл, движения и инвестиционни прогнози в Shark AI.'};

export default async function WalletPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const {tab}=await searchParams;
  const section=tab==='transactions'||tab==='forecast'||tab==='settings'?tab:'overview';
  return <WalletHome section={section}/>;
}
