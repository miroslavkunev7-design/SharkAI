import {SignJWT,jwtVerify} from 'jose';
import {prisma} from '../db';
import {financeServiceAuthorized} from '../wallet-investments-grants';
import {readCommerceAgentAccess} from './commerce.server';
import {readSmallShopBody} from './owner-input';

export const commerceScope='commerce:analytics:read';
const audience='sharkai:n8n:dropshipping:read';
const ttl=120;
const headers={'Cache-Control':'private, no-store'};
function key() {
  const signing=process.env.SHARKAI_WALLET_STATUS_GRANT_SECRET;
  const service=process.env.SHARKAI_WALLET_STATUS_SERVICE_SECRET;
  if(!signing || !service || signing===service || !/^[A-Za-z0-9_-]{32,256}$/.test(signing)) return null;
  return new TextEncoder().encode(signing);
}
export async function issueCommerceGrant(userId:string,telegramBinding?:string,readAccess=readCommerceAgentAccess) {
  const secret=key();
  if(!secret) return null;
  try {
    const access=await readAccess(userId);
    if(!access.enabled || !Number.isSafeInteger(access.revision)) return null;
    return await new SignJWT({scope:commerceScope,revision:access.revision,...(telegramBinding&&{telegram_binding:telegramBinding})})
      .setProtectedHeader({alg:'HS256'}).setSubject(userId).setIssuer('sharkai').setAudience(audience)
      .setIssuedAt().setExpirationTime(ttl+'s').sign(secret);
  } catch {return null;}
}

async function boundChat(binding:string,userId:string) {
  return !!await prisma.telegramBinding.findFirst({where:{id:binding,userId,user:{role:'ADMIN'}},select:{id:true}});
}
export async function authorizedCommerceRead(request:Request,project:(userId:string)=>Promise<object>,readAccess=readCommerceAgentAccess,chatActive=boundChat) {
  const reply=(status:string,code:number)=>Response.json({status},{status:code,headers});
  const secret=key();
  if(!secret) return reply('unavailable',503);
  if(!financeServiceAuthorized(request)) return reply('forbidden',403);
  const token=request.headers.get('X-Shark-Commerce-Grant');
  if(!token || token.length>2048) return reply('forbidden',403);
  const body=await readSmallShopBody(request);
  if(!body || typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==0) return reply('invalid_request',400);
  const signed=await jwtVerify(token,secret,{algorithms:['HS256'],issuer:'sharkai',audience,requiredClaims:['sub','iat','exp'],maxTokenAge:ttl}).catch(()=>null);
  const claim=signed?.payload;
  if(!claim?.sub || claim.scope!==commerceScope || !Number.isSafeInteger(claim.revision)) return reply('forbidden',403);
  const userId=claim.sub;
  const {revision,telegram_binding:binding}=claim;
  async function isCurrent() {
    const access=await readAccess(userId);
    if(!access.enabled || access.revision!==revision) return false;
    if(binding===undefined) return true;
    if(typeof binding!=='string' || binding.length>128) return false;
    return chatActive(binding,userId);
  }
  try {
    if(!await isCurrent()) return reply('forbidden',403);
    const result=await project(userId);
    if(!await isCurrent()) return reply('forbidden',403);
    return Response.json(result,{headers});
  }catch{return reply('unavailable',503);}
}
