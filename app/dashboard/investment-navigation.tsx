'use client';

import {useSearchParams,useRouter} from 'next/navigation';
import type {KeyboardEvent,ReactNode} from 'react';
import {Activity,Calculator,ChartCandlestick,Compass,MessagesSquare} from 'lucide-react';
import './investment-navigation.css';

const views=[
  {id:'overview',label:'Обзор и прогрес',icon:Activity},
  {id:'strategies',label:'Стратегии и чат',icon:MessagesSquare},
  {id:'calculator',label:'Калкулатор',icon:Calculator},
  {id:'opportunities',label:'Възможности и анализ',icon:Compass},
  {id:'crypto',label:'Криптопазар',icon:ChartCandlestick},
] as const;
export type InvestmentTab=(typeof views)[number]['id'];

export function InvestmentNavigation({children}:{children:(tab:InvestmentTab)=>ReactNode}) {
  const params=useSearchParams(),router=useRouter();
  const active=views.find(tab=>tab.id===params.get('tab'))?.id??'overview';
  function select(tab:InvestmentTab) {
    const query=new URLSearchParams(params.toString());
    query.set('view','investments');
    if(tab==='overview')query.delete('tab');else query.set('tab',tab);
    router.replace('/dashboard?'+query.toString(),{scroll:false});
  }
  function navigate(event:KeyboardEvent<HTMLButtonElement>,index:number) {
    let next=index;
    if(event.key==='ArrowRight')next=(index+1)%views.length;
    else if(event.key==='ArrowLeft')next=(index+views.length-1)%views.length;
    else if(event.key==='Home')next=0;
    else if(event.key==='End')next=views.length-1;
    else return;
    event.preventDefault();document.getElementById('investment-tab-'+views[next].id)?.focus();select(views[next].id);
  }
  return <div className="investment-workspace"><div role="tablist" aria-label="Инвестиционни инструменти" className="investment-tabs">
    {views.map(({id,label,icon:Icon},index)=><button type="button" key={id} role="tab" id={'investment-tab-'+id}
      aria-controls={'investment-panel-'+id} aria-selected={active===id} tabIndex={active===id?0:-1}
      onKeyDown={event=>navigate(event,index)} onClick={()=>select(id)}><Icon aria-hidden="true"/>{label}</button>)}
  </div>{views.map(({id})=><section key={id} id={'investment-panel-'+id} role="tabpanel" aria-labelledby={'investment-tab-'+id}
    tabIndex={id===active?0:-1} hidden={id!==active} className="investment-tab-panel">{id===active&&children(id)}</section>)}</div>;
}
