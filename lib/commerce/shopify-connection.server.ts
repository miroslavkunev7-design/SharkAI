import {z} from 'zod';
import {prisma} from '../db';
import {configuredShops,shopifyQuery,ShopifyUnauthorized} from './providers.server';

type Status='connected'|'not_configured'|'unauthorized'|'identity_mismatch'|'unavailable';
type Connection={status:Status;shop:string|null;orders_last_60_days:'none'|'present'|'unverified';
  order_access:'ready'|'missing_scope'|'unverified';checked_at:string};

async function approvedShop(userId:string){
  const rows=await prisma.$queryRaw<{shop:string|null}[]>`SELECT sharkai_commerce.current_store(${userId},NULL::text)->>'shop' AS shop`;
  return rows[0]?.shop??null;
}
const identity='query SharkShopIdentity { shop { myshopifyDomain } currentAppInstallation { accessScopes { handle } } }';
const presence='query SharkVisibleOrders($filter:String!) { orders(first:1,query:$filter){nodes{__typename}} }';

export async function readShopifyConnection(userId:string,env:NodeJS.ProcessEnv=process.env,send:typeof fetch=fetch,legacyShop=approvedShop):Promise<Connection>{
  const state:Connection={status:'not_configured',shop:null,orders_last_60_days:'unverified',order_access:'unverified',checked_at:new Date().toISOString()};
  try{
    const configs=configuredShops(env);
    let own=configs.find(k=>k.owner_id===userId);
    if(!own&&configs.some(k=>!k.owner_id)){
      const previouslyApproved=await legacyShop(userId);
      own=configs.find(k=>!k.owner_id&&k.shop===previouslyApproved);
    }
    if(!own)return state;
    const info=await shopifyQuery(own,identity,{},send);
    const returned=info?.data?.shop?.myshopifyDomain;
    const errors=z.array(z.object({path:z.array(z.union([z.string(),z.number()])).optional()})).optional().parse(info.errors)??[];
    if(typeof returned!=='string'||errors.some(e=>e.path?.[0]!=='currentAppInstallation'))return {...state,status:'unavailable'};
    if(returned!==own.shop)return {...state,status:'identity_mismatch'};
    state.status='connected';
    state.shop=own.shop;
    const scopes=z.array(z.object({handle:z.string()})).max(1024).safeParse(info?.data?.currentAppInstallation?.accessScopes);
    if(!scopes.success||errors.length)return state;
    const granted=new Set(scopes.data.map(s=>s.handle));
    state.order_access=granted.has('read_orders')&&granted.has('read_products')?'ready':'missing_scope';
    if(!granted.has('read_orders'))return state;
    try{
      const since=new Date(Date.parse(state.checked_at)-60*86400000).toISOString();
      const data=await shopifyQuery(own,presence,{filter:"created_at:>='"+since+"'"},send);
      const nodes=z.array(z.object({__typename:z.literal('Order')})).max(1).safeParse(data?.data?.orders?.nodes);
      const warnings=z.array(z.object({warnings:z.array(z.unknown()).optional()})).optional().safeParse(data?.extensions?.search);
      if(!data.errors?.length&&nodes.success&&warnings.success&&!warnings.data?.some(v=>v.warnings?.length)){
        state.orders_last_60_days=nodes.data.length?'present':'none';
      }
    }catch{/* A failed order read leaves the separately verified identity intact. */}
    return state;
  }catch(error){return {...state,status:error instanceof ShopifyUnauthorized?'unauthorized':'unavailable'};}
}
