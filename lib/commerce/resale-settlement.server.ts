import {Prisma} from '@prisma/client';
import {z} from 'zod';
import {prisma} from '../db';
import {result} from './commerce.server';
import {supportedStoreCurrency} from './owner-input';

const minor=z.string().regex(/^(0|[1-9]\d*)$/);
const signedMinor=z.string().regex(/^(0|-?[1-9]\d*)$/);
const ownerAmount=z.string().regex(/^(0|[1-9]\d{0,11})$/);
const date=z.string().date();
export const weeklyTarget=z.object({action:z.literal('target'),currency:supportedStoreCurrency,target_minor:ownerAmount}).strict();
export const profitAllocation=z.object({action:z.literal('allocate'),currency:supportedStoreCurrency,
  period_start:date.refine(day=>new Date(day+'T00:00:00Z').getUTCDay()===1),reinvest_minor:ownerAmount}).strict();
const settlement=z.object({
  status:z.enum(['available','unavailable']),currency:supportedStoreCurrency,
  period:z.object({start_date:date,end_date:date,target_minor:minor.nullable(),
    verified_profit_minor:signedMinor.nullable(),verified_days:z.number().int().min(0).max(7)}).nullable(),
  closed:z.array(z.object({start_date:date,end_date:date,target_minor:minor.nullable(),profit_minor:signedMinor,
    allocable_minor:minor,reinvested_minor:minor.nullable(),owner_minor:minor.nullable(),status:z.enum(['awaiting_allocation','allocated','no_profit'])})),
  reinvested_total_minor:minor,owner_reserved_minor:minor,owner_paid_minor:minor,owner_payout_url:z.literal('https://wise.com/home/').nullable(),
});
type Db=Pick<Prisma.TransactionClient,'$queryRaw'>;

export async function readResaleSettlement(userId:string,currency:string,db:Db=prisma) {
  return settlement.parse(await result(db,Prisma.sql`SELECT sharkai_commerce.resale_settlement(${userId},${currency}) r`));
}
export async function setWeeklyTarget(userId:string,input:z.infer<typeof weeklyTarget>,db:Db=prisma) {
  return (await result(db,Prisma.sql`SELECT sharkai_commerce.set_resale_target(${userId},${input.currency},${input.target_minor}::bigint) r`))===true;
}
export async function allocateResaleProfit(userId:string,input:z.infer<typeof profitAllocation>,db:Db=prisma) {
  return (await result(db,Prisma.sql`SELECT sharkai_commerce.allocate_resale_profit(${userId},${input.currency},${input.period_start}::date,${input.reinvest_minor}::bigint) r`))===true;
}
