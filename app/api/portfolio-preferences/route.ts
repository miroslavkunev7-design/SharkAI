import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { requestHasSameOrigin } from '@/lib/request-origin';
import { emptyPrefs, type Rule, type SymbolCode } from '@/lib/portfolio-preferences';

const symbol = z.enum(['BTC', 'ETH', 'SOL']);
const stamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const rule = z.object({
  createdAt: stamp, direction: z.enum(['above', 'below']), target: z.number().finite().positive().max(1e15),
}).strict();
const mutation = z.object({
  owner: z.string().min(1).max(255),
  edit: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('star'), symbol, starred: z.boolean() }).strict(),
    z.object({ kind: z.literal('alert'), symbol, rule: rule.nullable(), previous: stamp.nullable() }).strict(),
    z.object({ kind: z.literal('reached'), symbol, createdAt: stamp, at: stamp }).strict(),
  ]),
}).strict();

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
}

async function preferences(owner: string) {
  const rows = await prisma.$queryRaw<{symbol: SymbolCode; starred: boolean; alert: Rule | null}[]>`
    SELECT symbol, starred, alert FROM sharkai_portfolio.market_preference WHERE owner_id = ${owner} ORDER BY symbol
  `;
  const prefs = emptyPrefs();
  for (const row of rows) {
    if (row.starred) prefs.stars.push(row.symbol);
    if (row.alert) prefs.alerts[row.symbol] = row.alert;
  }
  return { owner, prefs };
}

export async function GET() {
  try {
    const session = await getSession();
    return session ? json(await preferences(session.id)) : json({ status: 'guest' }, 401);
  } catch { return json({ status: 'unavailable' }, 503); }
}

export async function PATCH(request: NextRequest) {
  if (!requestHasSameOrigin(request)) return json({ status: 'forbidden' }, 403);
  try {
    const session = await getSession();
    if (!session) return json({ status: 'guest' }, 401);
    const parsed = mutation.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ status: 'invalid' }, 400);
    const { owner, edit } = parsed.data;
    // Stops a pending tab edit if another account has signed in since its GET.
    if (owner !== session.id) return json({ status: 'account_changed' }, 409);
    if (edit.kind === 'star') {
      await prisma.$executeRaw`INSERT INTO sharkai_portfolio.market_preference (owner_id, symbol, starred)
        VALUES (${session.id}, ${edit.symbol}, ${edit.starred}) ON CONFLICT (owner_id, symbol)
        DO UPDATE SET starred = excluded.starred`;
    } else if (edit.kind === 'alert') {
      if (edit.rule && edit.rule.createdAt > Date.now() + 300_000) return json({ status: 'invalid' }, 400);
      const alert = edit.rule ? JSON.stringify(edit.rule) : null;
      const previous = edit.previous?.toString() ?? null;
      const changed = edit.previous === null && edit.rule
        ? await prisma.$executeRaw`INSERT INTO sharkai_portfolio.market_preference AS p (owner_id, symbol, alert)
          VALUES (${session.id}, ${edit.symbol}, ${alert}::jsonb) ON CONFLICT (owner_id, symbol)
          DO UPDATE SET alert = excluded.alert WHERE p.alert IS NULL`
        : await prisma.$executeRaw`UPDATE sharkai_portfolio.market_preference SET alert = ${alert}::jsonb
          WHERE owner_id = ${session.id} AND symbol = ${edit.symbol}
            AND (alert->>'createdAt') IS NOT DISTINCT FROM ${previous}::text`;
      if (!changed) return json({ status: 'conflict' }, 409);
    } else {
      if (edit.at < edit.createdAt || edit.at > Date.now() + 300_000) return json({ status: 'invalid' }, 400);
      await prisma.$executeRaw`UPDATE sharkai_portfolio.market_preference
        SET alert = jsonb_set(alert, '{reachedAt}', to_jsonb(${String(edit.at)}::bigint))
        WHERE owner_id = ${session.id} AND symbol = ${edit.symbol}
          AND alert->>'createdAt' = ${String(edit.createdAt)} AND NOT (alert ? 'reachedAt')`;
    }
    return json(await preferences(session.id));
  } catch { return json({ status: 'unavailable' }, 503); }
}
