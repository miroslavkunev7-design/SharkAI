import { isInvestmentRead, readInvestmentWorkflow } from '@/lib/investments/workflow-reads.server';
import { readAuthorizedFinanceStatus } from '@/lib/wallet-investments-grants';
import { walletJson } from '@/lib/wallet-investments-server';

export const runtime = 'nodejs';

export async function POST(request: Request, context: { params: Promise<{ operation: string }> }) {
  const { operation } = await context.params;
  if (!isInvestmentRead(operation)) return walletJson({ status: 'invalid_request' }, 404);
  return readAuthorizedFinanceStatus(request,(profile,account)=>readInvestmentWorkflow(operation,profile,account.id));
}
