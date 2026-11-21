'use client';

import {useEffect, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {ArrowLeft, ArrowRightLeft, ChartNoAxesColumn, ChartNoAxesCombined, ChevronDown, ChevronRight,
  Ellipsis, Eye, EyeOff, House, MessageCircle, Plus, ReceiptText, Search, Shuffle, UserRound, Wallet, X} from 'lucide-react';
import {accountBalance, accountLabel, useWalletData, type WalletData} from './wallet-data';
import {WalletView, RecentRows} from './wallet-views';
import {walletLogin, walletTitles, walletUrl, type WalletRoute} from './wallet-routes';
import {WalletReferenceConverter} from './wallet-premium-extras';
import { requestQuickChat } from '../quick-chat-launch';
import {WiseReviewForm,WiseWindowLink} from './wise-window';

type Go = (route: WalletRoute) => void;
const isDesktop = () => window.matchMedia('(min-width: 1024px)').matches;
function subscribeViewport(listener: () => void) {
  const media = window.matchMedia('(min-width: 1024px)');
  media.addEventListener('change',listener);
  return () => media.removeEventListener('change',listener);
}
export const openSharkAssistant = requestQuickChat;

// The ZIP uses these filled glyphs alongside Lucide line icons.
function CardIcon({size=24}) {
  return <svg aria-hidden="true" className="reference-icon reference-card" width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path fillRule="evenodd" d="M4 3.8A2.8 2.8 0 0 0 1.2 6.6v1.8h21.6V6.6A2.8 2.8 0 0 0 20 3.8ZM1.2 11v6.4A2.8 2.8 0 0 0 4 20.2h16a2.8 2.8 0 0 0 2.8-2.8V11Zm3.4 4.5a1 1 0 0 1 1-1h5a1 1 0 1 1 0 2h-5a1 1 0 0 1-1-1Z"/></svg>;
}
function BankIcon({size=24}) {
  return <svg aria-hidden="true" className="reference-icon reference-bank" width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2 2 7v2h20V7Z"/><rect x="3" y="19" width="18" height="3" rx="1"/>
    {[4,10.3,16.6].map(x=><rect key={x} x={x} y="8" width="3.4" height="12" rx=".7"/>)}</svg>;
}
function MoreIcon({size=24}) {
  return <svg aria-hidden="true" className="reference-icon reference-more" width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="m12 1 9.4 5.5v11L12 23l-9.4-5.5v-11Z"/><path d="M8 12h8m-4-4v8" stroke="#5f259b" strokeWidth="2.5" strokeLinecap="round"/></svg>;
}
function BitcoinIcon({size=24}) {
  return <svg aria-hidden="true" className="reference-icon reference-bitcoin" width={size} height={size} viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 13v1.25c0 .138.112.25.25.25h1a.25.25 0 0 0 .25-.25V13h.5v1.25c0 .138.112.25.25.25h1a.25.25 0 0 0 .25-.25V13h.084c1.992 0 3.416-1.033 3.416-2.82 0-1.502-1.007-2.323-2.186-2.44v-.088c.97-.242 1.683-.974 1.683-2.19C11.997 3.93 10.847 3 9.092 3H9V1.75a.25.25 0 0 0-.25-.25h-1a.25.25 0 0 0-.25.25V3h-.573V1.75a.25.25 0 0 0-.25-.25H5.75a.25.25 0 0 0-.25.25V3l-1.998.011a.25.25 0 0 0-.25.25v.989c0 .137.11.25.248.25l.755-.005a.75.75 0 0 1 .745.75v5.505a.75.75 0 0 1-.75.75l-.748.011a.25.25 0 0 0-.25.25v1c0 .138.112.25.25.25zm1.427-8.513h1.719c.906 0 1.438.498 1.438 1.312 0 .871-.575 1.362-1.877 1.362h-1.28zm0 4.051h1.84c1.137 0 1.756.58 1.756 1.524 0 .953-.626 1.45-2.158 1.45H6.927z"/></svg>;
}
const navigation = [
  {route:'overview',icon:House}, {route:'investments',icon:ChartNoAxesCombined}, {route:'payments',icon:ArrowRightLeft},
  {route:'crypto',icon:BitcoinIcon}, {route:'more',icon:MoreIcon},
] as const;
function parentTab(section:WalletRoute):WalletRoute {
  if(navigation.some(tab=>tab.route===section))return section;
  if(['move','transfer','withdraw','scheduled','request','add-money','exchange','currencies'].includes(section))return 'payments';
  if(['asset','crypto-receive','crypto-send','crypto-send-review'].includes(section))return 'crypto';
  if(['forecast','orders','order','trade','holdings','market-search'].includes(section))return 'investments';
  if(['settings','privacy','security','help','notifications'].includes(section))return 'more';
  return 'overview';
}
function SiteLink() {
  return <Link className="wallet-site-back" href="/"><ArrowLeft size={16} aria-hidden="true"/>Към SharkAI</Link>;
}
function Tabs({desktop,section,go}:{desktop:boolean;section:WalletRoute;go:Go}) {
  return <nav className={desktop?'desktop-header-tabs':'bottom-dock'} aria-label="Основна навигация">
    {desktop&&<SiteLink/>}
    {navigation.map(({route,icon:Icon})=><button type="button" key={route} onClick={()=>go(route)}
      aria-current={section===route?'page':undefined} className={section===route?(desktop?'is-selected':'selected'):''}>
      <Icon size={desktop?23:25}/><span>{walletTitles[route]}</span></button>)}
  </nav>;
}
function Avatar({desktop=false,toolbar=false}:{desktop?:boolean;toolbar?:boolean}) {
  return <span className={desktop?'desktop-shark-avatar':'shark-avatar reference-avatar-exact'} aria-hidden="true">
    {toolbar?<img src="/wallet-original/image-24.jpg" alt=""/>:
      <img className="wallet-avatar-crop" src="/wallet-original/reference-avatar.png" alt=""/>}</span>;
}
function ChatButton({desktop=false,floating=false}:{desktop?:boolean;floating?:boolean}) {
  if(desktop) return <div className="desktop-assistant-lane"><button type="button" className="desktop-assistant-launcher"
    data-shark-chat-launcher onClick={openSharkAssistant} aria-label="Отвори Shark Assistant">
    <Avatar desktop/><span className="desktop-assistant-online" aria-hidden="true"/><span>Shark Assistant</span><MessageCircle size={22}/></button></div>;
  return <button type="button" className={'chat-launch'+(floating?' floating':'')} data-shark-chat-launcher
    onClick={openSharkAssistant} aria-label="Отвори Shark Assistant" title="Shark Assistant"><Avatar/>
    <span className="chat-mark"><Ellipsis size={16}/></span><i className="online-dot"/></button>;
}
function Header({desktop,section,go}:{desktop:boolean;section:WalletRoute;go:Go}) {
  const controls=[{route:'search',icon:Search,label:'Търси'}, {route:'analytics',icon:ChartNoAxesColumn,label:'Анализи'},
    {route:'cards',icon:CardIcon,label:'Карти'}, {route:'profile',icon:UserRound,label:'Профил'}] as const;
  if(desktop) return <header className="desktop-wallet-header"><div className="desktop-header-main">
    <Link className="desktop-brand" href="/" aria-label="Към началната страница на SharkAI" title="Към SharkAI"><Avatar desktop/>
      <span className="desktop-brand-copy"><strong>Shark<span>AI</span></strong><span>Портфейл</span></span></Link>
    <div className="desktop-header-controls">{controls.map(({route,icon:Icon,label})=><button type="button" key={route}
      className={'desktop-header-control'+(route==='search'?' desktop-header-search':'')} onClick={()=>go(route)}>
      <Icon size={route==='search'?22:21}/><span>{label}</span></button>)}</div></div>
    <Tabs desktop section={section} go={go}/></header>;
  return <header className="home-header"><div className="top-toolbar">
    <button type="button" className="profile-button" aria-label="Профил" onClick={()=>go('profile')}><Avatar toolbar/></button>
    {controls.slice(0,3).map(({route,icon:Icon,label})=><button type="button" key={route} aria-label={label} onClick={()=>go(route)}
      className={route==='search'?'search-button glass-pill':'toolbar-icon glass-circle'}><Icon size={23}/>{route==='search'&&<span>{label}</span>}</button>)}
  </div></header>;
}
function QuickActions({desktop,go}:{desktop:boolean;go:Go}) {
  const actions=[{route:'add-money',label:'Захрани',icon:Plus},{route:'move',label:'Прехвърли',icon:Shuffle},
    {route:'details',label:'Детайли',icon:BankIcon},{route:'account-actions',label:'Още',icon:Ellipsis}] as const;
  return <div className={desktop?'desktop-quick-actions':'home-actions'}>{actions.map(({route,label,icon:Icon})=>
    <button key={route} type="button" className={desktop?'desktop-quick-action':'quick-action'} onClick={()=>go(route)}>
      <span className={desktop?'desktop-action-disc':'glass-circle'}><Icon size={29}/></span><span>{label}</span></button>)}</div>;
}
function CurrencyMark({desktop,currency}:{desktop:boolean;currency:string}) {
  if(currency==='EUR') return <span className={desktop?'desktop-currency-mark':'currency-emoji'} aria-hidden="true"><img src="/wallet-original/image-23.png" alt=""/></span>;
  return <span className={desktop?'desktop-currency-symbol':undefined} aria-hidden="true">{currency==='GBP'?'£':currency==='USD'?'$':currency}</span>;
}
function Recent({desktop,go,data,hidden,detail}:{desktop:boolean;go:Go;data:WalletData;hidden:boolean;detail:(i:number)=>void}) {
  const guest=data.account.state==='guest',hasRows=Boolean(data.statement?.transactions.length);
  const loading=data.account.state==='loading' || (data.account.data?.wallet_capabilities.deposit_statements && data.statement===undefined);
  const retry=data.account.state==='unavailable' || data.statement===null || data.account.data?.wallet.status==='verified';
  const button=!loading&&<button type="button" className={desktop?'desktop-text-link':'button secondary'} onClick={()=>{
    if(guest) window.location.assign(walletLogin('overview')); else if(retry) data.refresh(); else go('wise-connection');
  }}>{guest?'Вход в SharkAI':retry?'Обнови':'Връзка с Wise'}{desktop&&<ChevronRight size={16}/>}</button>;
  return <section className={desktop?'desktop-wallet-card desktop-transactions':'panel recent-panel'} data-scene="transactions" data-scene-tone="light" aria-label="Последни транзакции">
    {desktop&&<div className="desktop-card-art desktop-transactions-art" aria-hidden="true"/>}
    <div className={desktop?'desktop-transactions-heading':'recent-heading'}><h2>Последни транзакции</h2><span className="badge">Wise</span>
      <button type="button" className={desktop?'desktop-text-link':'see-all'} onClick={()=>go('transactions')}>Всички <ChevronRight size={16}/></button></div>
    {hasRows&&data.statement?<RecentRows desktop={desktop} statement={data.statement} hidden={hidden} detail={detail}/>:
      <div className={desktop?'desktop-transaction-empty':'no-transactions'}><ReceiptText size={desktop?29:24}/><p role="status">{data.historyStatus}</p>{button}</div>}
  </section>;
}
function Sheet({children,close,title}:{children:ReactNode;close:()=>void;title:string}) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const dialog=ref.current; dialog?.showModal(); return ()=>{dialog?.close();};},[]);
  return <dialog className="sheet-overlay wallet-dialog" ref={ref} aria-label={title} onCancel={event=>{event.preventDefault();close();}}>
    <button type="button" className="sheet-backdrop" aria-label="Затвори панела" onClick={close}/>
    <div className="bottom-sheet"><div className="sheet-grip"/><button type="button" className="sheet-close" aria-label="Затвори" onClick={close}><X/></button>
      {children}</div></dialog>;
}
export function WalletHome({section,transferUnavailable,pair,equities=false}:{section:WalletRoute;transferUnavailable:boolean;pair:string|null;equities?:boolean}) {
  const data=useWalletData(),router=useRouter(),desktop=useSyncExternalStore(subscribeViewport,isDesktop,()=>false);
  const [hidden,setHidden]=useState(false);
  const [selected,setSelected]=useState<{index:number;statement:WalletData['statement']}|null>(null);
  const visited=useRef<WalletRoute[]>([section]);
  const sheetParents=useRef<Partial<Record<WalletRoute,WalletRoute>>>({});
  const originatingTabs=useRef<Partial<Record<WalletRoute,WalletRoute>>>({});
  const activeTab=originatingTabs.current[section]??(equities?'investments':section==='market-search'?'crypto':parentTab(section));
  const scroll=useRef<HTMLDivElement>(null);
  const go:Go=route=>{
    if(route==='chat'){openSharkAssistant();return;}
    if(route!==section){
      originatingTabs.current[route]=navigation.some(tab=>tab.route===route)?route:activeTab;
      if(['accounts','move','account-actions'].includes(route))sheetParents.current[route]=sheetParents.current[section]??section;
      const marketContext=route==='market-search'&&activeTab==='investments'?'&kind=invest':'';
      router.push(walletUrl(route)+marketContext,{scroll:false});
    }
  };
  useEffect(()=>{
    const trail=visited.current;
    if(trail.at(-1)===section)return;
    if(trail.at(-2)===section)trail.pop();else trail.push(section);
  },[section]);
  useEffect(()=>{
    if(section!=='chat')return;
    const frame=requestAnimationFrame(openSharkAssistant);
    return ()=>cancelAnimationFrame(frame);
  },[section]);
  const back=()=>{if(visited.current.length>1)router.back();else router.replace('/wallet',{scroll:false});};
  const sheet=['accounts','move','account-actions'].includes(section);
  const base=sheet?(sheetParents.current[section]??'overview'):section;
  const home=base==='overview';
  const tabRoot=navigation.some(tab=>tab.route===base);
  useEffect(()=>{if(!sheet)scroll.current?.scrollTo(0,0);},[section,sheet]);
  const currency=data.account.data?.wallet.currency??data.account.data?.wallet_capabilities.selected_currency??data.account.data?.settings.currency??'EUR';
  const accountName=data.account.data?.wallet.status==='verified'?'Основна':'Портфейл';
  const pickerClass=desktop?'desktop-account-picker':'glass-pill account-switch';
  const accountDetails=data.account.data;
  const caps=accountDetails?.wallet_capabilities;
  const selectCurrency=Boolean(caps?.currencies?.length && !caps.selected_currency);
  let accountPicker=<button type="button" className={pickerClass} onClick={()=>go('accounts')}>{desktop&&<Wallet size={20}/>}
    <span>{desktop?'Сметки и джобове':'Сметки'}</span>{desktop&&<ChevronDown size={19}/>}</button>;
  if(accountDetails && accountDetails.wallet.status!=='verified') {
    if(selectCurrency) accountPicker=<button type="button" className={pickerClass} onClick={()=>go('wise-connection')}>Избери валута</button>;
    else if(caps?.hosted_kyc) accountPicker=<WiseReviewForm className={pickerClass}>Проверка в Wise</WiseReviewForm>;
    else accountPicker=<WiseWindowLink className={pickerClass}>Отвори моя Wise</WiseWindowLink>;
  }
  if(data.account.state==='guest') accountPicker=<WiseWindowLink className={pickerClass}>Отвори моя Wise</WiseWindowLink>;
  const balance=hidden?'••••':accountBalance(data.account),toggle=()=>setHidden(v=>!v);
  const detail=(index:number)=>{setSelected({index,statement:data.statement});go('transaction');};
  const view=(route:WalletRoute)=><WalletView key={route} route={route} pair={pair} equities={equities} go={go} data={data} currency={currency} hidden={hidden}
    transaction={selected&&selected.statement===data.statement?selected.index:null} detail={detail}/>;
  return <div className="zip-wallet" data-wallet-route={section}><div className={'workspace'+(desktop?' desktop-layout':'')}><div
    className={'app-shell '+(home?'home-view':'page-view')+(desktop?' desktop-layout':'')}>
    <div className="landscape"/><div className="scene-shade"/><div className="scroll-area" ref={scroll}>
      <Header desktop={desktop} section={activeTab} go={go}/>
      {!home&&<div className="page-context"><button type="button" className="page-back" onClick={tabRoot?()=>go('overview'):back}><span className="glass-circle"><ArrowLeft size={21}/></span><span>{tabRoot?'Начало':'Назад'}</span></button>
        <Link className="page-context-brand" href="/" aria-label="Към началната страница на SharkAI">Shark<span>AI</span></Link><span className="badge">WISE</span></div>}
      <main className="route-container forward" data-route={base} key={base}>
        {transferUnavailable&&<p role="alert" className="wallet-transfer-error">Wise е временно недостъпен. Превод не е създаден.</p>}
        {home?desktop?<section className="desktop-wallet" aria-label="Начало">
        <section className="desktop-wallet-card desktop-funds"><div className="desktop-card-art desktop-funds-art" aria-hidden="true"/>
            <div className="desktop-funds-copy"><div className="desktop-funds-heading"><h1>Достъпни средства</h1>
              <span className="badge">{accountLabel(data.account)}</span></div><p className="desktop-account-name">{accountName} <span>· {currency}</span></p>
              <div className="desktop-balance-line"><span className="desktop-balance-number">{balance}</span>
                <span className="desktop-balance-currency"><CurrencyMark desktop currency={currency}/>{currency}</span>
                <button type="button" className="desktop-balance-toggle" onClick={toggle} aria-label={hidden?'Покажи баланса':'Скрий баланса'}>{hidden?<EyeOff/>:<Eye/>}</button></div>
              {accountPicker}</div>
            <QuickActions desktop go={go}/></section><Recent desktop data={data} hidden={hidden} go={go} detail={detail}/>
          <WalletReferenceConverter compact/><ChatButton desktop/></section>:
          <section className="home" aria-label="Начало"><div className="home-hero"><p className="account-label">{accountName} · <CurrencyMark desktop={false} currency={currency}/> {currency}</p>
            <button type="button" className="home-balance" onClick={toggle} aria-label={hidden?'Покажи баланса':'Скрий баланса'}><span>{balance}</span>
              <small>{{EUR:'€',USD:'$',GBP:'£'}[currency]??currency}</small></button>
            {accountPicker}</div>
            <QuickActions desktop={false} go={go}/><div className="home-chat-lane"><SiteLink/><ChatButton/></div>
            <Recent desktop={false} go={go} data={data} hidden={hidden} detail={detail}/></section>:view(base)}
      </main></div>
    {!desktop&&!sheet&&<Tabs desktop={false} section={activeTab} go={go}/>}
    {!home&&!sheet&&<ChatButton floating/>}
    {sheet&&<Sheet close={back} title={walletTitles[section]}>{view(section)}</Sheet>}
  </div></div></div>;
}
