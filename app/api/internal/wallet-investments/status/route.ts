import { readWalletStatusGrant } from '@/lib/wallet-investments-grants';

export function POST(request: Request) {
  return readWalletStatusGrant(request);
}
