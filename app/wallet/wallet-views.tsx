'use client';

import Link from 'next/link';
import {useState, type ReactNode} from 'react';
import {ArrowDown, ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Bell, CalendarClock, ChartNoAxesCombined, ChevronRight, CircleHelp, CreditCard,
  ExternalLink, FileText, Landmark, Link2, LockKeyhole, MessageCircle, PiggyBank, Plus, ReceiptText, RefreshCw,
  Search, Send, Settings, ShieldCheck, Wallet, type LucideIcon} from 'lucide-react';
import {displayMinor} from '@/lib/wallet-investments-contract';
import {portfolioFromDashboard} from '../dashboard/portfolio-account';
import WalletForecast from '../dashboard/wallet-forecast';
import {accountBalance, accountLabel, dateLabel, type Statement, type WalletData} from './wallet-data';
import {WalletReferenceConverter} from './wallet-premium-extras';
import {walletLogin, walletTitles, type WalletRoute} from './wallet-routes';
import {WalletSettings} from './wallet-settings';
import {PublicAsset,PublicMarkets,EquityMarkets} from './wallet-market';

type Props = {route:WalletRoute; pair:string|null; equities?:boolean; go:(route:WalletRoute)=>void; data:WalletData; currency:string; hidden:boolean;
  transaction:number|null; detail:(index:number)=>void};
const icons: Partial<Record<WalletRoute,LucideIcon>> = {
  accounts:Wallet, pockets:PiggyBank, cards:CreditCard, crypto:ChartNoAxesCombined, transactions:ReceiptText,
  payments:ArrowLeftRight, transfer:Send, 'add-money':Plus, withdraw:Landmark, request:ReceiptText,
  currencies:ArrowLeftRight, exchange:ArrowLeftRight, 'wise-connection':Link2, notifications:Bell, settings:Settings,
  security:ShieldCheck, privacy:LockKeyhole, help:CircleHelp, chat:MessageCircle, analytics:ChartNoAxesCombined,
  details:FileText, forecast:ChartNoAxesCombined, holdings:Wallet, investments:ChartNoAxesCombined, 'market-search':Search,
};
const subtitles:Partial<Record<WalletRoute,string>> = {
  payments:'Всичко важно, на едно място',accounts:'Наличностите от твоя Wise акаунт',
  cards:'Твоите карти от Wise',more:'Всичко важно, подредено.',search:'Функции и движения',
  'wise-connection':'Състояние и достъп до данните',transactions:'Осчетоводени движения от Wise',
  investments:'Твоите активи на едно място',crypto:'Твоите активи на едно място',
};
function Row({title,description,end,icon:Icon,onClick}:{title:string;description?:string;end?:ReactNode;icon?:LucideIcon;onClick?:()=>void}) {
  const contents=<>{Icon&&<span className="row-icon"><Icon size={22}/></span>}
    <span className="row-label"><strong>{title}</strong>{description&&<small>{description}</small>}</span>
    {end!==undefined?<span className="row-end">{end}</span>:onClick?<ChevronRight size={18}/>:null}</>;
  return onClick?<button type="button" className="item-row clickable" onClick={onClick}>{contents}</button>:<div className="item-row">{contents}</div>;
}
function Unavailable({icon:Icon=LockKeyhole,title='Няма потвърдени данни',description}:{icon?:LucideIcon;title?:string;description:string}) {
  return <div className="empty" role="status"><span className="empty-icon"><Icon size={34}/></span><h2>{title}</h2><p className="muted">{description}</p></div>;
}
function WiseLink() {
  return <a className="button secondary" href="https://wise.com/home/" target="_blank" rel="noopener noreferrer"><ArrowUpRight size={19}/><span>Отвори Wise</span></a>;
}
function Screen({route,children,action}:{route:WalletRoute;children:ReactNode;action?:ReactNode}) {
  return <section className="screen"><header className="screen-heading"><div><h1>{walletTitles[route]}</h1>
    {subtitles[route]&&<p className="muted">{subtitles[route]}</p>}</div>{action}</header><div className="stack">{children}</div></section>;
}
function Menu({routes,go}:{routes:WalletRoute[];go:Props['go']}) {
  return <div className="panel"><div className="list">{routes.map(route=><Row key={route} title={walletTitles[route]}
    icon={icons[route]??ChevronRight} onClick={()=>go(route)}/>)}</div></div>;
}
function amount(row:Statement['transactions'][number],currency:string,hidden:boolean) {
  return hidden?'••••':(row.direction==='credit'?'+':'−')+displayMinor(row.amount_minor,currency);
}
export function RecentRows({desktop,statement,hidden,detail}:{desktop:boolean;statement:Statement;hidden:boolean;detail:Props['detail']}) {
  return <div className={desktop?'desktop-transaction-list':'recent-list'}>{statement.transactions.slice(0,3).map((row,index)=>{
    const credit=row.direction==='credit',Icon=credit?ArrowDown:ArrowUpRight;
    return <button key={index} type="button" onClick={()=>detail(index)} className={desktop?'desktop-transaction-row':'recent-row'}>
      <span className={desktop?'desktop-transaction-icon':'recent-icon'}><Icon size={21}/></span>
      <span className={desktop?'desktop-transaction-copy':'recent-copy'}><strong>{row.category}</strong><small>{desktop?'Wise':dateLabel(row.occurred_at)}</small></span>
      {desktop&&<time dateTime={row.occurred_at}>{dateLabel(row.occurred_at)}</time>}
      <strong className={(desktop?'desktop-transaction-amount':'recent-value')+(credit?(desktop?' is-positive':' positive'):'')}>{amount(row,statement.currency,hidden)}</strong>
      {desktop&&<ChevronRight size={15}/>}</button>;
  })}</div>;
}
function Movements({data,query,hidden,detail}:{data:WalletData;query:string;hidden:boolean;detail:Props['detail']}) {
  if (!data.statement?.transactions.length) return <div className="panel"><Unavailable icon={ReceiptText} description={data.historyStatus}/></div>;
  const statement=data.statement;
  const needle=query.trim().toLocaleLowerCase('bg-BG');
  const rows=statement.transactions.map((row,index)=>({row,index})).filter(({row})=>
    [row.category,row.occurred_at,dateLabel(row.occurred_at),...(hidden?[]:[displayMinor(row.amount_minor,statement.currency)])].join(' ').toLocaleLowerCase('bg-BG').includes(needle));
  return <div className="panel"><p className="micro">Wise · {dateLabel(statement.from)} – {dateLabel(statement.to)}</p>
    {rows.map(({row,index})=><Row key={index} title={row.category} description={dateLabel(row.occurred_at,true)}
      end={amount(row,statement.currency,hidden)} icon={row.direction==='credit'?ArrowDown:ArrowUpRight} onClick={()=>detail(index)}/>)}
    {!rows.length&&<p>Няма съвпадения за това търсене.</p>}
    {statement.has_more&&<p className="micro">Показани са последните 100 движения. Пълното извлечение е в Wise.</p>}
    <p className="micro">Към {dateLabel(statement.as_of,true)} (София)</p></div>;
}
function SearchScreen({route,data,hidden,go,detail}:Props) {
  const [query,setQuery]=useState('');
  const all=route==='search';
  const routes:WalletRoute[]=['accounts','pockets','transactions','cards','analytics','investments','crypto','currencies','transfer','settings','chat'];
  const filtered=routes.filter(key=>walletTitles[key].toLocaleLowerCase('bg-BG').includes(query.trim().toLocaleLowerCase('bg-BG')));
  return <><label className="field"><span>{all?'Търси в портфейла':'Търси в движенията'}</span><input type="search" value={query}
    placeholder={all?'Сметки, плащания, карти…':'Категория, дата, сума…'} onChange={e=>setQuery(e.target.value)}/></label>
    {all&&filtered.length>0&&<Menu go={go} routes={filtered}/>}<Movements data={data} hidden={hidden} query={query} detail={detail}/></>;
}
function Analytics({data,hidden,go}:Props) {
  const [flow,setFlow]=useState<'credit'|'debit'>('debit'),statement=data.statement;
  if(!statement?.transactions.length)return <div className="panel"><Unavailable icon={ChartNoAxesCombined} description={data.historyStatus}/></div>;
  const totals=new Map<string,bigint>();
  statement.transactions.filter(row=>row.direction===flow).forEach(row=>totals.set(row.category,(totals.get(row.category)??BigInt(0))+BigInt(row.amount_minor)));
  return <><div className="segmented">{(['debit','credit'] as const).map(key=><button type="button" key={key}
    className={key===flow?'active':''} aria-pressed={key===flow} onClick={()=>setFlow(key)}>{key==='debit'?'Изходящи':'Входящи'}</button>)}</div>
    <div className="panel"><p className="micro">Wise · {dateLabel(statement.from)} – {dateLabel(statement.to)} · {statement.currency}</p>
      {[...totals].map(([category,sum])=><Row key={category} title={category} end={hidden?'••••':displayMinor(sum.toString(),statement.currency)}/>)}
      {!totals.size&&<p>За периода няма движения в тази посока.</p>}
      {statement.has_more&&<p className="micro">Обобщението включва последните 100 движения.</p>}</div><Menu routes={['transactions']} go={go}/></>;
}
function InvestmentView({data,route,go,hidden}:Props) {
  const portfolio=data.account.data?portfolioFromDashboard(data.account.data):null;
  const crypto=route==='crypto';
  if(route==='holdings')return <div className="panel">{portfolio?.holdings.length?portfolio.holdings.map(row=><Row key={row.id}
    title={row.symbol} description={row.provider+' · '+dateLabel(row.asOf,true)} end={hidden?'••••':row.units+' бр.'}/>):
    <Unavailable icon={Wallet} description={portfolio?.holdingsStatus==='verified'?'Свързаният брокер не отчита открити позиции.':'За позиции е необходима потвърдена справка от свързан брокер.'}/>}</div>;
  if(route==='orders'||route==='order')return <div className="panel">{portfolio?.activity.length?portfolio.activity.map(row=>
    <Row key={row.id} title={row.title} description={(hidden?'':row.detail+' · ')+dateLabel(row.time,true)} end={row.status}/>):
    <Unavailable icon={ReceiptText} description="Няма потвърдени поръчки от свързан брокер."/ >}</div>;
  return <><div className="panel"><div className="row"><span className="muted">Стойност на активите</span>
    <span className="badge">{!crypto&&portfolio?.value?portfolio.provider:'Няма потвърдени данни'}</span></div>
    <div className="amount">{hidden?'••••':crypto?'—':portfolio?.value??'—'}</div>
    <p className="micro muted">{crypto?'Няма свързана крипто сметка.':portfolio?.asOf?dateLabel(portfolio.asOf,true)+' (София)':'Няма потвърдена оценка от брокер.'}</p>
    <div className="grid-2"><button className="button primary" onClick={()=>go('trade')}><ArrowLeftRight size={19}/>Търгувай</button>
      <button className="button secondary" onClick={()=>go(crypto?'crypto-receive':'investment-fund')}><Wallet size={19}/>{crypto?'Получи':'Средства'}</button>
      {crypto&&<button className="button secondary" onClick={()=>go('crypto-send')}><ArrowUpRight size={19}/>Изпрати</button>}
      <button className="button secondary" onClick={()=>go('orders')}><ReceiptText size={19}/>История</button></div></div>
    {crypto?<><PublicMarkets compact/><details className="panel"><summary>Конвертор за крипто активи</summary>
      <WalletReferenceConverter initialPair="crypto"/></details></>:<>
      <EquityMarkets/>
      <Menu go={go} routes={['holdings','forecast']}/><a className="button secondary" href="/dashboard?view=investments"><ExternalLink size={18}/>Инвестиционно табло</a></>}</>;
}
const paymentInstructions:Partial<Record<WalletRoute,string>>={
  transfer:'В Wise избери „Изпрати“, посочи получателя, сумата и валутата. Wise показва таксата, курса и крайната сума преди твоето потвърждение.',
  withdraw:'В Wise избери превод към своя банкова сметка и прегледай таксите преди потвърждение.',
  'add-money':'В Wise избери сметката за захранване, въведи сумата и потвърди избрания метод при доставчика.',
  exchange:'За реална обмяна избери сметките и прегледай офертата на Wise преди потвърждение.',
  request:'Създай и сподели платежна заявка в своя профил при доставчика.',
  scheduled:'Прегледай планираните си преводи и наличните възможности в Wise.',
  beneficiaries:'Управлявай получателите в своя удостоверен профил в Wise.',
};
function Content(props:Props) {
  const {route,go,data,currency,hidden,transaction}=props, {account,statement}=data;
  const menu=(routes:WalletRoute[])=><Menu routes={routes} go={go}/>;
  const signIn=<Link className="button primary" href={walletLogin(route)}>Вход в SharkAI <ArrowUpRight size={18}/></Link>;
  switch(route) {
    case 'payments':return <><div className="grid-2"><button type="button" className="button primary" onClick={()=>go('transfer')}><ArrowUpRight size={19}/>Изпрати</button>
      <button type="button" className="button secondary" onClick={()=>go('request')}><ArrowDownLeft size={19}/>Поискай</button></div>
      <div className="panel"><div className="list">
        <Row icon={Plus} title="Добави пари" description="Захрани сметката в Wise" onClick={()=>go('add-money')}/>
        <Row icon={ArrowLeftRight} title="Обмяна" description="Курс и потвърждение при доставчика" onClick={()=>go('exchange')}/>
        <Row icon={ArrowUpRight} title="Премести пари" description="Превод, обмяна или джоб" onClick={()=>go('move')}/>
        <Row icon={CalendarClock} title="Планирани преводи" description="Преглед при доставчика" onClick={()=>go('scheduled')}/></div></div>
      <div className="panel"><h2 className="section-title">Получатели</h2><Row title="Получатели в Wise" description="Защитено управление при доставчика" icon={Wallet} onClick={()=>go('beneficiaries')}/></div></>;
    case 'move':return <div className="panel"><Row title="Към получател" description="Паричен превод чрез Wise" icon={ArrowUpRight} onClick={()=>go('transfer')}/>
      <Row title="Между валути" description="Курс и потвърждение при доставчика" icon={ArrowLeftRight} onClick={()=>go('exchange')}/>
      <Row title="Към джоб" description="Сметки и джобове в Wise" icon={PiggyBank} onClick={()=>go('pockets')}/></div>;
    case 'more':return <><div className="panel"><div className="list">
      <Row title="Сметки и джобове" description="Валути, цели и скрити сметки" icon={Wallet} onClick={()=>go('accounts')}/>
      <Row title="Карти" description="Управление, лимити и сигурност" icon={CreditCard} onClick={()=>go('cards')}/>
      <Row title="Валутен конвертор" description="Справка за обменните курсове" icon={ArrowLeftRight} onClick={()=>go('currencies')}/>
      <Row title="Последни транзакции" icon={ReceiptText} onClick={()=>go('transactions')}/>
      <Row title="Анализи" description="Приходи, разходи и категории" icon={ChartNoAxesCombined} onClick={()=>go('analytics')}/>
      </div></div>{menu(['scheduled','profile','security','settings','help','chat'])}</>;
    case 'account-actions':return menu(['transactions','exchange','pockets','scheduled','withdraw','hidden']);
    case 'search':case 'transactions':return <SearchScreen {...props}/>;
    case 'transaction': {
      const row=transaction===null?null:statement?.transactions[transaction];
      return <>{row&&statement?<div className="panel"><strong className="amount">{amount(row,statement.currency,hidden)}</strong>
        <Row title="Категория" end={row.category}/><Row title="Осчетоводено" end={dateLabel(row.occurred_at,true)}/><Row title="Източник" end="Wise"/></div>:
        <div className="panel"><Unavailable icon={ReceiptText} description="Избери осчетоводено движение от извлечението."/></div>}{menu(['transactions'])}</>;
    }
    case 'analytics':return <Analytics {...props}/>;
    case 'accounts':case 'details':return <><div className="panel">
      {account.data?.wallet.status==='verified'?<><Row title="Сметка" end="Основна"/><Row title="Валута" end={currency}/>
        <Row title="Наличност" end={hidden?'••••':accountBalance(account)+' '+currency}/><p className="micro">Wise · {dateLabel(account.data.wallet.observed_at,true)}</p></>:
        <Unavailable icon={Wallet} title={accountLabel(account)} description="Wise предоставя баланса след потвърдена връзка със сметката."/>}</div>
      {account.state==='guest'&&signIn}{route==='details'?<><div className="panel"><p>Банковите реквизити и IBAN са достъпни в Wise.</p></div><WiseLink/></>:null}
      {menu(route==='accounts'?['details','pockets','hidden','new-account','wise-connection']:['accounts','wise-connection'])}</>;
    case 'cards':return <><div className="panel"><Unavailable icon={CreditCard} title="Картата още не е достъпна"
      description="За тази сметка няма потвърдени картови данни от Wise."/></div>{menu(['wise-connection'])}<WiseLink/></>;
    case 'pockets':case 'hidden':return <><div className="panel"><Unavailable icon={PiggyBank}
      description="Свързаната услуга не предоставя списък на тези сметки."/></div><WiseLink/>{menu(['accounts','wise-connection'])}</>;
    case 'settings':case 'wise-connection':return <WalletSettings account={account} update={data.setAccount}/>;
    case 'profile':return <>{account.state==='guest'&&signIn}{menu(['wise-connection','settings','notifications','security','privacy','help'])}
      <Link className="button secondary" href="/dashboard">Към SharkAI <ArrowUpRight size={18}/></Link></>;
    case 'privacy':case 'security':return <><div className="panel"><p>Достъпът до сметката се проверява чрез твоя профил в SharkAI.
      Настройките на Wise и допълнителното удостоверяване се управляват при доставчика.</p></div>{menu(['settings','wise-connection'])}<WiseLink/></>;
    case 'help':return <>{menu(['chat','wise-connection','transactions'])}<a className="button secondary" href="https://wise.com/help/" target="_blank" rel="noopener noreferrer">Помощ от Wise <ExternalLink size={18}/></a></>;
    case 'chat':return <button type="button" className="button primary" data-shark-chat-launcher onClick={()=>go('chat')}><MessageCircle size={20}/>Отвори Shark Assistant</button>;
    case 'currencies':return <WalletReferenceConverter/>;
    case 'asset':return <>{props.equities?<EquityMarkets symbol={props.pair}/>:<PublicAsset pair={props.pair}/>}
      {menu(['market-search','trade'])}</>;
    case 'market-search':return props.equities?<EquityMarkets searchable/>:<PublicMarkets/>;
    case 'crypto':case 'investments':case 'holdings':case 'orders':case 'order':return <InvestmentView {...props}/>;
    case 'forecast':return <div className="panel"><WalletForecast currency={currency} initialAmountMinor={account.data?.wallet.status==='verified'?account.data.wallet.balance_minor:null}/></div>;
    case 'notifications':return <div className="panel"><Unavailable icon={Bell} description="Няма потвърдени известия от платежния доставчик."/></div>;
  }
  const instruction=paymentInstructions[route];
  if(instruction)return <><div className="panel"><p>{instruction}</p></div>
    {route==='exchange'&&menu(['currencies'])}
    {account.state==='guest'?signIn:account.state==='loading'||account.state==='unavailable'?<div className="panel"><p role="status">{accountLabel(account)}</p></div>:
      route==='transfer'?<form method="POST" action="/api/wallet-investments/provider/transfer">
        <button className="button primary" type="submit"><Send size={19}/>Продължи в Wise</button></form>:<WiseLink/>}
    {menu(['wise-connection'])}</>;
  if(['trade','trade-review','trade-result','investment-fund','crypto-send','crypto-send-review','crypto-receive'].includes(route))return <>
    <div className="panel"><Unavailable description="За тази операция няма разрешена интеграция за изпълнение. Потвърдените позиции и поръчки са достъпни в портфолиото."/></div>
    {menu(['holdings','orders','investments'])}</>;
  if(['payment-result','request-result','scheduled-detail','transfer-review','exchange-review','add-money-review'].includes(route))return <>
    <div className="panel"><Unavailable icon={ReceiptText} title="Няма потвърдена операция" description="Провери актуалното състояние в Wise. Осчетоводените движения се показват в извлечението."/></div>
    <WiseLink/>{menu(['transactions','payments'])}</>;
  const card=route.includes('card'),pocket=route.includes('pocket');
  return <><div className="panel"><Unavailable icon={card?CreditCard:pocket?PiggyBank:Wallet} title="Още не е активирано"
    description={card?'Данните и настройките на картата се управляват в удостоверения профил при издателя.':
      pocket?'За управлението на този джоб е необходим достъп при доставчика.':'За това действие е необходим достъп при платежния доставчик.'}/></div>
    <WiseLink/>{menu([card?'cards':pocket?'pockets':'accounts','wise-connection'])}</>;
}
export function WalletView(props:Props) {
  const refresh=['accounts','cards','transactions','wise-connection','holdings','orders'].includes(props.route);
  const action=refresh?<button type="button" className="button secondary" disabled={props.data.account.state==='loading'}
    onClick={props.data.refresh}><RefreshCw size={18}/>Обнови</button>:
    props.route==='payments'?<button type="button" className="button ghost" onClick={()=>props.go('scheduled')}><CalendarClock size={19}/>Планирани</button>:
    ['investments','crypto'].includes(props.route)?<button type="button" className="button ghost" onClick={()=>props.go('market-search')}><Search size={19}/>Търси</button>:undefined;
  return <Screen route={props.route} action={action}><Content {...props}/></Screen>;
}
