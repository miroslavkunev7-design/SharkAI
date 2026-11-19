import {receiveShopify} from '@/lib/commerce/commerce.server';
export const runtime='nodejs';
export function POST(request:Request){return receiveShopify(request);}
