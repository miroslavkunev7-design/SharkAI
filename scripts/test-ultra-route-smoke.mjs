#!/usr/bin/env node
/** Smoke-test actual Next.js production routes without a real Wise account or database writes. */
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {createServer} from 'node:net';
import {tsImport} from 'tsx/esm/api';

const check=(path,regex)=>({path,regex});
const imported = await tsImport('../app/wallet/wallet-routes.ts', import.meta.url);
const {walletTitles, walletUrl} = imported.default ?? imported;
const checks=[
 ...Object.keys(walletTitles).map(route => check(walletUrl(route), new RegExp('data-wallet-route="'+route+'"'))),
 check('/wallet?tab=home', /data-wallet-route="overview"/),
 check('/wallet?tab=invest', /data-wallet-route="investments"/),
 check('/wallet?tab=account-new', /data-wallet-route="new-account"/),
 check('/wallet?tab=pocket-new', /data-wallet-route="new-pocket"/),
 check('/wallet?tab=card-new', /data-wallet-route="new-card"/),
 check('/wallet?tab=card-spend', /data-wallet-route="card-activity"/),
 check('/chat',/SharkAI/),
 check('/login',/Вход в SharkAI/),
];
const getPort=()=>new Promise((resolve,reject)=>{
 const s=createServer();s.once('error',reject);
 s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});
});
const port=await getPort();
const child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{
 cwd:process.cwd(),env:{...process.env,NODE_ENV:'production'},stdio:['ignore','pipe','pipe']
});
let log='';
for(const stream of [child.stdout,child.stderr])stream.on('data',x=>{log+=(x+'').slice(-1200);log=log.slice(-8000);});
let failures=[];
try {
 let ready=false;
 for(let i=0;i<65;i++){
  if(child.exitCode!==null)break;
  try{const r=await fetch('http://127.0.0.1:'+port+'/',{signal:AbortSignal.timeout(1800)});if(r.ok){ready=true;break;}}catch{}
  await sleep(500);
 }
 if(!ready)throw new Error('Next production HTTP server did not become ready: '+log.slice(-1900));
 for(const {path,regex} of checks){
  const res=await fetch('http://127.0.0.1:'+port+path,{redirect:'manual',signal:AbortSignal.timeout(5000)});
  const html=await res.text();
  const ok=res.status===200&&regex.test(html)&&!html.includes('Application error: a client-side exception');
  if(!ok)failures.push({path,status:res.status,expected:String(regex),snippet:html.slice(0,100)});
 }
 console.log(JSON.stringify({total:checks.length,passed:checks.length-failures.length,failures},null,2));
 if(failures.length)process.exitCode=1;
}catch(e){console.error('Route smoke failure:',String(e));process.exitCode=1;}
finally{
 child.kill('SIGTERM');
 await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(1500)]);
 if(child.exitCode===null)child.kill('SIGKILL');
}
