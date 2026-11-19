export const cryptoRanges = {
  '1d': {label:'24 часа', minutes:5, days:1},
  '7d': {label:'7 дни', minutes:30, days:7},
  '30d': {label:'30 дни', minutes:240, days:30},
  '90d': {label:'90 дни', minutes:240, days:90},
  '1y': {label:'1 година', minutes:1440, days:365},
} as const;
export type CryptoRange = keyof typeof cryptoRanges;
export type MarketPair = {id:string; base:string; quote:string; name:string; market_status:string};
export type MarketQuote = {price:string; volume_24h:string; trades_24h:number; day_change_pct:number|null};
export type CryptoRow = MarketPair & {ticker:MarketQuote|null};
export type CryptoCatalog = {source:'Kraken Spot'; status:'available'; checked_at:string|null; total:number; matched:number; page:number; pages:number; rows:CryptoRow[]};
export type MarketCandle = {start:number; close:number; high:number; low:number; volume:number; trades:number};
export type CryptoChart = {source:'Kraken Spot'; status:'available'; pair:MarketPair; range:CryptoRange;
  checked_at:string; ticker_at:string|null; ticker:MarketQuote|null; interval_minutes:number; candles:MarketCandle[]};

export function isCryptoRange(value:string):value is CryptoRange {
  return Object.hasOwn(cryptoRanges,value);
}

// Kraken's spot API uses XBT and XDG for Bitcoin and Dogecoin.
export function displayCryptoCode(symbol:string) {
  return symbol === 'XBT' ? 'BTC' : symbol === 'XDG' ? 'DOGE' : symbol;
}

export function cryptoUnit(value:number) {
  return new Intl.NumberFormat('bg-BG', {maximumSignificantDigits:8}).format(value);
}
