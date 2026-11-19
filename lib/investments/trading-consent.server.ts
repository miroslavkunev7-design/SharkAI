import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { prisma } from '../db';

type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;
const amount = z.string().regex(/^[1-9]\d{0,18}$/);
const fundingSource = 'verified_settled_realized_profit_only';
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const terms = z.object({
  policy_id: z.string().uuid(), provider: z.enum(['ibkr','saxo']), plan: z.enum(['PRO','ULTRA']),
  capital_source: z.literal(fundingSource), protection_policy_id: z.string().uuid(), protection_digest: digest, performance_fee_bps:z.literal(1000),
  currency: z.string().regex(/^[A-Z]{3}$/), capital_minor: amount, max_loss_minor: amount,
  max_positions: z.number().int().positive().max(64), assets: z.array(z.string().min(1).max(128)).min(1).max(64),
  strategy: z.string().min(1).max(100), period: z.enum(['DAY','WEEK','CUSTOM_DAYS','MONTH']),
  days: z.number().int().positive().nullable(), start_date: z.string().regex(/^\d{4}-\d\d-\d\d$/),
  goal_minor: amount.nullable(), goal_bps: z.number().int().positive().nullable(), expires_at: z.string().datetime(),
}).strict();
const signedProtection = z.object({
  capital_source: z.literal(fundingSource), protection_policy_id: z.string().uuid(), protection_digest: digest, performance_fee_bps:z.literal(1000),
});
const preFeeTerms = terms.omit({performance_fee_bps:true});
const legacyTerms = preFeeTerms.omit({capital_source:true, protection_policy_id:true, protection_digest:true});
const storedTerms = z.union([terms,preFeeTerms,legacyTerms]);
const view = z.object({
  active: z.object({ terms:storedTerms, accepted_at: z.string().datetime({offset:true}), valid: z.boolean() }).strict().nullable(),
  offers: z.array(z.object({terms:storedTerms,digest}).strict()).max(5),
}).strict();
const confirm = z.object({ review: z.string().min(50).max(1500), accepted: z.literal(true) }).strict();
export type OwnerOfferTerms = z.infer<typeof terms>;
export type OwnerMandateView = {
  active: {terms:OwnerOfferTerms; accepted_at:string; valid:boolean} | null;
  offers: { terms: OwnerOfferTerms; review: string }[];
};

function signingKey() {
  const secret = process.env.SHARKAI_TRADING_CONSENT_SECRET;
  if (process.env.SHARKAI_TRADING_CONSENT_ENABLED !== 'true' || !secret || !/^[a-zA-Z0-9_-]{43,256}$/.test(secret)
    || [process.env.SHARKAI_WALLET_STATUS_GRANT_SECRET, process.env.SHARKAI_WALLET_STATUS_SERVICE_SECRET,
      process.env.JWT_SECRET].includes(secret)) return null;
  return new TextEncoder().encode(secret);
}
const jwtDetails = { issuer: 'sharkai', audience: 'sharkai:owner:profit-only-trading-review:fee-v1' };

export async function readOwnerMandates(owner: { id: string; plan: string }, db: Db = prisma): Promise<OwnerMandateView> {
  const installed = await db.$queryRaw<{ready:boolean}[]>`
    SELECT to_regprocedure('sharkai_broker.owner_mandates(text,regclass)') IS NOT NULL AS ready`;
  if (installed[0]?.ready !== true) return {active:null,offers:[]};
  const rows = await db.$queryRaw<{result:unknown}[]>`
    SELECT sharkai_broker.owner_mandates(${owner.id},to_regclass('"WalletInvestmentSettings"')) AS result`;
  const data = view.parse(rows[0]?.result);
  const key = signingKey();
  const eligible = data.offers.flatMap(offer => {
    const verified = terms.safeParse(offer.terms);
    return verified.success && verified.data.plan===owner.plan ? [{terms:verified.data,digest:offer.digest}] : [];
  });
  const offers = key ? await Promise.all(eligible.map(async o => ({
    terms:o.terms,
    review:await new SignJWT({policy:o.terms.policy_id,digest:o.digest,plan:o.terms.plan,...signedProtection.parse(o.terms)})
      .setProtectedHeader({alg:'HS256'}).setIssuer(jwtDetails.issuer).setAudience(jwtDetails.audience)
      .setSubject(owner.id).setIssuedAt().setExpirationTime('5m').sign(key),
  }))) : [];
  const current = terms.safeParse(data.active?.terms);
  return {active:data.active && current.success ? {...data.active,terms:current.data} : null,offers};
}

export async function confirmOwnerMandate(owner: { id: string; plan: string }, body: unknown, db: Db = prisma) {
  const key = signingKey();
  const input = confirm.safeParse(body);
  if (!key || !input.success || !['PRO','ULTRA'].includes(owner.plan)) return false;
  const token = await jwtVerify(input.data.review,key,{...jwtDetails,subject:owner.id,algorithms:['HS256'],
    requiredClaims:['exp','iat','sub'],maxTokenAge:'5m'}).catch(()=>null);
  if (!token || token.payload.plan!==owner.plan || !signedProtection.safeParse(token.payload).success || !z.string().uuid().safeParse(token.payload.policy).success
    || !digest.safeParse(token.payload.digest).success) return false;
  const rows = await db.$queryRaw<{accepted:boolean}[]>`
    SELECT sharkai_broker.accept_owner_mandate(${owner.id},${token.payload.policy as string}::uuid,
      ${token.payload.digest as string},to_regclass('"WalletInvestmentSettings"'),${randomUUID()}::uuid) AS accepted`;
  return rows[0]?.accepted===true;
}
