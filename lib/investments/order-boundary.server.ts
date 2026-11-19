export const investmentTargetPeriods = ['DAY', 'CUSTOM_DAYS', 'WEEK', 'MONTH'] as const;
export type InvestmentTargetPeriod = typeof investmentTargetPeriods[number];
export type Broker = 'IBKR' | 'SAXO';
export type OrderKind = 'LIMIT' | 'MARKET';
export type OrderSide = 'BUY' | 'SELL';

export interface BrokerOrderIntent {
  accountKey: string;
  requestKey: string;
  assetId: string;
  side: OrderSide;
  kind: OrderKind;
  units: number;
  limitPriceMinor?: number;
}

export interface BrokerInstrument {
  assetId: string;
  providerInstrumentId: number;
  currency: string;
  minorUnitDigits: number;
  minimumUnits: number;
  maximumUnits: number;
  quantityStep: number;
  priceTickMinor: number;
  supportedOrderKinds: readonly OrderKind[];
  assetKind: 'STOCK' | 'ETF';
  saxoExtendedAssetsVerified?: boolean;
}

export interface VerifiedTargetMeasurement {
  broker: Broker;
  providerAccountKey: string;
  ownershipVerified: true;
  currency: string;
  windowStart: string;
  windowEnd: string;
  observedAt: string;
  openingEquityMinor: number;
  latestEquityMinor: number;
  externalContributionsMinor: number;
  externalWithdrawalsMinor: number;
  // Verified equities already include booked brokerage fees.
}

export type ReturnTarget = {
  period: InvestmentTargetPeriod;
  windowStart: string;
  windowEnd: string;
} & ({ targetAmountMinor: number; targetReturnBps?: never } | { targetReturnBps: number; targetAmountMinor?: never });

/** WalletInvestmentSettings stores a UTC civil start date and exactly one target measure. */
export function targetFromSettings(settings: {
  targetPeriod: InvestmentTargetPeriod | null;
  targetStartDate: Date | null;
  targetDays: number | null;
  targetAmountMinor: bigint | null;
  targetReturnBps: number | null;
}): ReturnTarget | null {
  const { targetPeriod, targetStartDate, targetDays, targetAmountMinor, targetReturnBps } = settings;
  if (!targetPeriod || !investmentTargetPeriods.includes(targetPeriod) || !targetStartDate
      || !Number.isFinite(targetStartDate.valueOf()) || targetStartDate.toISOString().slice(10) !== 'T00:00:00.000Z'
      || (targetPeriod !== 'CUSTOM_DAYS' && targetDays !== null)
      || (targetPeriod === 'CUSTOM_DAYS' && (targetDays === null || !Number.isInteger(targetDays) || targetDays < 1 || targetDays > 366))
      || (targetAmountMinor === null) === (targetReturnBps === null)) return null;
  const end = new Date(targetStartDate.valueOf());
  if (targetPeriod === 'MONTH') {
    const startDay = end.getUTCDate();
    end.setUTCDate(1);
    end.setUTCMonth(end.getUTCMonth() + 2, 0);
    end.setUTCDate(Math.min(startDay, end.getUTCDate()));
  } else {
    const days = targetPeriod === 'WEEK' ? 7 : targetDays ?? 1;
    end.setUTCDate(end.getUTCDate() + days);
  }
  if (!Number.isFinite(end.valueOf())) return null;
  const window = {period:targetPeriod,windowStart:targetStartDate.toISOString(),windowEnd:end.toISOString()};
  if (targetAmountMinor !== null && positive(Number(targetAmountMinor))) {
    return {...window,targetAmountMinor:Number(targetAmountMinor)};
  }
  return targetReturnBps !== null && positive(targetReturnBps) ? {...window,targetReturnBps} : null;
}

export interface VerifiedBrokerContext {
  accountKey: string;
  authenticatedUserId: string;
  ownerUserId: string;
  broker: Broker;
  providerAccountKey: string;
  configured: boolean;
  contractualApprovalVerified: boolean;
  providerAccountOwnershipVerified: boolean;
  providerAccountActive: boolean;
  liveOrdersEnabled: boolean;
  allowOrderScope: boolean;
  consent: {
    userId: string;
    accountKey: string;
    version: string;
    expiresAt: string;
    revokedAt: string | null;
    authorizedAmountMinor: number;
  } | null;
  entitlement: { allowsOrders: boolean; confirmedCapMinor: number } | null;
  currency: string;
  killSwitch: boolean;
  providerAccessRevoked: boolean;
  reconciliationStatus: 'VERIFIED' | 'MISMATCH' | 'UNKNOWN';
  unresolvedOrderCount: number;
  allowedAssetIds: readonly string[];
  instrument: BrokerInstrument;
  risk: {
    positionsExposureMinor: number;
    pendingBuyExposureMinor: number;
    freeCashMinor: number;
    heldUnits: number;
    pendingSellUnits: number;
    maxDataAgeMs: number;
    snapshotAt: string;
  };
  /** Independent audited figures for this exact broker snapshot; values use account-currency minor units. */
  profitOnly?: {
    snapshotAt: string; broker: Broker; providerAccountKey: string; currency: string; assetId: string;
    proofOfNonRecourseAndSegregation: boolean; fullyPaidLimitedLiabilityAsset: boolean; hardAllInFeeBound: boolean;
    settledGains: number; settledLosses: number; costs: number; distributed: number;
    openCostBasis: number; unrealizedLoss: number; segregatedProfitCash: number;
    performanceFeeHold: number; mandateMaxLossMinor: number;
    lifetimeCloseoutPnl: number; periodCloseoutPnl: number; settledProfitOwnedUnits: number;
  };
  quote: {
    broker: Broker;
    providerAccountKey: string;
    assetId: string;
    currency: string;
    observedAt: string;
    expiresAt: string;
    // Bound to the exact intent after broker instrument and fee validation.
    intentFingerprint: string;
    maxOrderNotionalMinor: number;
    maxFeesMinor: number;
    providerEnforcedDebitCap: boolean;
    providerEnforcedNoShort: boolean;
  } | null;
  target?: ReturnTarget;
  targetMeasurement?: VerifiedTargetMeasurement;
}

export type OrderGateCode =
  | 'PROVIDER_UNCONFIGURED' | 'LIVE_DISABLED' | 'AUTHORIZATION_REQUIRED'
  | 'STOPPED' | 'RECONCILIATION_REQUIRED' | 'UNSUPPORTED_ORDER' | 'MARKET_DATA_UNAVAILABLE'
  | 'CAPITAL_LIMIT' | 'INSUFFICIENT_FUNDS' | 'TARGET_UNVERIFIED' | 'TARGET_REACHED' | 'PROFIT_PROTECTION_REQUIRED';

export type ReservationPlan = {
  status: 'eligible_for_reservation';
  fingerprint: string;
  broker: Broker;
  providerAccountKey: string;
  consentVersion: string;
  quoteObservedAt: string;
  quoteExpiresAt: string;
  maxBuyDebitMinor: number;
  sellUnits: number;
} | { status: 'blocked'; code: OrderGateCode };

const identifier = (value: string) => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/.test(value);
const unsigned = (value: number) => Number.isSafeInteger(value) && value >= 0;
const positive = (value: number) => unsigned(value) && value > 0;
const timestamp = (value: string) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const at = (value: string) => Date.parse(value);
const isFresh = (value: string, now: number, maxAge: number) => timestamp(value) && at(value) <= now && now - at(value) <= maxAge;

export function orderFingerprint(intent: BrokerOrderIntent) {
  return JSON.stringify([intent.accountKey,intent.assetId,intent.side,intent.kind,intent.units,intent.limitPriceMinor ?? null]);
}

export function measuredTargetState(target: ReturnTarget, value: VerifiedTargetMeasurement): 'REACHED' | 'PENDING' | 'UNVERIFIED' {
  if (!value.ownershipVerified || !investmentTargetPeriods.includes(target.period)
      || !timestamp(target.windowStart) || !timestamp(target.windowEnd)
      || !timestamp(value.observedAt) || target.windowStart !== value.windowStart || target.windowEnd !== value.windowEnd
      || at(value.windowStart) >= at(value.windowEnd) || at(value.observedAt) < at(value.windowStart)
      || at(value.observedAt) >= at(value.windowEnd)
      || ![value.openingEquityMinor,value.latestEquityMinor,value.externalContributionsMinor,
        value.externalWithdrawalsMinor].every(unsigned)) return 'UNVERIFIED';

  const change = BigInt(value.latestEquityMinor) - BigInt(value.openingEquityMinor)
    - BigInt(value.externalContributionsMinor) + BigInt(value.externalWithdrawalsMinor);
  if (target.targetAmountMinor !== undefined && target.targetReturnBps === undefined && positive(target.targetAmountMinor)) {
    return change >= BigInt(target.targetAmountMinor) ? 'REACHED' : 'PENDING';
  }
  if (target.targetReturnBps !== undefined && target.targetAmountMinor === undefined
      && positive(target.targetReturnBps) && positive(value.openingEquityMinor)) {
    return change * BigInt(10000) >= BigInt(value.openingEquityMinor) * BigInt(target.targetReturnBps) ? 'REACHED' : 'PENDING';
  }
  return 'UNVERIFIED';
}

export function planBrokerReservation(
  intent: BrokerOrderIntent, state: VerifiedBrokerContext | null, now: number,
): ReservationPlan {
  const block = (code: OrderGateCode): ReservationPlan => ({ status: 'blocked', code });
  if (!state?.configured || !state.contractualApprovalVerified) return block('PROVIDER_UNCONFIGURED');
  if (!state.liveOrdersEnabled) return block('LIVE_DISABLED');
  if (state.killSwitch || state.providerAccessRevoked) return block('STOPPED');

  const { consent, entitlement, instrument, risk, quote } = state;
  if (!Number.isFinite(now) || !identifier(intent.accountKey) || !identifier(intent.requestKey)
      || state.accountKey !== intent.accountKey || !state.providerAccountOwnershipVerified || !state.providerAccountActive
      || !state.allowOrderScope || state.authenticatedUserId !== state.ownerUserId || !consent
      || consent.accountKey !== intent.accountKey || consent.userId !== state.authenticatedUserId
      || !identifier(consent.version) || consent.revokedAt !== null || !timestamp(consent.expiresAt)
      || at(consent.expiresAt) <= now || !positive(consent.authorizedAmountMinor)
      || !entitlement?.allowsOrders || !positive(entitlement.confirmedCapMinor)) return block('AUTHORIZATION_REQUIRED');

  if (state.reconciliationStatus !== 'VERIFIED' || state.unresolvedOrderCount !== 0) return block('RECONCILIATION_REQUIRED');
  if (!identifier(intent.assetId) || !['BUY','SELL'].includes(intent.side)
      || intent.kind!=='LIMIT' || !state.allowedAssetIds.includes(intent.assetId)
      || instrument.assetId !== intent.assetId || instrument.currency !== state.currency
      || !instrument.supportedOrderKinds.includes(intent.kind) || !positive(intent.units)
      || !positive(instrument.minimumUnits) || !positive(instrument.maximumUnits) || !positive(instrument.quantityStep)
      || intent.units < instrument.minimumUnits || intent.units > instrument.maximumUnits || intent.units % instrument.quantityStep !== 0
      || !positive(intent.limitPriceMinor ?? 0) || !positive(instrument.priceTickMinor)
      || (intent.limitPriceMinor ?? 0) % instrument.priceTickMinor !== 0) return block('UNSUPPORTED_ORDER');

  const fingerprint = orderFingerprint(intent);
  if (!positive(risk.maxDataAgeMs) || !isFresh(risk.snapshotAt,now,risk.maxDataAgeMs)
      || !quote || quote.broker !== state.broker || quote.providerAccountKey !== state.providerAccountKey
      || quote.assetId !== intent.assetId || quote.currency !== state.currency || quote.intentFingerprint !== fingerprint
      || !isFresh(quote.observedAt,now,risk.maxDataAgeMs) || !timestamp(quote.expiresAt) || at(quote.expiresAt) <= now
      || !positive(quote.maxOrderNotionalMinor) || !unsigned(quote.maxFeesMinor)) return block('MARKET_DATA_UNAVAILABLE');

  const isBuy = intent.side === 'BUY';
  if (isBuy && state.target) {
    const measurement = state.targetMeasurement;
    if (!measurement || measurement.broker !== state.broker || measurement.providerAccountKey !== state.providerAccountKey
        || measurement.currency !== state.currency
        || !isFresh(measurement.observedAt,now,risk.maxDataAgeMs)) return block('TARGET_UNVERIFIED');
    const progress = measuredTargetState(state.target,measurement);
    if (progress === 'UNVERIFIED') return block('TARGET_UNVERIFIED');
    if (progress === 'REACHED') return block('TARGET_REACHED');
  }

  if (![risk.positionsExposureMinor,risk.pendingBuyExposureMinor,risk.freeCashMinor,risk.heldUnits,risk.pendingSellUnits].every(unsigned)
      || risk.pendingSellUnits > risk.heldUnits) return block('RECONCILIATION_REQUIRED');
  if (!isBuy && (!quote.providerEnforcedNoShort || intent.units > risk.heldUnits - risk.pendingSellUnits)) return block('CAPITAL_LIMIT');

  const cost = BigInt(quote.maxOrderNotionalMinor) + BigInt(quote.maxFeesMinor);
  const proof=state.profitOnly;
  if (!proof || !proof.proofOfNonRecourseAndSegregation || !proof.fullyPaidLimitedLiabilityAsset || !proof.hardAllInFeeBound
      || proof.assetId!==intent.assetId || proof.broker!==state.broker || proof.providerAccountKey!==state.providerAccountKey
      || proof.currency!==state.currency || at(proof.snapshotAt)!==at(risk.snapshotAt)
      || ![proof.settledGains,proof.settledLosses,proof.costs,proof.distributed,proof.openCostBasis,proof.unrealizedLoss,
        proof.segregatedProfitCash,proof.settledProfitOwnedUnits,proof.performanceFeeHold].every(unsigned)
      || !positive(proof.mandateMaxLossMinor)
      || ![proof.lifetimeCloseoutPnl,proof.periodCloseoutPnl].every(Number.isSafeInteger)) return block('PROFIT_PROTECTION_REQUIRED');
  const realized=BigInt(proof.settledGains)-BigInt(proof.settledLosses)-BigInt(proof.costs)-BigInt(proof.distributed);
  const atRisk=BigInt(Math.max(proof.openCostBasis,risk.positionsExposureMinor))+BigInt(risk.pendingBuyExposureMinor);
  const reserve=atRisk+BigInt(proof.unrealizedLoss)+BigInt(proof.performanceFeeHold);
  const cash=BigInt(Math.min(proof.segregatedProfitCash,risk.freeCashMinor))-BigInt(risk.pendingBuyExposureMinor)-BigInt(proof.performanceFeeHold);
  if (isBuy ? (proof.lifetimeCloseoutPnl<0 || proof.periodCloseoutPnl<0 || cost>realized-reserve || cost>cash || atRisk+cost>BigInt(proof.mandateMaxLossMinor))
    : (intent.units>proof.settledProfitOwnedUnits-risk.pendingSellUnits || BigInt(quote.maxFeesMinor)>cash)) {
    return block('PROFIT_PROTECTION_REQUIRED');
  }
  if (isBuy) {
    if (intent.kind === 'LIMIT' && BigInt(quote.maxOrderNotionalMinor) < BigInt(intent.units) * BigInt(intent.limitPriceMinor ?? 0)) {
      return block('MARKET_DATA_UNAVAILABLE');
    }
    const cap = BigInt(Math.min(consent.authorizedAmountMinor,entitlement.confirmedCapMinor));
    if (BigInt(risk.positionsExposureMinor) + BigInt(risk.pendingBuyExposureMinor) + cost > cap) return block('CAPITAL_LIMIT');
    if (cost > BigInt(risk.freeCashMinor)) return block('INSUFFICIENT_FUNDS');
  }
  return {
    status: 'eligible_for_reservation', fingerprint, broker: state.broker, providerAccountKey: state.providerAccountKey,
    consentVersion: consent.version, quoteObservedAt: quote.observedAt, quoteExpiresAt: quote.expiresAt,
    maxBuyDebitMinor: isBuy ? Number(cost) : 0, sellUnits: isBuy ? 0 : intent.units,
  };
}
