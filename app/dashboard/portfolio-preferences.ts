'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { applyPreference, emptyPrefs, symbols, type Prefs, type Rule, type SymbolCode, type PreferenceEdit } from '../../lib/portfolio-preferences';

export type { Prefs, Rule, SymbolCode } from '../../lib/portfolio-preferences';

const api = '/api/portfolio-preferences';
const guestKey = 'sharkai.portfolio.markets.preferences.v1';
const guestEvent = 'sharkai:portfolio-market-preferences';
let guestMemory = emptyPrefs();

function guestPreferences() {
  try {
    const raw = window.localStorage.getItem(guestKey);
    if (!raw) return guestMemory;
    const cached = JSON.parse(raw);
    const clean = emptyPrefs();
    clean.stars = symbols.filter(s => Array.isArray(cached?.stars) && cached.stars.includes(s));
    for (const s of symbols) {
      const r = cached?.alerts?.[s];
      if (r && Number.isFinite(r.target) && r.target > 0 && Number.isSafeInteger(r.createdAt)
          && (r.direction === 'above' || r.direction === 'below')
          && (r.reachedAt === undefined || Number.isSafeInteger(r.reachedAt))) clean.alerts[s] = r;
    }
    return clean;
  } catch { return guestMemory; }
}

type State = { scope: 'loading' | 'unavailable' | 'account' | 'guest'; prefs: Prefs; owner: string | null };
const initial: State = { scope: 'loading', prefs: emptyPrefs(), owner: null };

/** Only the guest list is stored on the device. The signed-in list is scoped by the server session. */
export function usePortfolioPreferences(sync: boolean) {
  const [state, setState] = useState(initial);
  const [notice, setNotice] = useState('');
  const current = useRef(initial);
  const changes = useRef(0);
  const pending = useRef(0);
  const queue = useRef(Promise.resolve());
  const mounted = useRef(false);
  const generation = useRef(0);
  const commit = useCallback((next: State) => { current.current = next; setState(next); }, []);

  const reload = useCallback(async (mask = false) => {
    const sequence = ++generation.current;
    if (pending.current) return;
    if (mask) commit(initial);
    if (!sync) { commit({ scope:'guest', owner:null, prefs:guestPreferences() }); return; }
    const before = changes.current;
    try {
      const response = await fetch(api, { cache:'no-store', credentials:'same-origin' });
      let next: State;
      if (response.status === 401) next = { scope:'guest', owner:null, prefs:guestPreferences() };
      else {
        if (!response.ok) throw Error();
        const result = await response.json();
        next = { scope:'account', owner:result.owner, prefs:result.prefs };
      }
      if (mounted.current && sequence === generation.current && before === changes.current) commit(next);
    } catch {
      if (mounted.current && sequence === generation.current && before === changes.current) {
        commit({ ...initial, scope:'unavailable' });
        setNotice('Настройките за наблюдение са временно недостъпни.');
      }
    }
  }, [sync, commit]);

  useEffect(() => {
    mounted.current = true;
    void reload(true);
    const visible = () => {
      if (document.visibilityState === 'visible') void reload(sync);
      else if (sync && current.current.scope === 'account' && !pending.current) commit(initial);
    };
    const local = () => {
      if (current.current.scope === 'guest') commit({ scope:'guest', owner:null, prefs:guestPreferences() });
    };
    const storage = (event: StorageEvent) => {
      if (event.key === guestKey || event.key === null) { if (!event.newValue) guestMemory = emptyPrefs(); local(); }
    };
    window.addEventListener('storage', storage);
    window.addEventListener(guestEvent, local);
    document.addEventListener('visibilitychange', visible);
    const timer = sync ? window.setInterval(() => { if (!document.hidden) void reload(); }, 60_000) : undefined;
    return () => {
      mounted.current = false;
      ++generation.current;
      window.removeEventListener('storage', storage);
      window.removeEventListener(guestEvent, local);
      document.removeEventListener('visibilitychange', visible);
      window.clearInterval(timer);
    };
  }, [sync, reload, commit]);

  const edit = useCallback((operation: PreferenceEdit) => {
    const previous = current.current;
    if (previous.scope !== 'guest' && previous.scope !== 'account') return;
    setNotice('');
    if (previous.scope === 'guest') {
      guestMemory = applyPreference(guestPreferences(), operation);
      try { window.localStorage.setItem(guestKey, JSON.stringify(guestMemory)); }
      catch { setNotice('Промяната е запазена за текущата сесия.'); }
      commit({ ...previous, prefs:guestMemory });
      window.dispatchEvent(new Event(guestEvent));
      return;
    }
    const change = ++changes.current;
    pending.current++;
    commit({ ...previous, prefs:applyPreference(previous.prefs, operation) });
    queue.current = queue.current.then(async () => {
      try {
        const response = await fetch(api, {
          method:'PATCH', credentials:'same-origin', cache:'no-store', keepalive:true,
          headers:{'Content-Type':'application/json'}, body:JSON.stringify({ owner:previous.owner, edit:operation }),
        });
        if (!response.ok) throw new Error(response.status === 409 ? 'conflict' : 'failed');
        const data = await response.json();
        if (mounted.current && current.current.owner === data.owner && change === changes.current) {
          commit({ scope:'account', owner:data.owner, prefs:data.prefs });
        }
      } catch (error) {
        if (mounted.current) setNotice(error instanceof Error && error.message === 'conflict'
          ? 'Настройката е променена в друга сесия. Провери последната стойност.'
          : 'Промяната не се запази. Опитай отново.');
      } finally {
        pending.current--;
        if (!pending.current && mounted.current) void reload();
      }
    });
  }, [commit, reload]);

  const setStar = useCallback((symbol: SymbolCode, starred: boolean) => edit({kind:'star', symbol, starred}), [edit]);
  const setAlert = useCallback((symbol: SymbolCode, rule: Rule | null) => edit({
    kind:'alert', symbol, rule, previous:current.current.prefs.alerts[symbol]?.createdAt ?? null,
  }), [edit]);
  const markReached = useCallback((symbol: SymbolCode, createdAt: number, at: number) => {
    edit({kind:'reached', symbol, createdAt, at});
  }, [edit]);

  return { scope:state.scope, prefs:state.prefs, ready:state.scope === 'guest' || state.scope === 'account',
    notice, setStar, setAlert, markReached };
}
