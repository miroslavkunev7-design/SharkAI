import {authorizedCommerceRead} from '@/lib/commerce/agent-access.server';
import {readProductResearch,readInvestmentResearch} from '@/lib/research/research.server';
import {readAuthorizedFinanceStatus} from '@/lib/wallet-investments-grants';
import {readPeriod,walletJson} from '@/lib/wallet-investments-server';

export async function POST(request:Request,context:{params:Promise<{domain:string}>}) {
  const {domain}=await context.params;
  if(domain==='products') return authorizedCommerceRead(request,userId=>readProductResearch(userId));
  if(domain==='investments') return readAuthorizedFinanceStatus(request,(profile,owner)=>readInvestmentResearch(owner.id,{
    currency:profile.currency??undefined,horizonDays:readPeriod(profile)?.horizon_days??undefined,
  }));
  return walletJson({status:'unsupported'},404);
}
