import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { requestHasSameOrigin } from '@/lib/request-origin';
import { sendWalletAgentRequest } from '@/lib/wallet-investments-agent';
import { getWalletSettings, walletJson } from '@/lib/wallet-investments-server';

const messageBody = z.object({ message: z.string().trim().min(1).max(16_000) }).strict();
const unavailable = () => walletJson({ status: 'unavailable' }, 503);

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (!requestHasSameOrigin(request)) return walletJson({ status: 'forbidden' }, 403);
  try {
    const session = await getSession();
    if (!session) return walletJson({ status: 'unauthorized' }, 401);
    const body = messageBody.safeParse(await request.json().catch(() => null));
    if (!body.success) return walletJson({ status: 'invalid_request' }, 400);
    const profile = await getWalletSettings(session.id);
    const reply = await sendWalletAgentRequest(
      session.id, body.data.message, profile?.aiAccess === 'ANALYSIS_ONLY' ? profile.accessRevision : null,
    );
    return reply ? walletJson(reply) : unavailable();
  } catch {
    return unavailable();
  }
}
