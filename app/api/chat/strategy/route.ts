import {createHash} from 'node:crypto';
import {NextRequest, NextResponse} from 'next/server';
import {getSession} from '@/lib/auth';
import {ChatError, loadChat} from '@/lib/chat-history';

const headers = {'Cache-Control':'private, no-store'};

export async function GET(request:NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({error:'Влез, за да обсъдиш стратегията с Shark.'},{status:401, headers});
  const strategy = request.nextUrl.searchParams.get('strategy') ?? 'general';
  if (!/^[\p{L}\p{N}_.:/ -]{1,160}$/u.test(strategy)) return NextResponse.json({error:'Непозната стратегия.'},{status:400, headers});
  const hash = createHash('sha256').update(JSON.stringify(['strategy-chat-v1',user.id,strategy])).digest('hex');
  const thread = [hash.slice(0,8),hash.slice(8,12),'8'+hash.slice(13,16),'8'+hash.slice(17,20),hash.slice(20,32)].join('-');
  try {
    const {messages} = await loadChat(user.id,thread);
    return NextResponse.json({conversationId:thread,messages},{headers});
  } catch (error) {
    if (error instanceof ChatError && error.status === 404) return NextResponse.json({conversationId:thread,messages:[]},{headers});
    throw error;
  }
}
