'use client';
import {useState} from 'react';
import Link from 'next/link';
import {ArrowRight, ArrowUpRight, ChevronDown, ShieldCheck} from 'lucide-react';
import {type WalletSettingsInput} from '@/lib/wallet-investments-contract';
import {accountLabel, type Account} from './wallet-data';
import {walletLogin} from './wallet-routes';
import {isWalletOwnerDashboard} from '../dashboard/wallet-dashboard-shape';
import {WalletProviderActions} from '../dashboard/wallet-provider-actions';
import {WalletInvestmentsForm} from '../dashboard/wallet-investments-form';
import {TradingConsent} from '../dashboard/trading-consent';

export function WalletSettings({account,update}:{account:Account;update:(next:Account)=>void}){
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  async function save(input?:WalletSettingsInput){
    if(busy)return;setBusy(true);setMessage('');
    try {
      const res=await fetch('/api/wallet-investments'+(input?'':'/revoke'),input?{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}:{method:'POST'});
      if(res.status===401){update({state:'guest',data:null});return;}
      const result=await res.json();if(!res.ok||!isWalletOwnerDashboard(result))throw Error();
      update({state:'ready',data:result});setMessage(input?'Настройките са запазени.':'Автоматичният достъп е прекратен.');
    }catch{setMessage('Промяната не е потвърдена. Провери настройките преди повторен опит.');}
    finally{setBusy(false);}
  }
  if(account.state==='guest')return <section className="panel" data-scene="identity" data-scene-tone="light"><h2>Настройки на профила</h2><p>Влез в Shark AI, за да управляваш сметката и разрешенията си.</p><Link href={walletLogin('settings')} className="button primary">Вход в Shark AI <ArrowRight/></Link></section>;
  if(!account.data)return <section className="panel" data-scene="verification" data-scene-tone="light"><p role="status">{account.state==='loading'?'Зареждане на настройките…':'Настройките са временно недостъпни.'}</p></section>;
  const data=account.data;
  return <div className="stack">
    <section className="panel" data-scene="connections" data-scene-tone="light"><div className="row"><h2>Връзка с доставчика</h2><ShieldCheck/></div>
      <p>{accountLabel(account)}. Откриването и потвърждаването на платежната сметка се извършват в Wise.</p>
      {!data.wallet_capabilities.hosted_kyc&&data.wallet.status!=='verified'&&<a className="button primary" href="https://wise.com/register" target="_blank" rel="noopener noreferrer">Открий сметка в Wise <ArrowUpRight/></a>}
      <div className="sw-provider-actions"><WalletProviderActions data={data} action={null}/></div>
    </section>
    <details className="panel sw-disclosure" data-scene="allocation" data-scene-tone="light"><summary>Инвестиционни настройки и AI достъп <ChevronDown/></summary>
      <WalletInvestmentsForm key={JSON.stringify(data.settings)} settings={data.settings} busy={busy} onSave={save}/>
      {(data.settings.ai_access==='analysis_only'||data.broker_activity.status==='unavailable'||data.broker_activity.accounts.some(a=>!a.halted_at))&&
        <button className="button secondary" disabled={busy} onClick={()=>void save()}>Прекрати автоматичния достъп</button>}
      {message&&<p role="status">{message}</p>}
    </details>
    <TradingConsent readOnly key={JSON.stringify(data.settings)}/>
  </div>;
}
