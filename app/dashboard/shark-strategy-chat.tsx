'use client';

import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Send} from 'lucide-react';
import './shark-strategy-chat.css';

type Line = {id:string;role:string;content:string};

type Props={strategyId:string|null;strategyLabel:string|null;currency?:string;horizonDays?:number};

export function SharkStrategyChat(props:Props) {
  return <StrategyThread key={props.strategyId||'general'} {...props}/>;
}

function StrategyThread({strategyId,strategyLabel,currency,horizonDays}:Props) {
  const [conversation,setConversation]=useState('');
  const [lines,setLines]=useState<Line[]>([]);
  const [draft,setDraft]=useState('');
  const [error,setError]=useState('');
  const [guest,setGuest]=useState(false);
  const [pending,setPending]=useState(false);
  const [attempt,setAttempt]=useState(0);
  const active=useRef<AbortController|null>(null);
  const retry=useRef<{message:string;id:string}|null>(null);
  useEffect(()=>{
    const controller=new AbortController();
    setError('');
    async function open() {
      try {
        const response=await fetch('/api/chat/strategy?strategy='+encodeURIComponent(strategyId||'general'),{cache:'no-store',signal:controller.signal});
        const data=await response.json();
        if (controller.signal.aborted) return;
        if (response.status===401) {setGuest(true);return;}
        if (!response.ok) throw new Error(data.error||'Разговорът не се зареди.');
        setConversation(data.conversationId);setLines(data.messages);
      } catch (failure) {if (!controller.signal.aborted) setError(failure instanceof Error?failure.message:'Разговорът не се зареди.');}
    }
    void open();
    return ()=>{controller.abort();active.current?.abort();};
  },[strategyId,attempt]);

  async function send(event:FormEvent) {
    event.preventDefault();
    if (!draft.trim()||!conversation||active.current) return;
    const message=(strategyLabel?'Стратегия „'+strategyLabel+'“\n\n':'')+draft.trim();
    const id=retry.current?.message===message?retry.current.id:crypto.randomUUID();
    retry.current={message,id};
    const controller=new AbortController();
    active.current=controller;setPending(true);setError('');
    try {
      const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({
        conversationId:conversation,requestId:id,message,model:'auto',
        ...(strategyId&&{strategy:strategyId,strategyCurrency:currency,strategyDays:horizonDays}),
      })});
      const data=await response.json();
      if (response.status===401) {setGuest(true);return;}
      if (!response.ok) throw new Error(data.error||'Shark временно е недостъпен.');
      setLines(previous=>[...previous,...data.messages.filter((line:Line)=>!previous.some(item=>item.id===line.id))]);
      setDraft('');retry.current=null;
    } catch (failure) {if (!controller.signal.aborted) setError(failure instanceof Error?failure.message:'Изпращането прекъсна.');}
    finally {if (!controller.signal.aborted){setPending(false);active.current=null;}}
  }
  return <section className="shark-strategy-thread" data-scene="assistant" data-scene-tone="light" aria-label="Разговор за стратегията">
    <h3>Обсъди със Shark</h3>
    <div role="log" aria-live="polite">{lines.map(line=><p key={line.id}><strong>{line.role==='assistant'?'Shark AI':'Ти'}</strong><br/>{line.content}</p>)}</div>
    {guest ? <a className="shark-action-secondary" href={'/login?next='+encodeURIComponent('/dashboard?view=investments&tab=strategies')}>Влез за разговор</a> :
      <form onSubmit={send}><label htmlFor="strategy-question">Въпрос за {strategyLabel||'инвестиционната стратегия'}</label>
        <textarea id="strategy-question" rows={3} maxLength={7500} value={draft} onChange={e=>setDraft(e.target.value)} disabled={pending||!conversation}/>
        <button type="submit" className="shark-action-primary" disabled={!conversation||!draft.trim()||pending}><Send size={16}/> {pending?'Shark обмисля въпроса…':'Изпрати'}</button>
      </form>}
    {error&&<p role="alert">{error} {!conversation&&!guest&&<button type="button" onClick={()=>setAttempt(n=>n+1)}>Опитай отново</button>}</p>}
  </section>;
}
