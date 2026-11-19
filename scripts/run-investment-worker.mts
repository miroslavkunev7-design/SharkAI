import { createHmac, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

// A scheduled installation calls this once per tick. Input order terms originate in the private producer queue.
// Restrict the runner's database role to list_worker_actions and its HMAC key to one worker id.
async function run() {
  if (process.env.SHARKAI_BROKER_EVIDENCE_ENABLED !== 'true') return {processed:0,status:'disabled'};
  const submit=process.env.SHARKAI_BROKER_WORKER_ENABLED==='true';
  const worker=z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).parse(process.env.SHARKAI_ORDER_RUNNER_ID);
  const key=z.string().regex(/^[a-f0-9]{64}$/).parse(process.env.SHARKAI_ORDER_RUNNER_KEY);
  const databaseUrl=z.string().min(1).parse(process.env.SHARKAI_ORDER_RUNNER_DATABASE_URL);
  const db=new PrismaClient({datasourceUrl:databaseUrl,log:[]});
  const states: Record<string,number>={};
  try {
    const raw=await db.$transaction(async tx=>{
      await tx.$executeRaw`SET LOCAL statement_timeout='2s'`;
      return tx.$queryRaw`SELECT job_id,operation,dispatch_nonce FROM sharkai_broker.list_worker_actions(${worker},${submit})`;
    },{maxWait:1000,timeout:3000});
    const actions=z.array(z.object({job_id:z.string().uuid(),operation:z.enum(['submit','poll']),
      dispatch_nonce:z.string().regex(/^[A-Za-z0-9_-]{22,86}$/).nullable()}).strict()).max(16).parse(raw);
    for (const action of actions) {
      const nonce=action.dispatch_nonce ?? randomBytes(24).toString('base64url');
      const data=JSON.stringify({job_id:action.job_id,nonce});
      const timestamp=String(Math.floor(Date.now()/1000));
      const signature=createHmac('sha256',Buffer.from(key,'hex'))
        .update(['shark-order-v1',action.operation,worker,timestamp,data].join('\n')).digest('hex');
      try {
        const response=await fetch('https://mm-auto-green.vercel.app/api/internal/wallet-investments/worker/'+action.operation,
          {method:'POST',headers:{'content-type':'application/json','x-shark-order-worker':worker,
            'x-shark-order-time':timestamp,'x-shark-order-signature':signature},body:data,redirect:'error',signal:AbortSignal.timeout(11_000)});
        const category=String(response.status);
        states[category]=(states[category] ?? 0)+1;
        await response.body?.cancel();
      } catch {
        // A provider may already have accepted the order. Next tick reads authoritative local state.
        states.unknown=(states.unknown ?? 0)+1;
      }
    }
    return {processed:actions.length,outcomes:states};
  } finally { await db.$disconnect(); }
}
try { console.log(JSON.stringify(await run())); }
catch { console.error('Investment worker configuration or queue unavailable.'); process.exitCode=1; }
