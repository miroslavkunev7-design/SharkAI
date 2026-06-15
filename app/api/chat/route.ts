import { NextRequest, NextResponse } from 'next/server';
import { getSession, hashPassword, createToken, setAuthCookie } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { localChatReply } from '@/lib/ai/local-chat';
import { analyzeImageFile } from '@/lib/vision-local';
import { findUploadPath } from '@/lib/uploads';
import type { ResponseTier } from '@/lib/ai/supreme-conversation';

export const runtime = 'nodejs';
export const maxDuration = 30;

async function ensureUser() {
  const session = await getSession();
  if (session) return session;

  let guest = await prisma.user.findUnique({ where: { email: 'guest@sharkai.local' } });
  if (!guest) {
    guest = await prisma.user.create({
      data: {
        email: 'guest@sharkai.local',
        passwordHash: await hashPassword('guest'),
        name: 'Guest',
        plan: 'PRO',
      },
    });
  }

  const token = await createToken({
    id: guest.id,
    email: guest.email,
    name: guest.name,
    role: guest.role,
    plan: guest.plan,
  });
  await setAuthCookie(token);
  return guest;
}

function needsImageAnalysis(text: string, uploadId?: string, tier?: ResponseTier) {
  if (!uploadId) return false;
  if (tier === 'deep') return true;
  return /снимк|виждаш|опиши|код|build|генерирай|направи|zip|давай|screenshot/i.test(text);
}

async function persistChat(
  userText: string,
  uploadId: string | undefined,
  content: string,
  tier: ResponseTier
) {
  try {
    const user = await ensureUser();
    const imageProfile = needsImageAnalysis(userText, uploadId, tier)
      ? await (async () => {
          const fp = uploadId ? await findUploadPath(uploadId) : null;
          if (!fp) return null;
          try { return await analyzeImageFile(fp); } catch { return null; }
        })()
      : null;

    if (imageProfile && tier === 'deep') {
      // optional future: store analysis metadata
    }

    await prisma.chatMessage.create({
      data: {
        userId: user.id,
        role: 'user',
        content: userText || '[screenshot]',
        imagePath: uploadId || null,
      },
    });
    await prisma.chatMessage.create({
      data: { userId: user.id, role: 'assistant', content },
    });
  } catch (err) {
    console.error('chat persist:', err);
  }
}

export async function POST(req: NextRequest) {
  const started = Date.now();
  const body = await req.json();
  const history: Array<{ role: string; content: string }> = body.history || [];
  const userText: string = body.message || '';
  const uploadId: string | undefined = body.uploadId;

  if (!userText.trim() && !uploadId) {
    return NextResponse.json({ error: 'Empty message' }, { status: 400 });
  }

  const result = localChatReply(userText, { history }, !!uploadId, null);

  void persistChat(userText, uploadId, result.content, result.tier);

  return NextResponse.json({
    role: 'assistant',
    content: result.content,
    mode: 'local',
    tier: result.tier,
    suggestBuild: result.suggestBuild,
    featureId: result.featureId,
    buildPrompt: result.buildPrompt,
    latencyMs: Date.now() - started,
  });
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ messages: [] });

  const messages = await prisma.chatMessage.findMany({
    where: { userId: session.id },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  return NextResponse.json({ messages });
}
