'use client';

import Link from 'next/link';
import {useEffect,useState} from 'react';
import {Activity,ArrowDownLeft,ArrowLeft,ArrowRight,ArrowUpRight,ArrowUpFromLine,ChartNoAxesCombined,ChevronRight,ChevronDown,Eye,EyeOff,
  House,List,LockKeyhole,Plus,RefreshCw,Settings2,ShieldCheck,Wallet,Waypoints,Search,CreditCard,ArrowLeftRight,MoreHorizontal} from 'lucide-react';
import {Logo} from '@/components/Logo';
import {displayMinor,type WalletSettingsInput} from '@/lib/wallet-investments-contract';
import type {WalletInvestmentsOwnerDashboard} from '@/lib/wallet-investments-server';
import {isWalletOwnerDashboard} from '../dashboard/wallet-dashboard-shape';
import {WalletProviderActions} from '../dashboard/wallet-provider-actions';
import {WalletInvestmentsForm} from '../dashboard/wallet-investments-form';
import {TradingConsent} from '../dashboard/trading-consent';
import WalletForecast from '../dashboard/wallet-forecast';
import {WalletReferenceConverter,WalletCardsReadOnly} from './wallet-premium-extras';

const tabs={
 overview:{label:'Начало',icon:House},
 transactions:{label:'Движения',icon:List},
 currencies:{label:'Валути',icon:ArrowLeftRight},
 cards:{label:'Карти',icon:CreditCard},
 details:{label:'Детайли',icon:Wallet},
 forecast:{label:'Прогноза',icon:ChartNoAxesCombined},
 settings:{label:'Настройки',icon:Settings2}
} as const;
const desktopTabs=['overview','transactions','currencies','cards','settings'] as const;
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
      <div className="sw-provider-actions"><WalletProviderActions data={data} action={null}/></div>
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
 const [showAccounts,setShowAccounts]=useState(false);
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
 const visible=verified?displayMinor(wallet.balance_minor,wallet.currency).replace(/ EUR$/,' €'):'—';
 const paymentState=payment?payments[payment]:null;
 return <div className="sw-root"><div className="sw-shell">
   <header className="sw-header">
     <img className="sw-header-muscular-shark" src="/sharkai/chat/header-shark-muscular.webp" alt="" aria-hidden="true"/>
     <Link href="/wallet" className="sw-wordmark" aria-label="SharkAI Портфейл">
       <img className="sw-header-avatar" src="/sharkai/chat/shark-avatar.webp" alt="Акула SharkAI"/>
       <Logo size="sm"/><span>Shark<strong>AI</strong></span><i/>Портфейл
     </Link>
     <div className="sw-mobile-tools">
       <Link className="sw-mobile-search" href={tabLink('transactions')} aria-label="Търси в движенията"><Search/><span>Търси</span></Link>
       <Link href="/dashboard?view=investments" aria-label="Инвестиции"><ChartNoAxesCombined/></Link>
       <Link href={tabLink('cards')} aria-label="Карти"><CreditCard/></Link>
     </div>
     <div className="sw-desktop-tools">
       <Link href="/dashboard?view=investments"><ChartNoAxesCombined/> Инвестиции</Link>
       <Link href="/dashboard?view=settings"><Settings2/> Профил</Link>
       <Link href="/dashboard?view=investments" className="sw-return"><ArrowLeft/>Към Shark AI</Link>
     </div>
   </header>
   <nav className="sw-navigation" aria-label="Десктоп навигация в портфейла">{desktopTabs.map(id=>{
     const {label,icon:Icon}=tabs[id];return <Link key={id} className="sw-nav-item" href={tabLink(id)}
     aria-current={section===id?'page':undefined}><Icon/>{label}</Link>;
   })}</nav>
   <main className="sw-main">
     {section==='overview'?<>
       <section className="sw-hero"><div className="sw-hero-copy">
         <h1>Достъпни средства</h1>
         <div className="sw-account-label"><Wallet/> Основна · {currency}</div>
         <div className={'sw-provider-chip '+(verified?'is-connected':'')} aria-live="polite">
           <ShieldCheck/>{verified?'Wise · Свързан':account.state==='loading'?'Проверка на Wise…':'Wise · Непотвърден'}
         </div>
         <div className="sw-balance"><strong>{hideBalance?'••••':visible}</strong>
           {verified&&<button type="button" onClick={()=>setHideBalance(v=>!v)}
             aria-label={hideBalance?'Покажи баланса':'Скрий баланса'}>{hideBalance?<EyeOff/>:<Eye/>}</button>}
         </div>
         <button type="button" className="sw-btn sw-account-toggle" aria-expanded={showAccounts}
           aria-controls="sw-account-options" onClick={()=>setShowAccounts(v=>!v)}>Сметки <ChevronDown/></button>
         {showAccounts&&<div className="sw-account-options" id="sw-account-options">
           <div className="sw-account-option"><Wallet/> Основна · {currency}<span>{verified?'✓':'—'}</span></div>
           <button type="button" className="sw-account-option" onClick={()=>setHideBalance(v=>!v)}>
             {hideBalance?<Eye/>:<EyeOff/>}{hideBalance?'Покажи наличността':'Скрий наличността'}<small>Локално</small>
           </button>
           <div className="sw-account-option is-unavailable"><LockKeyhole/> Джобове / касички <small>Няма потвърдени данни</small></div>
           <Link className="sw-account-option" href={tabLink('settings')}><Settings2/> Управление на Wise <ArrowRight/></Link>
         </div>}
         <p className="sw-balance-status" aria-live="polite">{source}{verified&&' · '+dateLabel(wallet.observed_at,true)+' (София)'}</p>
         {account.state==='guest'?<Link className="sw-btn sw-auth-link" href={login('overview')}>Вход в портфейла <ArrowRight/></Link>:
           account.state==='ready'&&!verified?<Link className="sw-btn sw-auth-link" href={tabLink('settings')}>Свържи сметка <ArrowRight/></Link>:
           account.state==='unavailable'?<button type="button" className="sw-btn sw-auth-link" onClick={()=>setRefresh(n=>n+1)}>Провери отново <RefreshCw/></button>:null}
       </div></section>
       <div className="sw-grid">
         <div className="sw-stack">
           <div className="sw-actions" aria-label="Операции с пари">
             <button type="button" aria-pressed={payment==='fund'} onClick={()=>setPayment(p=>p==='fund'?null:'fund')}><span><Plus/></span>Захрани</button>
             <button type="button" aria-pressed={payment==='send'} onClick={()=>setPayment(p=>p==='send'?null:'send')}><span><ArrowLeftRight/></span>Прехвърли</button>
             <button type="button" className="sw-desktop-action" aria-pressed={payment==='withdraw'} onClick={()=>setPayment(p=>p==='withdraw'?null:'withdraw')}><span><ArrowUpFromLine/></span>Изтегли</button>
             <Link className="sw-mobile-action" href={tabLink('details')}><span><Wallet/></span>Детайли</Link>
             <Link className="sw-mobile-action" href={tabLink('settings')}><span><MoreHorizontal/></span>Още</Link>
           </div>
           {paymentState&&<section className="sw-panel sw-pay-state" aria-live="polite"><h2>{paymentState.title}</h2>
             {verified?<><p>{paymentState.body}</p><a href={wise} target="_blank" rel="noopener noreferrer" className="sw-btn">Продължи в Wise <ArrowUpRight/></a></>:
               <><p>{account.state==='guest'?'Влез и свържи платежна сметка, за да използваш тази операция.':'Тази операция изисква потвърдена сметка при доставчика.'}</p>
                 <Link href={account.state==='guest'?login('settings'):tabLink('settings')} className="sw-btn sw-btn-secondary">{account.state==='guest'?'Вход в SharkAI':'Към настройките'} <ChevronRight/></Link></>}
           </section>}
           <Transactions account={account} compact/>
         </div>
         <WalletReferenceConverter compact/>
       </div>
     </>:section==='transactions'?<>
       <div className="sw-page-heading"><span><Activity/> Личен портфейл</span><h1>Движения</h1></div>
       <Transactions account={account}/>
     </>:section==='currencies'?<>
       <div className="sw-page-heading"><span><ArrowLeftRight/> Личен портфейл</span><h1>Валути</h1></div>
       <WalletReferenceConverter/>
     </>:section==='cards'?<>
       <div className="sw-page-heading"><span><CreditCard/> Личен портфейл</span><h1>Карти</h1></div>
       <WalletCardsReadOnly/>
     </>:section==='details'?<>
       <div className="sw-page-heading"><span><Wallet/> Личен портфейл</span><h1>Детайли</h1></div>
       <section className="sw-panel sw-account-details"><h2>Основна сметка · {currency}</h2>
         <p>{source}</p><strong>{hideBalance?'••••':visible}</strong>
         <p>{verified?'Данните са потвърдени към '+dateLabel(wallet.observed_at,true):'Няма потвърдена наличност.'}</p>
         <Link className="sw-btn" href={tabLink('settings')}>Управление на Wise <ArrowRight/></Link>
       </section>
     </>:section==='forecast'?<>
       <div className="sw-page-heading"><span><Waypoints/> Личен портфейл</span><h1>Прогноза</h1></div>
       <WalletForecast currency={currency} initialAmountMinor={verified?wallet.balance_minor:null}/>
     </>:<>
       <div className="sw-page-heading"><span><Settings2/> Личен портфейл</span><h1>Настройки</h1></div>
       <WalletSettings account={account} update={setAccount}/>
     </>}
   </main>
   <nav className="sw-mobile-navigation" aria-label="Главна мобилна навигация">
     <Link className={section==='overview'?'is-active':''} aria-current={section==='overview'?'page':undefined} href="/wallet"><House/>Начало</Link>
     <Link href="/dashboard?view=investments"><ChartNoAxesCombined/>Инвестиции</Link>
     <Link className={section==='transactions'?'is-active':''} href={tabLink('transactions')}><ArrowLeftRight/>Плащания</Link>
     <Link className={section==='currencies'?'is-active':''} href={tabLink('currencies')}><span className="sw-crypto-symbol">₿</span>Крипто</Link>
     <Link className={section==='settings'?'is-active':''} href={tabLink('settings')}><MoreHorizontal/>Още</Link>
   </nav>
 </div></div>;
}
