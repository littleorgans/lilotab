// Recent tab model: one use sequence per tab and window; projects the checkpoint envelope (06-data 2).
// Every operation is pure and returns its input unchanged when nothing changed.

import { isCount, isRecord, type Fields } from '../guards.ts';
import type { LiveFacts, OpId, TabId, TabRef, WindowId } from '../types.ts';

export type UseNumber = number; // from Recents.seq; 0 = never seen active (tabs) or never focused (windows)

export interface TabEntry {
  windowId: WindowId;
  used: UseNumber;
}
export interface WindowEntry {
  focused: UseNumber;
  normal: boolean; // true only once a browser fact said so; false = unknown (fails closed, 06 2.3)
}

// Optimistic commit writes awaiting their activation result (03 4.5).
export interface Written {
  tabId: TabId;
  windowId: WindowId;
  used: readonly [before: UseNumber, after: UseNumber];
  focused: readonly [before: UseNumber, after: UseNumber] | null;
  confirmed: { used: boolean; focused: boolean };
}

export interface Recents {
  seq: UseNumber; // last number handed out; never reset, also not by clear
  tabs: ReadonlyMap<TabId, TabEntry>;
  windows: ReadonlyMap<WindowId, WindowEntry>;
  active: ReadonlyMap<WindowId, TabId>; // from browser facts only; memory only (06 2.4)
  pending: ReadonlyMap<OpId, Written>; // memory only, at most PENDING_MAX, oldest first
}

export const PENDING_MAX = 16;

export const EMPTY_RECENTS: Recents = {
  seq: 0,
  tabs: new Map(),
  windows: new Map(),
  active: new Map(),
  pending: new Map(),
};

export const isNormal = (r: Recents, w: WindowId): boolean => r.windows.get(w)?.normal === true;

// ---- views (06 2.1): computed at each press, never stored

const byUse = (a: { used: UseNumber }, b: { used: UseNumber }) => b.used - a.used;

function usedTabs(r: Recents, w?: WindowId): (TabRef & { used: UseNumber })[] {
  const out: (TabRef & { used: UseNumber })[] = [];
  for (const [tabId, t] of r.tabs) if (t.used > 0 && (w === undefined || t.windowId === w)) out.push({ tabId, ...t });
  return out.sort(byUse);
}

// Most recent first; tabs at used 0 are the snapshot's, in tab bar order (C-REC-01).
export const windowList = (r: Recents, w: WindowId): readonly TabId[] => usedTabs(r, w).map((t) => t.tabId);

// Most recent first across windows (C-REC-02).
export const globalList = (r: Recents): readonly TabRef[] =>
  usedTabs(r).map(({ tabId, windowId }) => ({ tabId, windowId }));

// The source window, then open windows by focus, then never focused ones in browser order (C-WIN-02, C-WIN-11).
export function windowOrder(r: Recents, open: readonly WindowId[], source: WindowId): readonly WindowId[] {
  const focused = (w: WindowId) => r.windows.get(w)?.focused ?? 0;
  const rest = open.filter((w) => w !== source);
  const seen = rest.filter((w) => focused(w) > 0).sort((a, b) => focused(b) - focused(a));
  return [...(open.includes(source) ? [source] : []), ...seen, ...rest.filter((w) => focused(w) === 0)];
}

// ---- operations (06 2.2)

const withEntry = <K, V>(m: ReadonlyMap<K, V>, k: K, v: V): ReadonlyMap<K, V> => new Map(m).set(k, v);
function without<K, V>(m: ReadonlyMap<K, V>, k: K): ReadonlyMap<K, V> {
  if (!m.has(k)) return m;
  const next = new Map(m);
  next.delete(k);
  return next;
}
const ensureWindow = (r: Recents, w: WindowId): ReadonlyMap<WindowId, WindowEntry> =>
  r.windows.has(w) ? r.windows : withEntry(r.windows, w, { focused: 0, normal: false });

function confirm(r: Recents, match: (w: Written) => 'used' | 'focused' | null): ReadonlyMap<OpId, Written> {
  let pending = r.pending;
  for (const [op, w] of r.pending) {
    const write = match(w);
    if (write && !w.confirmed[write])
      pending = withEntry(pending, op, { ...w, confirmed: { ...w.confirmed, [write]: true } });
  }
  return pending;
}

// Takes a number even when it confirms a pending write, or settle already forgot it (05-events 7).
export function tabActivated(r: Recents, tabId: TabId, w: WindowId): Recents {
  const seq = r.seq + 1;
  return {
    seq,
    tabs: withEntry(r.tabs, tabId, { windowId: w, used: seq }),
    windows: ensureWindow(r, w),
    active: withEntry(r.active, w, tabId),
    pending: confirm(r, (p) => (p.tabId === tabId && p.windowId === w ? 'used' : null)),
  };
}

// null, or a window not classified normal (unknown, non normal or not held): no change (C-WIN-12, C-PRIV-09).
// One number marks the window and its active tab.
export function windowFocused(r: Recents, w: WindowId | null): Recents {
  const entry = w === null ? undefined : r.windows.get(w);
  if (w === null || !entry?.normal) return r;
  const seq = r.seq + 1;
  const tabId = r.active.get(w);
  const tab = tabId === undefined ? undefined : r.tabs.get(tabId);
  return {
    ...r,
    seq,
    windows: withEntry(r.windows, w, { ...entry, focused: seq }),
    tabs: tab && tabId !== undefined ? withEntry(r.tabs, tabId, { ...tab, used: seq }) : r.tabs,
    pending: confirm(r, (p) => (p.windowId === w && p.focused ? 'focused' : null)),
  };
}

export function windowCreated(r: Recents, w: WindowId, normal: boolean): Recents {
  const entry = r.windows.get(w);
  if (entry?.normal === normal) return r;
  return { ...r, windows: withEntry(r.windows, w, { focused: entry?.focused ?? 0, normal }) };
}

// tabRemoved and tabDetached change recents the same way (C-REC-04, C-REC-05).
export function tabGone(r: Recents, tabId: TabId, w: WindowId): Recents {
  if (!r.tabs.has(tabId) && r.active.get(w) !== tabId) return r;
  return { ...r, tabs: without(r.tabs, tabId), active: r.active.get(w) === tabId ? without(r.active, w) : r.active };
}

// Joins as least recent; the browser's following tabActivated moves it first when active (C-REC-05).
export function tabAttached(r: Recents, tabId: TabId, w: WindowId): Recents {
  const t = r.tabs.get(tabId);
  if (t?.windowId === w) return r;
  return { ...r, tabs: withEntry(r.tabs, tabId, { windowId: w, used: 0 }), windows: ensureWindow(r, w) };
}

// The added tab keeps the removed one's place (C-REC-06).
export function tabReplaced(r: Recents, added: TabId, removed: TabId): Recents {
  const t = r.tabs.get(removed);
  if (!t) return r;
  let active = r.active;
  for (const [w, tabId] of r.active) if (tabId === removed) active = withEntry(active, w, added);
  return { ...r, tabs: withEntry(without(r.tabs, removed), added, t), active };
}

export function windowRemoved(r: Recents, w: WindowId): Recents {
  if (!r.windows.has(w) && !r.active.has(w) && ![...r.tabs.values()].some((t) => t.windowId === w)) return r;
  const tabs = new Map([...r.tabs].filter(([, t]) => t.windowId !== w));
  return { ...r, tabs, windows: without(r.windows, w), active: without(r.active, w) };
}

// Live facts list every normal window the extension may see: classify them normal, prune the rest, add unseen tabs at
// used 0, relocate moved tabs at used 0, set active tabs, then number each active tab still at 0 in browser order.
export function reconcile(r: Recents, live: LiveFacts): Recents {
  let seq = r.seq;
  const tabs = new Map<TabId, TabEntry>();
  const windows = new Map<WindowId, WindowEntry>();
  const active = new Map<WindowId, TabId>();
  for (const { windowId, tabs: liveTabs } of live.windows) {
    windows.set(windowId, { focused: r.windows.get(windowId)?.focused ?? 0, normal: true });
    for (const { tabId, active: isActive } of liveTabs) {
      const known = r.tabs.get(tabId);
      tabs.set(tabId, { windowId, used: known?.windowId === windowId ? known.used : 0 });
      if (isActive) active.set(windowId, tabId);
    }
  }
  for (const tabId of active.values()) {
    const t = tabs.get(tabId);
    if (t?.used === 0) tabs.set(tabId, { ...t, used: ++seq });
  }
  return { seq, tabs, windows, active, pending: r.pending };
}

// Every number to 0 and pending emptied, then reconcile; seq keeps counting (C-DATA-05).
export function clear(r: Recents, live: LiveFacts): Recents {
  return reconcile({ ...EMPTY_RECENTS, seq: r.seq }, live);
}

// overflow: the cap forgot the oldest pending write, for the pendingOverflow diagnostic.
export interface Recorded {
  recents: Recents;
  overflow: boolean;
}

// The commit's optimistic write (T-48, C-TAP-08). The target is known in its window (the T-48 guard).
// A 17th record forgets the oldest; its writes stand (06 2.5).
export function record(r: Recents, op: OpId, target: TabRef, focusWindow: boolean): Recorded {
  const tab = r.tabs.get(target.tabId);
  if (!tab) return { recents: r, overflow: false };
  const seq = r.seq + 1;
  const win = focusWindow ? r.windows.get(target.windowId) : undefined;
  const written: Written = {
    ...target,
    used: [tab.used, seq],
    focused: win ? [win.focused, seq] : null,
    confirmed: { used: false, focused: false },
  };
  const pending = new Map(r.pending);
  const overflow = pending.size >= PENDING_MAX;
  if (overflow) pending.delete(pending.keys().next().value as OpId);
  const recents: Recents = {
    ...r,
    seq,
    tabs: withEntry(r.tabs, target.tabId, { ...tab, used: seq }),
    windows: win ? withEntry(r.windows, target.windowId, { ...win, focused: seq }) : r.windows,
    pending: pending.set(op, written),
  };
  return { recents, overflow };
}

export type ActivationResult = 'done' | 'gone' | 'rejected' | 'focusFailed';

// Corrects by the stage that failed; a rollback touches only an unconfirmed write the op still owns (T-60, T-64, T-65).
export function settle(r: Recents, op: OpId, result: ActivationResult): Recents {
  const w = r.pending.get(op);
  if (!w) return r;
  let { tabs, windows } = r;
  const tab = tabs.get(w.tabId);
  if (
    (result === 'gone' || result === 'rejected') &&
    !w.confirmed.used &&
    tab?.windowId === w.windowId &&
    tab.used === w.used[1]
  ) {
    tabs = withEntry(tabs, w.tabId, { ...tab, used: w.used[0] });
  }
  const win = windows.get(w.windowId);
  if (result !== 'done' && w.focused && !w.confirmed.focused && win?.focused === w.focused[1]) {
    windows = withEntry(windows, w.windowId, { ...win, focused: w.focused[0] });
  }
  return { ...r, tabs, windows, pending: without(r.pending, op) };
}

// ---- stored form (06 2.6)

export const SESSION_VERSION = 1;
export const SESSION_KEY = 'recents'; // storage.session key

export interface SessionEnvelope {
  version: typeof SESSION_VERSION;
  tabs: readonly (readonly [tabId: TabId, windowId: WindowId, used: UseNumber])[]; // used above 0, sorted by tabId
  windows: readonly (readonly [windowId: WindowId, focused: UseNumber])[]; // focused above 0, sorted by windowId
}

// Normal windows only, ids and numbers only (C-DATA-01); sorted, so equal models give equal envelopes.
export function project(r: Recents): SessionEnvelope {
  const tabs: [TabId, WindowId, UseNumber][] = [];
  for (const [tabId, t] of r.tabs) if (t.used > 0 && isNormal(r, t.windowId)) tabs.push([tabId, t.windowId, t.used]);
  const windows: [WindowId, UseNumber][] = [];
  for (const [w, e] of r.windows) if (e.normal && e.focused > 0) windows.push([w, e.focused]);
  return {
    version: SESSION_VERSION,
    tabs: tabs.sort((a, b) => a[0] - b[0]),
    windows: windows.sort((a, b) => a[0] - b[0]),
  };
}

export function sameEnvelope(a: SessionEnvelope, b: SessionEnvelope): boolean {
  const same = (x: readonly (readonly number[])[], y: readonly (readonly number[])[]) =>
    x.length === y.length && x.every((row, i) => row.every((v, j) => v === y[i]?.[j]));
  return same(a.tabs, b.tabs) && same(a.windows, b.windows);
}

export type EnvelopeFault = 'shape' | 'version' | 'range' | 'duplicate';
export interface EnvelopeRead {
  recents: Recents;
  source: 'absent' | 'current' | 'discarded';
  fault: EnvelopeFault | null; // for the envelopeDiscarded diagnostic
}

const unique = (values: readonly unknown[]) => new Set(values).size === values.length;
const rowsOf = (rows: unknown, n: number): rows is unknown[][] =>
  Array.isArray(rows) && rows.every((row) => Array.isArray(row) && row.length === n);

// All or nothing: a repaired envelope could invent order (06 2.6).
function envelopeFault(raw: Fields): EnvelopeFault | null {
  if (raw['version'] !== SESSION_VERSION) return 'version';
  const { tabs, windows } = raw;
  if (Object.keys(raw).length !== 3 || !rowsOf(tabs, 3) || !rowsOf(windows, 2)) return 'shape';
  if (!tabs.every(([id, w, used]) => isCount(id, 0) && isCount(w, 0) && isCount(used, 1))) return 'range';
  if (!windows.every(([id, focused]) => isCount(id, 0) && isCount(focused, 1))) return 'range';
  const column = (rows: unknown[][], i: number) => rows.map((row) => row[i]);
  const ok =
    unique(column(tabs, 0)) && unique(column(tabs, 2)) && unique(column(windows, 0)) && unique(column(windows, 1));
  return ok ? null : 'duplicate';
}

// Boot read (06 2.7); the init gate reconciles the result with live facts.
export function readEnvelope(raw: unknown): EnvelopeRead {
  if (raw === undefined) return { recents: EMPTY_RECENTS, source: 'absent', fault: null };
  const fault = isRecord(raw) ? envelopeFault(raw) : 'shape';
  if (fault) return { recents: EMPTY_RECENTS, source: 'discarded', fault };
  const e = raw as SessionEnvelope;
  const tabs = new Map(e.tabs.map(([tabId, windowId, used]) => [tabId, { windowId, used }]));
  const windows = new Map(e.windows.map(([w, focused]) => [w, { focused, normal: true }]));
  for (const [, w] of e.tabs) if (!windows.has(w)) windows.set(w, { focused: 0, normal: true });
  let seq = 0;
  for (const row of e.tabs) seq = Math.max(seq, row[2]);
  for (const row of e.windows) seq = Math.max(seq, row[1]);
  return { recents: { seq, tabs, windows, active: new Map(), pending: new Map() }, source: 'current', fault: null };
}
