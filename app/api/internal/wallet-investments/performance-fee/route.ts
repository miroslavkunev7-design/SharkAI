import {acceptFeeStatement} from '@/lib/investments/performance-fee.server';

export const runtime='nodejs';
export function POST(request:Request) {
  return acceptFeeStatement(request);
}
