import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { requestHasSameOrigin } from '@/lib/request-origin';
import { confirmOwnerMandate, readOwnerMandates } from '@/lib/investments/trading-consent.server';
import { walletJson } from '@/lib/wallet-investments-server';

export async function GET() {
  try {
    const owner = await getSession();
    if (!owner) return walletJson({status:'unauthorized'},401);
    return walletJson(await readOwnerMandates(owner));
  } catch {
    return walletJson({status:'unavailable'},503);
  }
}

export async function POST(request: NextRequest) {
  if (!requestHasSameOrigin(request)) return walletJson({status:'forbidden'},403);
  try {
    const owner = await getSession();
    if (!owner) return walletJson({status:'unauthorized'},401);
    if (!request.headers.get('content-type')?.startsWith('application/json')) return walletJson({status:'invalid_request'},400);
    const reader = request.body?.getReader();
    if (!reader) return walletJson({status:'invalid_request'},400);
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    let interrupted = false;
    const deadline = setTimeout(()=>{ interrupted=true; void reader.cancel().catch(()=>{}); },2000);
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes+=part.value.byteLength;
        if (bytes>2048) { await reader.cancel(); return walletJson({status:'invalid_request'},400); }
        chunks.push(part.value);
      }
    } finally {
      clearTimeout(deadline);
      reader.releaseLock();
    }
    if (interrupted) return walletJson({status:'invalid_request'},400);
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!await confirmOwnerMandate(owner,body)) return walletJson({status:'review_required'},409);
    return walletJson({status:'accepted'});
  } catch (e) {
    return e instanceof SyntaxError ? walletJson({status:'invalid_request'},400) : walletJson({status:'unavailable'},503);
  }
}
