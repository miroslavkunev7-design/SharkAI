import {receiveStockEvidence} from '@/lib/commerce/stock-evidence.server';
export const runtime='nodejs';
export function POST(request:Request){return receiveStockEvidence(request);}
