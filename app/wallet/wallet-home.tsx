'use client';

import Link from 'next/link';
import {useEffect,useState} from 'react';
import {Activity,ArrowDownLeft,ArrowLeft,ArrowRight,ArrowUpRight,ArrowUpFromLine,ChartNoAxesCombined,ChevronRight,ChevronDown,Eye,EyeOff,
  House,List,LockKeyhole,Plus,RefreshCw,Settings2,ShieldCheck,Wallet,Waypoints} from 'lucide-react';
import {Logo} from '@/components/Logo';
import {displayMinor,type WalletSettingsInput} from '@/lib/wallet-investments-contract';
import type {WalletInvestmentsOwnerDashboard} from '@/lib/wallet-investments-server';
import {isWalletOwnerDashboard} from '../dashboard/wallet-dashboard-shape';
import {WalletProviderActions} from '../dashboard/wallet-provider-actions';
import {WalletInvestmentsForm} from '../dashboard/wallet-investments-form';
import {TradingConsent} from '../dashboard/trading-consent';
import WalletForecast from '../dashboard/wallet-forecast';

const tabs={overview:{label:'Начало',icon:House},transactions:{label:'Движения',icon:List},forecast:{label:'Прогноза',icon:ChartNoAxesCombined},settings:{label:'Настройки',icon:Settings2}};
type Section=keyof typeof tabs;
type Account={state:'loading'|'guest'|'unavailable';data:null}|{state:'ready';data:WalletInvestmentsOwnerDashboard};
const tabLink=(section:Section)=>section==='overview'?'/wallet':'/wallet?tab='+section;
const login=(section:Section)=>'/login?next='+encodeURIComponent(tabLink(section));
const wise='https://wise.com/home/';
function dateLabel(value:string|null,withTime=false){
  if(!value||!Number.isFinite(Date.parse(value)))return 'Непотвърдено';
  return new Intl.DateTimeFormat('bg-BG',{dateStyle:'medium',timeZone:'Europe/Sofia',...(withTime&&{timeStyle:'short'})}).format(new Date(value));
}
const providerStatus={
  verified:'Потвърден баланс в Wise',provider_unconfigured:'Предстои настройване на връзката с доставчика',
  provider_unlinked:'Няма потвърдена сметка за избраната валута',stale:'Необходима е нова проверка при доставчика',unavailable:'Данните от доставчика са временно недостъпни',
};
const payments={
  fund:{label:'Захрани',icon:Plus,title:'Добавяне на средства',body:'Избери сметка и начин на захранване в Wise. Доставчикът показва срока и приложимата такса преди потвърждение.'},
  send:{label:'Изпрати',icon:ArrowUpRight,title:'Паричен превод',body:'Въведи получателя и сумата в Wise. Прегледай валутния курс, таксите и крайния размер преди потвърждение.'},
  withdraw:{label:'Изтегли',icon:ArrowUpFromLine,title:'Теглене към банкова сметка',body:'В Wise избери собствената си сметка и сумата за банков превод. Потвърждаването става при доставчика.'},
};
type Payment=keyof typeof payments;
type Movement={direction:'credit'|'debit';amount_minor:string;occurred_at:string;category:string};
type Statement={currency:string;from:string;to:string;as_of:string;has_more:boolean;transactions:Movement[]};

function Transactions({account,compact=false}:{account:Account;compact?:boolean}){
  const [revision,setRevision]=useState(0);
  const [load,setLoad]=useState<{key:string;statement:Statement|null}|null>(null);
  const currency=account.data?.wallet.currency??account.data?.settings.currency;
  const allowed=account.data?.wallet_capabilities.deposit_statements===true;
  const key=currency+'-'+revision;
  useEffect(()=>{
    if(!allowed||!currency)return;
    const controller=new AbortController();
    void fetch('/api/wallet-investments/provider/transactions',{method:'POST',signal:controller.signal,cache:'no-store'}).then(async response=>{
      const data=await response.json();
      if(!response.ok||data.status!=='available'||data.currency!==currency||!Array.isArray(data.transactions))throw Error();
      if(!controller.signal.aborted)setLoad({key,statement:data});
    }).catch(()=>{if(!controller.signal.aborted)setLoad({key,statement:null});});
    return ()=>controller.abort();
  },[allowed,currency,key]);
  const current=load?.key===key?load:null,statement=current?.statement;
  const title=compact?'Последни движения':'Движения по сметката';
  return <section className="sw-panel"><div className="sw-section-head"><h2>{title}</h2>{compact?<Link href={tabLink('transactions')} aria-label="Всички движения"><ArrowRight/></Link>:
    allowed&&<button type="button" onClick={()=>setRevision(n=>n+1)} aria-label="Обнови движенията"><RefreshCw/></button>}</div>
    {account.state==='guest'?<p className="sw-hint"><LockKeyhole/> Влез, за да видиш движенията по своята сметка.</p>:
      account.state==='loading'?<p role="status">Зареждане…</p>:
      !allowed?<p>Извлечението ще се покаже след потвърдена връзка с право за четене на движенията.</p>:
      !current?<p role="status">Зареждане на извлечението…</p>:!statement?<p role="alert">Доставчикът временно не предоставя извлечението.</p>:
      <><p>{dateLabel(statement.from)} – {dateLabel(statement.to)} · Wise</p>{statement.transactions.length===0?
        <p>Няма осчетоводени движения за периода.</p>:<ul className="sw-movements">{statement.transactions.slice(0,compact?3:statement.transactions.length).map((row,i)=>{
          const credit=row.direction==='credit',Icon=credit?ArrowDownLeft:ArrowUpRight;
          const category=row.category||(credit?'Постъпление':'Плащане');
          return <li key={row.occurred_at+'-'+i}><span className={'sw-movement-icon '+(credit?'is-credit':'')}><Icon/></span>
            <div><strong>{category}</strong><small>{dateLabel(row.occurred_at,true)}</small></div><strong>{credit?'+':'−'}{displayMinor(row.amount_minor,statement.currency)}</strong></li>;
        })}</ul>}{!compact && statement.has_more && <p>Показани са последните 100 движения. Цялото извлечение е достъпно в Wise.</p>}
        <small>Потвърдено към {dateLabel(statement.as_of,true)} (София)</small></>}
  </section>;
}

function WalletSettings({account,update}:{account:Account;update:(next:Account)=>void}){
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
  if(account.state==='guest')return <section className="sw-panel"><h2>Настройки на профила</h2><p>Влез в Shark AI, за да управляваш сметката и разрешенията си.</p><Link href={login('settings')} className="sw-btn">Вход в Shark AI <ArrowRight/></Link></section>;
  if(!account.data)return <section className="sw-panel"><p role="status">{account.state==='loading'?'Зареждане на настройките…':'Настройките са временно недостъпни.'}</p></section>;
  const data=account.data;
  return <div className="sw-stack">
    <section className="sw-panel"><div className="sw-section-head"><h2>Връзка с доставчика</h2><ShieldCheck/></div>
      <p>{providerStatus[data.wallet.status]}. Откриването и потвърждаването на платежната сметка се извършват в Wise.</p>
      {!data.wallet_capabilities.hosted_kyc&&data.wallet.status!=='verified'&&<a className="sw-btn" href="https://wise.com/register" target="_blank" rel="noopener noreferrer">Открий сметка в Wise <ArrowUpRight/></a>}
      <div className="sw-provider-actions"><WalletProviderActions data={data}/></div>
    </section>
    <details className="sw-panel sw-disclosure"><summary>Инвестиционни настройки и AI достъп <ChevronDown/></summary>
      <WalletInvestmentsForm key={JSON.stringify(data.settings)} settings={data.settings} busy={busy} onSave={save}/>
      {(data.settings.ai_access==='analysis_only'||data.broker_activity.status==='unavailable'||data.broker_activity.accounts.some(a=>!a.halted_at))&&
        <button className="sw-btn sw-btn-secondary" disabled={busy} onClick={()=>void save()}>Прекрати автоматичния достъп</button>}
      {message&&<p role="status">{message}</p>}
    </details>
    <TradingConsent key={JSON.stringify(data.settings)}/>
  </div>;
}

export function WalletHome({section}:{section:Section}){
  const [account,setAccount]=useState<Account>({state:'loading',data:null}),[refresh,setRefresh]=useState(0);
  const [hideBalance,setHideBalance]=useState(false),[payment,setPayment]=useState<Payment|null>(null);
  useEffect(()=>{
    const controller=new AbortController();
    setAccount({state:'loading',data:null});
    void fetch('/api/wallet-investments',{cache:'no-store',signal:controller.signal}).then(async res=>{
      if(res.status===401){if(!controller.signal.aborted)setAccount({state:'guest',data:null});return;}
      const body=await res.json();if(!res.ok||!isWalletOwnerDashboard(body))throw Error();
      if(!controller.signal.aborted)setAccount({state:'ready',data:body});
    }).catch(()=>{if(!controller.signal.aborted)setAccount({state:'unavailable',data:null});});
    return ()=>controller.abort();
  },[refresh]);
  const data=account.data,wallet=data?.wallet,verified=wallet?.status==='verified';
  const currency=wallet?.currency??data?.settings.currency??'EUR';
  const source=wallet?providerStatus[wallet.status]:account.state==='loading'?'Зареждане на сметката…':account.state==='guest'?'Влез, за да видиш наличността си.':'Връзката със сметката е временно недостъпна.';
  const visible=verified?displayMinor(wallet.balance_minor,wallet.currency):'—';
  const paymentState=payment?payments[payment]:null;
  return <div className="sw-root"><div className="sw-shell">
    <header className="sw-header"><Link href="/wallet" className="sw-wordmark" aria-label="Shark AI Портфейл"><Logo size="sm"/><span>Shark<strong>AI</strong></span><i/>Портфейл</Link>
      <Link href="/dashboard?view=investments" className="sw-return"><ArrowLeft/>Към Shark AI</Link></header>
    <nav className="sw-navigation" aria-label="Навигация в портфейла">{(Object.keys(tabs) as Section[]).map(id=>{
      const {label,icon:Icon}=tabs[id];return <Link key={id} className="sw-nav-item" href={tabLink(id)} aria-current={section===id?'page':undefined}><Icon/>{label}</Link>;
    })}</nav>
    <main className="sw-main">
      {section==='overview'?<>
        <section className="sw-hero"><div className="sw-hero-copy"><div className="sw-account-label"><Wallet/> Личен портфейл</div>
          <h1>Моята наличност</h1>
          <div className="sw-balance"><strong>{hideBalance?'••••':visible}</strong>{verified&&<button type="button"
            onClick={()=>setHideBalance(v=>!v)} aria-label={hideBalance?'Покажи баланса':'Скрий баланса'}>{hideBalance?<EyeOff/>:<Eye/>}</button>}</div>
          <p aria-live="polite">{source}{verified&&' · '+dateLabel(wallet.observed_at,true)+' (София)'}</p>
          {account.state==='guest'?<Link className="sw-btn" href={login('overview')}>Вход в портфейла <ArrowRight/></Link>:
            account.state==='ready'&&!verified?<Link className="sw-btn" href={tabLink('settings')}>Свържи сметка <ArrowRight/></Link>:
            account.state==='unavailable'?<button className="sw-btn" onClick={()=>setRefresh(n=>n+1)}>Провери отново <RefreshCw/></button>:null}
        </div></section>
        <div className="sw-grid"><div className="sw-stack">
          <div className="sw-actions" aria-label="Операции с пари">{(Object.keys(payments) as Payment[]).map(id=>{
            const {icon:Icon,label}=payments[id];return <button key={id} type="button" aria-pressed={payment===id}
              onClick={()=>setPayment(current=>current===id?null:id)}><span><Icon/></span>{label}</button>;
          })}</div>
          {paymentState&&<section className="sw-panel sw-pay-state" aria-live="polite"><h2>{paymentState.title}</h2>
            {verified?<><p>{paymentState.body}</p><a href={wise} target="_blank" rel="noopener noreferrer" className="sw-btn">Продължи в Wise <ArrowUpRight/></a></>:
              <><p>{account.state==='guest'?'Влез и свържи платежна сметка, за да използваш тази операция.':'Тази операция изисква потвърдена сметка при доставчика.'}</p>
                <Link href={account.state==='guest'?login('settings'):tabLink('settings')} className="sw-btn sw-btn-secondary">{account.state==='guest'?'Вход в Shark AI':'Към настройките'} <ChevronRight/></Link></>}
          </section>}
          <Transactions account={account} compact/>
        </div>
        <Link href={tabLink('forecast')} className="sw-forecast-card"><span className="sw-tile-icon"><ChartNoAxesCombined/></span>
          <h2>Прогноза</h2><p>Въведи сума и сравни възможните резултати за избран период.</p><span className="sw-tile-link">Изчисли диапазон <ArrowRight/></span></Link></div>
      </>:<>
        <div className="sw-page-heading"><span>{section==='transactions'?<Activity/>:section==='settings'?<Settings2/>:<Waypoints/>} Личен портфейл</span>
          <h1>{tabs[section].label}</h1></div>
        {section==='transactions'?<Transactions account={account}/>:section==='forecast'?<WalletForecast currency={currency} initialAmountMinor={verified?wallet.balance_minor:null}/>:
          <WalletSettings account={account} update={setAccount}/>}
      </>}
    </main>
  </div></div>;
}
