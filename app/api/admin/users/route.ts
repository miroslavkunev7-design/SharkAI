import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth';
import type { Plan, Role } from '@prisma/client';

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (session?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Само за админ' }, { status: 403 });
  }

  const { userId, plan, role } = await req.json();
  if (!userId) {
    return NextResponse.json({ error: 'userId е задължителен' }, { status: 400 });
  }

  const data: { plan?: Plan; role?: Role } = {};
  if (plan && ['FREE', 'PRO', 'ULTRA'].includes(plan)) data.plan = plan;
  if (role && ['USER', 'ADMIN'].includes(role)) data.role = role;

  if (!Object.keys(data).length) {
    return NextResponse.json({ error: 'Няма поле за обновяване' }, { status: 400 });
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data,
    select: { id: true, email: true, plan: true, role: true },
  });

  return NextResponse.json({ ok: true, user });
}
