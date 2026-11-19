import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { telegramServiceSecret } from '@/lib/telegram-contract';
import { createTelegramPairing, revokeTelegramPairing, telegramJson, telegramPairingStatus } from '@/lib/telegram-server';

import { requestHasSameOrigin } from '@/lib/request-origin';

export async function GET() {
  try {
    const session = await getSession();
    if (session?.role !== 'ADMIN') return telegramJson({ status: 'forbidden' }, 403);
    return telegramJson({ linked: !!await telegramPairingStatus(session.id), configured: !!telegramServiceSecret() });
  } catch {
    return telegramJson({ status: 'unavailable' }, 503);
  }
}

export async function POST(request: NextRequest) {
  if (!requestHasSameOrigin(request)) return telegramJson({ status: 'forbidden' }, 403);
  try {
    const session = await getSession();
    if (session?.role !== 'ADMIN') return telegramJson({ status: 'forbidden' }, 403);
    if (!telegramServiceSecret()) return telegramJson({ status: 'unavailable' }, 503);
    const pairing = await createTelegramPairing(session.id);
    return pairing ? telegramJson(pairing, 201) : telegramJson({ status: 'already_linked' }, 409);
  } catch {
    return telegramJson({ status: 'unavailable' }, 503);
  }
}

export async function DELETE(request: NextRequest) {
  if (!requestHasSameOrigin(request)) return telegramJson({ status: 'forbidden' }, 403);
  try {
    const session = await getSession();
    if (session?.role !== 'ADMIN') return telegramJson({ status: 'forbidden' }, 403);
    await revokeTelegramPairing(session.id);
    return telegramJson({ linked: false });
  } catch {
    return telegramJson({ status: 'unavailable' }, 503);
  }
}
