import { handleBrokerWorker } from '@/lib/investments/order-worker.server';

export const runtime = 'nodejs';

export async function POST(request: Request, context: {params:Promise<{operation:string}>}) {
  return handleBrokerWorker(request,(await context.params).operation);
}
