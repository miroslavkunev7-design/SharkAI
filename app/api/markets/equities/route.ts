import {equityCatalog} from '@/lib/markets/equities.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request:Request) {
  if (new URL(request.url).search) return Response.json({status:'invalid_request'},{status:400});
  const catalog=await equityCatalog();
  return Response.json(catalog,{headers:{'Cache-Control':'public, max-age=0, s-maxage=60'}});
}
