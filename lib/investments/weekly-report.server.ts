import type { Broker } from './order-boundary.server';

export type BrokerPerformanceSnapshot = {
  broker: Broker;
  providerAccountKey: string;
  ownerUserId: string;
  ownershipVerified: true;
  complete: true;
  currency: string;
  sourceId: string;
  observedAt: string;
  windowStart: string;
  windowEnd: string;
  realizedBeforeFeesMinor: string;
  unrealizedOpenMinor: string;
  unrealizedCloseMinor: string;
  feesMinor: string;
  depositsMinor: string;
  withdrawalsMinor: string;
};

type WeeklyReport = {
  status: 'available' | 'unavailable';
  period: 'WEEK';
  window_start: string;
  window_end: string;
  source: string | null;
  reported_as_of: string | null;
  currency: string | null;
  realized_minor: string | null;
  realized_after_fees_minor: string | null;
  unrealized_minor: string | null;
  unrealized_closing_minor: string | null;
  net_minor: string | null;
  fees_minor: string | null;
  deposits_minor: string | null;
  withdrawals_minor: string | null;
  method: 'realized_plus_change_in_unrealized_less_fees' | null;
};

const readMinor = (value: string) => /^-?(0|[1-9]\d{0,20})$/.test(value) ? BigInt(value) : null;
const instant = (value: string) => /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;

export function previousBrokerReportWeek(now: Date) {
  const thisMonday = new Date(now.valueOf());
  thisMonday.setUTCHours(0,0,0,0);
  thisMonday.setUTCDate(thisMonday.getUTCDate() - (thisMonday.getUTCDay() + 6) % 7);
  const previousMonday = new Date(thisMonday.valueOf());
  previousMonday.setUTCDate(previousMonday.getUTCDate() - 7);
  return {window_start:previousMonday.toISOString(),window_end:thisMonday.toISOString()};
}

/** The existing account connector supplies a whole-window, owner-bound snapshot with an audited source ID. */
export function verifiedBrokerWeeklyReport(
  account: {userId: string; providerAccountKey: string; broker: Broker; currency: string} | null,
  snapshot: BrokerPerformanceSnapshot | null,
  now = new Date(),
): WeeklyReport {
  const week = previousBrokerReportWeek(now);
  const empty: WeeklyReport = {status:'unavailable',period:'WEEK',...week,source:null,reported_as_of:null,currency:null,
    realized_minor:null,realized_after_fees_minor:null,unrealized_minor:null,unrealized_closing_minor:null,
    net_minor:null,fees_minor:null,deposits_minor:null,withdrawals_minor:null,method:null};
  if (!account || !snapshot?.ownershipVerified || !snapshot.complete || account.userId !== snapshot.ownerUserId
      || account.broker !== snapshot.broker || account.providerAccountKey !== snapshot.providerAccountKey
      || account.currency !== snapshot.currency || !/^[A-Z]{3}$/.test(account.currency)
      || !/^[A-Za-z0-9_.:-]{1,128}$/.test(snapshot.sourceId)
      || snapshot.windowStart !== week.window_start || snapshot.windowEnd !== week.window_end) return empty;
  const observedAt = instant(snapshot.observedAt);
  if (!Number.isFinite(observedAt) || observedAt > now.valueOf() || observedAt < instant(week.window_end)) return empty;
  const realized = readMinor(snapshot.realizedBeforeFeesMinor);
  const opening = readMinor(snapshot.unrealizedOpenMinor);
  const closing = readMinor(snapshot.unrealizedCloseMinor);
  const fee = readMinor(snapshot.feesMinor);
  const deposits = readMinor(snapshot.depositsMinor);
  const withdrawals = readMinor(snapshot.withdrawalsMinor);
  if (realized === null || opening === null || closing === null || fee === null || deposits === null || withdrawals === null
      || fee < 0 || deposits < 0 || withdrawals < 0) return empty;
  const unrealized = closing - opening;
  return {...empty,status:'available',currency:account.currency,reported_as_of:snapshot.observedAt,
    source:snapshot.broker.toLowerCase()+':'+snapshot.sourceId,realized_minor:realized.toString(),unrealized_minor:unrealized.toString(),
    realized_after_fees_minor:(realized-fee).toString(),unrealized_closing_minor:closing.toString(),
    net_minor:(realized+unrealized-fee).toString(),fees_minor:fee.toString(),deposits_minor:deposits.toString(),
    withdrawals_minor:withdrawals.toString(),method:'realized_plus_change_in_unrealized_less_fees'};
}
