'use client';
import {useState} from 'react';
import Link from 'next/link';
import {ArrowRight, ArrowUpRight, ChevronDown, ShieldCheck} from 'lucide-react';
import {type WalletSettingsInput} from '@/lib/wallet-investments-contract';
import {accountLabel, type Account} from './wallet-data';
import {walletLogin, type WalletRoute} from './wallet-routes';
import {WiseWindowLink} from './wise-window';
import {isWalletOwnerDashboard} from '../dashboard/wallet-dashboard-shape';
import {WalletProviderActions} from '../dashboard/wallet-provider-actions';
import {WalletInvestmentsForm} from '../dashboard/wallet-investments-form';
import {TradingConsent} from '../dashboard/trading-consent';

export function WalletSettings({account,update,refresh,route}:{account:Account;update:(next:Account)=>void;refresh:()=>void;route:WalletRoute}){
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [currencyError,setCurrencyError]=useState('');
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
  async function selectCurrency(currency:string) {
    if(busy || !currency)return;
    setBusy(true); setCurrencyError('');
    try {
      const response=await fetch('/api/wallet-investments/provider/currency',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currency}),
      });
      if(response.status===401){update({state:'guest',data:null});return;}
      if(!response.ok)throw Error();
      refresh();
    }catch{setCurrencyError('Валутата не беше сменена. Опитай отново.');}
    finally{setBusy(false);}
  }
  if(account.state==='guest')return <section className="panel" data-scene="identity" data-scene-tone="light"><h2>Връзка с Wise</h2>
    <p>Влез в SharkAI, за да провериш връзката със своята сметка. Можеш също да отвориш личния си профил направо в Wise.</p>
    <Link href={walletLogin(route)} className="button primary">Вход в Shark AI <ArrowRight/></Link>
    <WiseWindowLink className="button secondary">Отвори моя Wise <ArrowUpRight/></WiseWindowLink></section>;
  if(!account.data)return <section className="panel" data-scene="verification" data-scene-tone="light"><p role="status">{account.state==='loading'?'Зареждане на настройките…':'Настройките са временно недостъпни.'}</p></section>;
  const data=account.data;
  const currencies=data.wallet_capabilities.currencies??[];
  return <div className="stack">
    <section className="panel" data-scene="connections" data-scene-tone="light"><div className="row"><h2>Връзка с доставчика</h2><ShieldCheck/></div>
      <p>{accountLabel(account)}.</p>
      {currencies.length>0 && (currencies.length>1 || !data.wallet_capabilities.selected_currency) &&
        <label className="field"><span>Валута на Wise сметката</span>
          <select value={data.wallet_capabilities.selected_currency??''} disabled={busy} onChange={event=>void selectCurrency(event.target.value)}>
            <option value="" disabled>Избери валута</option>
            {currencies.map(code=><option key={code} value={code}>{code}</option>)}
          </select></label>}
      {!data.wallet_capabilities.hosted_kyc&&data.wallet.status!=='verified'&&<>
        <p>Можеш да влезеш в своя Wise профил. За показване на данни тук е нужна одобрена връзка между Wise и профила ти в SharkAI.</p>
        <WiseWindowLink className="button primary">Отвори моя Wise <ArrowUpRight/></WiseWindowLink></>}
      <div className="sw-provider-actions"><WalletProviderActions key={data.wallet_capabilities.selected_currency} data={data} action={null} inWallet/></div>
      {currencyError && <p role="alert">{currencyError}</p>}
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
