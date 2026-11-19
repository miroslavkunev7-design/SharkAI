import { createHash } from 'node:crypto';
import { buildBrokerOrderRequest, buildBrokerPoll, parseBrokerAcknowledgement, parseBrokerPoll } from './broker-protocols.server';
import type { BrokerReceiptBinding, BrokerSandboxTransport } from './broker-protocols.server';
import { planBrokerReservation } from './order-boundary.server';
import type { Broker, BrokerOrderIntent, OrderSide, VerifiedBrokerContext } from './order-boundary.server';

type Receipt = {
  account: string;
  requestKey: string;
  broker: Broker;
  providerAccountKey: string;
  instrumentId: number;
  side: OrderSide;
  receiptKey: string;
  providerOrderId: string | null;
  providerCorrelationId: string | null;
  state: string;
  filledUnits: number | null;
  observedAt: string;
};
type Reservation = {
  status: 'reserved' | 'replayed' | 'blocked';
  code?: string;
  state?: string;
  client_reference?: string;
};

export interface BrokerOrderStore {
  reserve(args: {
    user: string; intent: BrokerOrderIntent; providerInstrument: number; maxBuyDebitMinor: number;
    clientReference: string; consentVersion: string; quoteAt: string; quoteExpiresAt: string; snapshotId: string;
  }): Promise<Reservation>;
  claim(account: string, requestKey: string, snapshotId: string): Promise<boolean>;
  record(receipt: Receipt): Promise<'recorded' | 'replayed' | 'invalid' | 'unavailable' | 'conflict'>;
  halt(user: string, account: string): Promise<boolean>;
}

/** Connection must belong to the approved private application boundary. All queries are parameterized. */
export function createBrokerOrderStore(
  query: (sql: string, values: readonly unknown[]) => Promise<{ rows: Array<{ result: unknown }> }>,
): BrokerOrderStore {
  async function single(sql: string, values: readonly unknown[]) {
    const { rows } = await query(sql, values);
    if (rows.length !== 1) throw new Error('Broker order store returned an invalid result');
    return rows[0].result;
  }
  return {
    async reserve(args) {
      const { intent } = args;
      const value = await single(
        'select sharkai_broker.reserve_order($1,$2,$3,$4,$5,$6::bigint,$7,$8,$9::bigint,$10::bigint,$11::bigint,$12,$13,$14::timestamptz,$15::timestamptz) as result',
        [args.user,intent.accountKey,intent.requestKey,args.clientReference,intent.assetId,args.providerInstrument,
          intent.side,intent.kind,intent.units,intent.limitPriceMinor ?? null,args.maxBuyDebitMinor,args.consentVersion,
          args.snapshotId,args.quoteAt,args.quoteExpiresAt],
      );
      if (!value || typeof value !== 'object' || !('status' in value)
        || !['reserved','replayed','blocked'].includes(String(value.status))) throw new Error('Unknown reservation status');
      return value as Reservation;
    },
    async claim(account, requestKey, snapshotId) {
      return await single('select sharkai_broker.claim_submission($1,$2,$3) as result',[account,requestKey,snapshotId]) === true;
    },
    async record(r) {
      const result = await single(
        'select sharkai_broker.record_receipt($1,$2,$3,$4,$5::bigint,$6,$7,$8,$9,$10,$11::bigint,$12::timestamptz) as result',
        [r.account,r.requestKey,r.broker,r.providerAccountKey,r.instrumentId,r.side,r.receiptKey,r.providerOrderId,
          r.providerCorrelationId,r.state,r.filledUnits,r.observedAt],
      );
      if (result === 'recorded' || result === 'replayed' || result === 'unavailable' || result === 'conflict' || result === 'invalid') {
        return result;
      }
      throw new Error('Unknown broker receipt status');
    },
    async halt(user, account) {
      return await single('select sharkai_broker.halt($1,$2) as result',[user,account]) === true;
    },
  };
}

type ExecutionResult = {
  status: string;
  code?: string;
  clientReference?: string;
  providerOrderId?: string;
};

function receiptKey(prefix: string, reference: string) {
  return prefix + ':' + createHash('sha256').update(reference).digest('hex');
}

/** Invoked solely by the isolated acceptance test. There is no live transport, route, credential, or scheduled job. */
export async function exerciseBrokerSubmission(
  intent: BrokerOrderIntent,
  context: VerifiedBrokerContext | null,
  snapshotId: string,
  store: BrokerOrderStore,
  transport: BrokerSandboxTransport,
  clock: () => Date = () => new Date(),
): Promise<ExecutionResult> {
  const plan = planBrokerReservation(intent,context,clock().getTime());
  if (plan.status === 'blocked' || !context) {
    return {status:'blocked',code:plan.status === 'blocked' ? plan.code : 'PROVIDER_UNCONFIGURED'};
  }
  const payload = buildBrokerOrderRequest(intent,plan,context.instrument);
  if (!payload) return {status:'blocked',code:'UNSUPPORTED_ORDER'};
  const { clientReference } = payload;
  const reserved = await store.reserve({
    user:context.authenticatedUserId,intent,providerInstrument:context.instrument.providerInstrumentId,
    maxBuyDebitMinor:plan.maxBuyDebitMinor,clientReference,consentVersion:plan.consentVersion,
    quoteAt:plan.quoteObservedAt,quoteExpiresAt:plan.quoteExpiresAt,snapshotId,
  });
  if (reserved.status === 'blocked') return {status:'blocked',code:reserved.code};
  if (reserved.status === 'replayed') return {status:'replayed',code:reserved.state,clientReference};
  if (reserved.client_reference !== clientReference || !await store.claim(intent.accountKey,intent.requestKey,snapshotId)) {
    return {status:'blocked',code:'RECHECK_REQUIRED',clientReference};
  }
  // Once the durable one-time claim commits, a process error can never safely trigger a second submit.
  let acknowledgement;
  try {
    acknowledgement = parseBrokerAcknowledgement(plan.broker,await transport.execute(payload.request),clientReference);
  } catch {
    acknowledgement = {status:'UNKNOWN',reason:'UNAVAILABLE'} as const;
  }
  const state = acknowledgement.status === 'REJECTED_BY_PROVIDER' ? 'REJECTED' : acknowledgement.status;
  const providerOrderId = 'orderId' in acknowledgement ? acknowledgement.orderId ?? null : null;
  const providerCorrelationId = acknowledgement.status === 'REVIEW_REQUIRED' ? acknowledgement.acknowledgementId : null;
  const receipt = {
    account:intent.accountKey,requestKey:intent.requestKey,receiptKey:receiptKey('submit',clientReference),
    broker:plan.broker,providerAccountKey:plan.providerAccountKey,instrumentId:context.instrument.providerInstrumentId,
    side:intent.side,providerOrderId,providerCorrelationId,state,filledUnits:state === 'ACKNOWLEDGED' ? 0 : null,
    observedAt:clock().toISOString(),
  };
  try {
    const recorded = await store.record(receipt);
    if (recorded === 'recorded' || recorded === 'replayed') {
      return {status:state,clientReference,...(state === 'ACKNOWLEDGED' && providerOrderId ? {providerOrderId} : {})};
    }
  } catch {
    // The ledger still has SUBMITTING and blocks fresh submissions until authoritative reconciliation.
  }
  return {status:'UNKNOWN',code:'RECONCILIATION_REQUIRED',clientReference};
}

export async function exerciseBrokerPoll(
  account: string, requestKey: string, binding: BrokerReceiptBinding,
  store: BrokerOrderStore, transport: BrokerSandboxTransport, clock: () => Date = () => new Date(),
) {
  const request = buildBrokerPoll(binding);
  if (!request) return 'unavailable' as const;
  try {
    const result = parseBrokerPoll(binding,await transport.execute(request));
    if (result.state === 'UNKNOWN' || !result.providerReceiptId) return 'unavailable' as const;
    return await store.record({account,requestKey,receiptKey:receiptKey('poll',result.providerReceiptId),
      broker:binding.broker,providerAccountKey:binding.providerAccountKey,instrumentId:binding.instrumentId,side:binding.side,
      providerOrderId:binding.providerOrderId,providerCorrelationId:null,state:result.state,filledUnits:result.filledUnits,
      observedAt:result.providerObservedAt ?? clock().toISOString()});
  } catch {
    return 'unavailable' as const;
  }
}
