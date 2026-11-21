export const equityListings = [
  {symbol:'AAPL', name:'Apple', venue:'Nasdaq Global Select', mic:'XNGS', currency:'USD', zone:'America/New_York', historyUrl:'https://twelvedata.com/markets/861640/stock/nasdaq/aapl/historical-data'},
  {symbol:'MSFT', name:'Microsoft', venue:'Nasdaq Global Select', mic:'XNGS', currency:'USD', zone:'America/New_York', historyUrl:'https://twelvedata.com/markets/194626/stock/nasdaq/msft/historical-data'},
  {symbol:'VWCE', name:'Vanguard FTSE All-World UCITS ETF (Acc)', venue:'Xetra', mic:'XETR', currency:'EUR', zone:'Europe/Berlin', historyUrl:'https://twelvedata.com/markets/762896/etf/xetr/vwce/historical-data'},
] as const;

export type EquityListing = typeof equityListings[number];
export type EquityClose = {day:string; close:number};
export type EquitySeries =
  | {state:'available'|'historical'; checkedAt:string; points:EquityClose[]}
  | {state:'unlicensed'|'unavailable'};
export type EquityCatalog = {
  status:'available';
  attribution:string;
  series:Record<string,EquitySeries>;
};

export const equityPeriods = [7,30,90] as const;
export function equityWindow(points:EquityClose[], days:typeof equityPeriods[number]) {
  if (!points.length) return [];
  const last = Date.parse(points[points.length-1].day);
  const from = new Date(last-(days-1)*86_400_000).toISOString().slice(0,10);
  return points.filter(point=>point.day>=from);
}
