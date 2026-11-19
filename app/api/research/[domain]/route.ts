import {getSession} from '@/lib/auth';
import {shopCurrency,supportedStoreCurrency} from '@/lib/commerce/owner-input';
import {readInvestmentResearch,readProductResearch} from '@/lib/research/research.server';
import {walletJson} from '@/lib/wallet-investments-server';

export async function GET(request:Request,context:{params:Promise<{domain:string}>}) {
  const owner=await getSession();
  if(!owner) return walletJson({status:'unauthorized'},401);
  const {domain}=await context.params;
  if(domain!=='investments' && domain!=='products') return walletJson({status:'unsupported'},404);
  const params=new URL(request.url).searchParams;
  const currency=params.get('currency')??undefined;
  const horizon=params.get('horizonDays');
  const currencySchema=domain==='products'?supportedStoreCurrency:shopCurrency;
  if((currency!==undefined&&!currencySchema.safeParse(currency).success)
    || (horizon!==null && (domain!=='investments'||!/^\d{1,3}$/.test(horizon)||+horizon<1||+horizon>366))
    || ['currency','horizonDays'].some(k=>params.getAll(k).length>1)) return walletJson({status:'invalid_request'},400);
  try {
    return walletJson(domain==='products'?await readProductResearch(owner.id,{currency})
      :await readInvestmentResearch(owner.id,{currency,horizonDays:horizon===null?undefined:Number(horizon)}));
  } catch {return walletJson({status:'unavailable'},503);}
}
