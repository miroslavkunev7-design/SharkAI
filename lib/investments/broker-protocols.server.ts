import { createHash } from 'node:crypto';
import type { Broker, BrokerInstrument, BrokerOrderIntent, ReservationPlan } from './order-boundary.server';
import { orderFingerprint } from './order-boundary.server';

export interface BrokerRequest {
  broker: Broker;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  query?: Readonly<Record<string,string>>;
  body?: unknown;
}
export interface BrokerHttpResponse { status: number; body: unknown }
export interface BrokerSandboxTransport { execute(request: BrokerRequest): Promise<BrokerHttpResponse> }
export type BrokerAcknowledgement =
  | { status: 'ACKNOWLEDGED'; orderId: string }
  | { status: 'REVIEW_REQUIRED'; acknowledgementId: string }
  | { status: 'REJECTED_BY_PROVIDER'; providerCode: string }
  | { status: 'UNKNOWN'; reason: 'UNAVAILABLE' | 'AMBIGUOUS' | 'MALFORMED'; orderId?: string };
export type BrokerPollState = 'PENDING' | 'WORKING' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCEL_PENDING' | 'CANCELED' | 'UNKNOWN';
export type BrokerPoll = {
  state: BrokerPollState;
  filledUnits: number | null;
  providerReceiptId: string | null;
  providerObservedAt: string | null;
};
export interface BrokerReceiptBinding {
  broker: Broker;
  providerAccountKey: string;
  providerOrderId: string;
  instrumentId: number;
  units: number;
  side: 'BUY' | 'SELL';
  // Required for Saxo audit polling. Verify this key with account ownership before polling.
  verifiedClientKey?: string;
}

const object = (value: unknown): value is Record<string,unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const field = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9_.:=|/-]{1,128}$/.test(value) ? value : null;
const digits = (value: unknown) => typeof value === 'number' && positive(value) ? String(value)
  : typeof value === 'string' && /^[1-9]\d{0,17}$/.test(value) ? value : null;
const units = (value: unknown) => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || !/^\d{1,16}(?:\.0+)?$/.test(value)) return null;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
};
const unknown = (reason: 'UNAVAILABLE' | 'AMBIGUOUS' | 'MALFORMED'): BrokerAcknowledgement => ({status:'UNKNOWN',reason});
const unknownPoll = (): BrokerPoll => ({state:'UNKNOWN',filledUnits:null,providerReceiptId:null,providerObservedAt:null});
const sizeFits = (value: number | null, max: number): value is number => value !== null && value <= max;
const routeKey = (value: string) => field(value) ? encodeURIComponent(value) : null;
const providerAccount = (value: string) => typeof value==='string' && /^[A-Za-z0-9_+=/-]{1,128}$/.test(value);

export function brokerClientReference(broker: Broker, userAccountKey: string, idempotencyKey: string) {
  return 'shark-' + createHash('sha256').update(JSON.stringify([broker,userAccountKey,idempotencyKey]))
    .digest('hex').slice(0,40);
}

// The worker obtains identity, instrument metadata and terms from the private, locked order job.
export function buildBrokerOrderRequest(
  intent: BrokerOrderIntent, plan: Extract<ReservationPlan,{status:'eligible_for_reservation'}>,
  instrument: BrokerInstrument,
): { request: BrokerRequest; clientReference: string } | null {
  if (plan.fingerprint !== orderFingerprint(intent) || !providerAccount(plan.providerAccountKey)
      || instrument.assetId !== intent.assetId || !positive(instrument.providerInstrumentId)
      || !positive(intent.units) || !['STOCK','ETF'].includes(instrument.assetKind)
      || !instrument.supportedOrderKinds.includes(intent.kind)
      || intent.kind !== 'LIMIT' || !positive(intent.limitPriceMinor ?? 0)) return null;
  if (!Number.isInteger(instrument.minorUnitDigits) || instrument.minorUnitDigits < 0 || instrument.minorUnitDigits > 3) return null;
  const price = intent.limitPriceMinor! / (10 ** instrument.minorUnitDigits);
  const clientReference = brokerClientReference(plan.broker,intent.accountKey,intent.requestKey);
  if (plan.broker === 'IBKR') {
    if (!/^[A-Za-z0-9]{1,32}$/.test(plan.providerAccountKey)) return null;
    const order = {acctId:plan.providerAccountKey,conid:instrument.providerInstrumentId,cOID:clientReference,
      orderType:'LMT',side:intent.side,tif:'DAY',quantity:intent.units,price};
    return {clientReference,request:{broker:'IBKR',method:'POST',
      path:'/iserver/account/' + encodeURIComponent(plan.providerAccountKey) + '/orders',body:{orders:[order]}}};
  }
  if (plan.broker !== 'SAXO' || (instrument.assetKind === 'ETF' && !instrument.saxoExtendedAssetsVerified)) return null;
  const order = {AccountKey:plan.providerAccountKey,Uic:instrument.providerInstrumentId,
    AssetType:instrument.assetKind === 'ETF' ? 'Etf' : 'Stock',
    Amount:intent.units,BuySell:intent.side === 'BUY' ? 'Buy' : 'Sell',
    OrderType:'Limit',ManualOrder:false,
    OrderDuration:{DurationType:'DayOrder'},ExternalReference:clientReference,
    OrderPrice:price};
  return {clientReference,request:{broker:'SAXO',method:'POST',path:'/trade/v2/orders',body:order}};
}

export function parseBrokerAcknowledgement(
  broker: Broker, response: BrokerHttpResponse, clientReference: string,
): BrokerAcknowledgement {
  if (response.status >= 500 || response.status === 408 || response.status === 429) return unknown('UNAVAILABLE');
  if (broker === 'IBKR') {
    if (response.status !== 200 || !Array.isArray(response.body) || response.body.length !== 1 || !object(response.body[0])) {
      return unknown('MALFORMED');
    }
    const ticket = response.body[0];
    const warningId = field(ticket.id);
    if (warningId && Array.isArray(ticket.message) && ticket.message.length > 0) {
      return {status:'REVIEW_REQUIRED',acknowledgementId:warningId};
    }
    const orderId = digits(ticket.order_id);
    if (!orderId || typeof ticket.order_status !== 'string'
      || !['ApiPending','PendingSubmit','PreSubmitted','Submitted','Filled'].includes(ticket.order_status) ||
      (ticket.local_order_id !== undefined && ticket.local_order_id !== clientReference)) return unknown('AMBIGUOUS');
    return {status:'ACKNOWLEDGED',orderId};
  }

  if (broker !== 'SAXO' || !object(response.body)) return unknown('MALFORMED');
  const ticket = response.body;
  const orderId = digits(ticket.OrderId);
  const errorCode = object(ticket.ErrorInfo) ? field(ticket.ErrorInfo.ErrorCode) : null;
  if (errorCode === 'TradeNotCompleted' && orderId && [200,202].includes(response.status)
      && (ticket.ExternalReference === undefined || ticket.ExternalReference === clientReference)) {
    return {status:'UNKNOWN',reason:'AMBIGUOUS',orderId};
  }
  if ((orderId && errorCode) || errorCode === 'TradeNotCompleted') return unknown('AMBIGUOUS');
  // Only explicit documented pre-trade rejection codes prove that no order was created.
  const rejectedCodes = new Set(['AmountNotInLotSize','OrderSizeTooSmall','OrderValueToSmall']);
  const invalidModel = response.status === 400 && ticket.ErrorCode === 'InvalidModelState' && object(ticket.ModelState);
  if (!orderId && invalidModel) return {status:'REJECTED_BY_PROVIDER',providerCode:'InvalidModelState'};
  if (!orderId && response.status === 400 && errorCode && rejectedCodes.has(errorCode)) {
    return {status:'REJECTED_BY_PROVIDER',providerCode:errorCode};
  }
  if (response.status !== 200 || !orderId || ticket.ErrorInfo || ticket.ErrorCode ||
      (ticket.ExternalReference !== undefined && ticket.ExternalReference !== clientReference)) return unknown('AMBIGUOUS');
  return {status:'ACKNOWLEDGED',orderId};
}

export function buildBrokerPoll(binding: BrokerReceiptBinding): BrokerRequest | null {
  const orderId = digits(binding.providerOrderId);
  if (!orderId || !providerAccount(binding.providerAccountKey)) return null;
  if (binding.broker === 'IBKR') return {broker:'IBKR',method:'GET',
    path:'/iserver/account/order/status/' + orderId};
  if (binding.broker !== 'SAXO' || !binding.verifiedClientKey || !providerAccount(binding.verifiedClientKey)) return null;
  return {broker:'SAXO',method:'GET',path:'/cs/v1/audit/orderactivities',
    query:{OrderId:orderId,EntryType:'Last',AccountKey:binding.providerAccountKey,
      ClientKey:binding.verifiedClientKey,IncludeSubAccounts:'false'}};
}

export function parseBrokerPoll(binding: BrokerReceiptBinding,response: BrokerHttpResponse): BrokerPoll {
  if (response.status !== 200 || !object(response.body)) return unknownPoll();
  if (binding.broker === 'IBKR') {
    const data = response.body;
    const filled = units(data.cum_fill);
    const side = binding.side === 'BUY' ? 'B' : 'S';
    if (digits(data.order_id) !== binding.providerOrderId || data.account !== binding.providerAccountKey
      || data.conid !== binding.instrumentId || data.side !== side || units(data.total_size) !== binding.units
      || !sizeFits(filled,binding.units)) return unknownPoll();
    const switchStatus = typeof data.order_status === 'string' ? data.order_status : '';
    let state: BrokerPollState = 'UNKNOWN';
    if (switchStatus === 'Filled' && filled === binding.units) state = 'FILLED';
    else if (['Cancelled','Canceled','ApiCancelled'].includes(switchStatus) && filled < binding.units) state = 'CANCELED';
    else if (switchStatus === 'PendingCancel') state = 'CANCEL_PENDING';
    else if (['Submitted','PreSubmitted'].includes(switchStatus) && filled < binding.units) state = filled > 0 ? 'PARTIALLY_FILLED' : 'WORKING';
    else if (['PendingSubmit','ApiPending'].includes(switchStatus) && filled === 0) state = 'PENDING';
    if (state === 'UNKNOWN') return unknownPoll();
    return {state,filledUnits:filled,providerReceiptId:'ibkr:' + binding.providerOrderId + ':' + state + ':' + filled,
      providerObservedAt:null};
  }

  const items = response.body.Data;
  if (binding.broker !== 'SAXO' || !binding.verifiedClientKey || !Array.isArray(items)
      || items.length !== 1 || !object(items[0])) return unknownPoll();
  const item = items[0];
  const logId = digits(item.LogId);
  const observedAt = typeof item.ActivityTime === 'string' && Number.isFinite(Date.parse(item.ActivityTime)) ? item.ActivityTime : null;
  if (digits(item.OrderId) !== binding.providerOrderId || !logId || !observedAt || item.SubStatus !== 'Confirmed'
      || (item.AccountKey !== undefined && item.AccountKey !== binding.providerAccountKey)
      || (item.ClientKey !== undefined && item.ClientKey !== binding.verifiedClientKey)
      || (item.BuySell !== undefined && item.BuySell !== (binding.side==='BUY'?'Buy':'Sell'))
      || (item.Uic !== undefined && item.Uic !== binding.instrumentId)) return unknownPoll();
  const filled = units(item.FilledAmount);
  let state: BrokerPollState = 'UNKNOWN';
  if (item.Status === 'Placed') state = 'WORKING';
  if (item.Status === 'Fill' && sizeFits(filled,binding.units) && filled > 0 && filled < binding.units) state = 'PARTIALLY_FILLED';
  if (item.Status === 'FinalFill' && filled === binding.units) state = 'FILLED';
  if ((item.Status === 'Cancelled' || item.Status === 'Expired') && sizeFits(filled,binding.units) && filled < binding.units) state = 'CANCELED';
  if (state === 'UNKNOWN') return unknownPoll();
  return {state,filledUnits:filled ?? (state === 'WORKING' ? 0 : null),
    providerReceiptId:'saxo:' + logId,providerObservedAt:observedAt};
}

export function buildBrokerCancellation(binding: BrokerReceiptBinding): BrokerRequest | null {
  const orderId = digits(binding.providerOrderId);
  const account = routeKey(binding.providerAccountKey);
  if (!orderId || !account || !['IBKR','SAXO'].includes(binding.broker)) return null;
  return binding.broker === 'IBKR'
    ? {broker:'IBKR',method:'DELETE',path:'/iserver/account/' + account + '/order/' + orderId}
    : {broker:'SAXO',method:'DELETE',path:'/trade/v2/orders/' + orderId,query:{AccountKey:binding.providerAccountKey}};
}
