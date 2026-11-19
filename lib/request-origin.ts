import type { NextRequest } from 'next/server';

export function requestHasSameOrigin(request: NextRequest) {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  const protocol = request.nextUrl.protocol;
  if (!origin || !host || !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::[0-9]+)?$/i.test(host) || !['http:', 'https:'].includes(protocol)) return false;

  try {
    return origin === new URL(protocol + '//' + host).origin;
  } catch {
    return false;
  }
}
