import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth';
import { runAutonomousLoop } from '@/lib/orchestrator';
import { findUploadPath, readUploadAsBase64, mimeFromExt } from '@/lib/uploads';
import path from 'path';
import { waitUntil } from '@vercel/functions';
export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET() {
  const session = await getSession();

  if (!session) {
    return NextResponse.json({ projects: [], user: null });
  }

  const projects = await prisma.project.findMany({
    where: { userId: session.id },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  return NextResponse.json({
    projects,
    user: { name: session.name, plan: session.plan, role: session.role },
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  const body = await req.json();

  let userId = session?.id;

  if (!userId) {
    let guest = await prisma.user.findUnique({ where: { email: 'guest@sharkai.local' } });
    if (!guest) {
      const { hashPassword } = await import('@/lib/auth');
      guest = await prisma.user.create({
        data: {
          email: 'guest@sharkai.local',
          passwordHash: await hashPassword('guest'),
          name: 'Guest',
          plan: 'PRO',
        },
      });
    }
    userId = guest.id;

    const { createToken, setAuthCookie } = await import('@/lib/auth');
    const token = await createToken({
      id: guest.id,
      email: guest.email,
      name: guest.name,
      role: guest.role,
      plan: guest.plan,
    });
    await setAuthCookie(token);
  }

  const featureId = body.featureId as string | undefined;
  const inputType = body.inputType || 'prompt';
  const projectType = body.type || 'website';

  const project = await prisma.project.create({
    data: {
      userId,
      name: body.name || 'Untitled Project',
      description: body.description,
      type: projectType,
      inputType,
      inputData: body.description,
      status: 'ANALYZING',
    },
  });

  let screenshotBase64: string | undefined;
  let screenshotMime: string | undefined;
  let screenshotPath: string | undefined;
  let uploadKind: string | undefined;

  if (body.uploadId) {
    const fp = await findUploadPath(body.uploadId);
    if (fp) {
      screenshotPath = fp;
      const ext = path.extname(fp).slice(1);
      uploadKind = body.uploadKind || (ext === 'pdf' ? 'pdf' : ext === 'mp4' || ext === 'webm' ? 'video' : ext === 'json' ? 'figma' : 'image');
      if (uploadKind === 'image') {
        const data = await readUploadAsBase64(fp);
        screenshotBase64 = data.base64;
        screenshotMime = data.mime;
      } else {
        screenshotMime = mimeFromExt(ext);
      }
    }
  }

  waitUntil(
    runAutonomousLoop(project.id, {
      featureId,
      screenshotBase64,
      screenshotMime,
      screenshotPath,
      uploadKind,
    }).catch(console.error)
  );

  return NextResponse.json({ project });
}
