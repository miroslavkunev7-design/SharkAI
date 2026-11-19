import {receiveCommerceEvidence} from '@/lib/commerce/evidence.server';
export const runtime='nodejs';
export function POST(request:Request){return receiveCommerceEvidence(request);}
