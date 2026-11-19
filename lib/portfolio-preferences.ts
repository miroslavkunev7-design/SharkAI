export type SymbolCode = 'BTC' | 'ETH' | 'SOL';
export type Rule = { target: number; direction: 'above' | 'below'; createdAt: number; reachedAt?: number };
export type Prefs = { stars: SymbolCode[]; alerts: Partial<Record<SymbolCode, Rule>> };
export type PreferenceEdit =
  | { kind: 'star'; symbol: SymbolCode; starred: boolean }
  | { kind: 'alert'; symbol: SymbolCode; rule: Rule | null; previous: number | null }
  | { kind: 'reached'; symbol: SymbolCode; createdAt: number; at: number };
export const emptyPrefs = (): Prefs => ({ stars: [], alerts: {} });
export const symbols: SymbolCode[] = ['BTC', 'ETH', 'SOL'];

export function applyPreference(prefs: Prefs, edit: PreferenceEdit): Prefs {
  const result = { stars: [...prefs.stars], alerts: { ...prefs.alerts } };
  const old = result.alerts[edit.symbol];
  if (edit.kind === 'star') {
    result.stars = symbols.filter(s => s === edit.symbol ? edit.starred : prefs.stars.includes(s));
  } else if (edit.kind === 'alert' && (old?.createdAt ?? null) === edit.previous) {
    if (edit.rule) result.alerts[edit.symbol] = edit.rule;
    else delete result.alerts[edit.symbol];
  } else if (edit.kind === 'reached' && old?.createdAt === edit.createdAt && !old.reachedAt) {
    result.alerts[edit.symbol] = { ...old, reachedAt: edit.at };
  }
  return result;
}
