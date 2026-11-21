'use client';

import {useState} from 'react';
import {currencyMinorDigits,displayMinor,parseDecimalMinor} from '@/lib/wallet-investments-contract';
import type {WalletInvestmentsOwnerDashboard} from '@/lib/wallet-investments-server';

function units(text:string,digits:number,signed=false) {
  const raw=text.trim().replace('−','-');
  const zero=/^-?0(?:[.,](0+))?$/.exec(raw);
  if(zero&&(!raw.startsWith('-')||signed)&&(zero[1]?.length??0)<=digits)return BigInt(0);
  const negative=raw.startsWith('-'),value=parseDecimalMinor(negative?raw.slice(1):raw,digits);
  if(value===null||negative&&!signed)return null;
  return BigInt(value)*(negative?BigInt(-1):BigInt(1));
}
export function InvestmentFeeCalculator({data}:{data:WalletInvestmentsOwnerDashboard|null}) {
  const [net,setNet]=useState(''),[distance,setDistance]=useState(''),[openLoss,setOpenLoss]=useState('');
  const [preferred,setPreferred]=useState<string|null>(null);
  const currency=preferred??data?.settings.currency??'EUR',digits=currencyMinorDigits(currency)??2;
  const cash=units(net,digits,true),gap=units(distance,digits,true),loss=units(openLoss,digits);
  const positive=cash!==null&&gap!==null&&loss!==null?cash-gap-loss:null;
  const eligible=positive===null?null:positive>0?positive:BigInt(0);
  const lower=eligible===null?null:eligible/BigInt(10),upper=eligible===null?null:(eligible+BigInt(9))/BigInt(10);
  const money=(n:bigint)=>displayMinor(n.toString(),currency);
  const format=(lo:bigint,hi:bigint)=>lo===hi?money(lo):money(lo)+' – '+money(hi);
  return <section className="ice-section module-panel module-wallet-panel" data-scene="estimate" data-scene-tone="light">
    <h2>Изчисли таксата и сумата за собственика</h2>
    <p>Таксата е 10% върху новата уредена нетна печалба над предишния таксуван връх. Въведи стойностите за края на един отчетен период.</p>
    <div className="investment-calc-inputs">
      <label>Валута<select value={currency} onChange={e=>{setPreferred(e.target.value);setNet('');setDistance('');setOpenLoss('');}}>
        {Intl.supportedValuesOf('currency').map(code=><option key={code}>{code}</option>)}</select></label>
      <label>Реализиран нетен резултат за периода<input inputMode="decimal" value={net} onChange={e=>setNet(e.target.value)}/></label>
      <label>Таксуван връх минус начален реализиран баланс<input inputMode="decimal" value={distance} onChange={e=>setDistance(e.target.value)}/></label>
      <label>Нереализирани загуби в края на периода<input inputMode="decimal" value={openLoss} onChange={e=>setOpenLoss(e.target.value)}/></label>
    </div>
    <p>Ако началният баланс е точно на предишния връх, въведи 0 за разликата. Ако има загуба по открити позиции, въведи положителната ѝ стойност.</p>
    {(net&&cash===null||distance&&gap===null||openLoss&&loss===null)&&<p role="alert">Провери сумите и броя знаци след десетичната запетая за тази валута.</p>}
    {cash!==null&&eligible!==null&&lower!==null&&upper!==null&&<div aria-live="polite">
      <dl className="module-wallet-metrics">
        <div><dt>Нова допустима печалба</dt><dd>{money(eligible)}</dd></div>
        <div><dt>Ориентировъчна такса</dt><dd>{format(lower,upper)}</dd></div>
        <div><dt>Реализиран резултат за собственика след такса</dt><dd>{format(cash-upper,cash-lower)}</dd></div>
      </dl>{lower!==upper&&<p>Разликата от една най-малка парична единица зависи от натрупаното закръгляне от предишни периоди.</p>}
    </div>}
  </section>;
}
