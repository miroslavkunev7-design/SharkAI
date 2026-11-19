import {receivePrintful} from '@/lib/commerce/printful-webhook.server';
export const runtime='nodejs';
export function POST(request:Request){return receivePrintful(request);}
