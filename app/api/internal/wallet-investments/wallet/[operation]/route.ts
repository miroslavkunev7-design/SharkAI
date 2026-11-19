import { readAuthorizedFinanceStatus } from '@/lib/wallet-investments-grants';
import { isWalletRead, readWalletOperation } from '@/lib/investments/wallet-operations.server';
import { walletJson } from '@/lib/wallet-investments-server';

export async function POST(request: Request, { params }: { params: Promise<{ operation: string }> }) {
  const { operation } = await params;
  if (!isWalletRead(operation)) return walletJson({status:'unsupported'},404);
  return readAuthorizedFinanceStatus(request, (profile,account) => readWalletOperation(operation,{userId:account.id,currency:profile.currency}));
}
