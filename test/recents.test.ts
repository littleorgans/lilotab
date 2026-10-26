// TB-05 recents.events and TB-08 recents.envelope (07-tests 2.1): recent orders after browser events and commits,
// and their survival through the session envelope.

import { describe, expect, it } from 'vite-plus/test';
import {
  clear,
  globalList,
  project,
  readEnvelope,
  reconcile,
  record,
  settle,
  tabActivated,
  tabAttached,
  tabGone,
  tabReplaced,
  windowFocused,
  windowList,
  windowOrder,
  windowRemoved,
  type ActivationResult,
  type Recents,
  type TabId,
  type WindowId,
} from '../src/core/index.ts';
import { close, focus, history, live, recentIds, use, win, type Step } from './data-fixtures.ts';

const attach =
  (tabId: TabId, windowId: WindowId): Step =>
  (r) =>
    tabAttached(r, tabId, windowId);
// A commit's optimistic write (T-48) and its activation result (T-60, T-64, T-65).
const commit =
  (op: string, tabId: TabId, windowId: WindowId, focusWindow = false): Step =>
  (r) =>
    record(r, op, { tabId, windowId }, focusWindow).recents;
const result =
  (op: string, outcome: ActivationResult): Step =>
  (r) =>
    settle(r, op, outcome);

// Window 1 holds 1, 2, 3; window 2 holds 4, 5; window 3 holds 6. Boot seeds 1, 4, 6 in browser order.
const L = live(win(1, 1, 1, 2, 3), win(2, 4, 4, 5), win(3, 6, 6));
const WINDOWS = [1, 2, 3];

// The orders a press reads: global, per window, and window recency (source outside, so focus order alone).
const orders = (r: Recents, windows: readonly WindowId[] = WINDOWS) => ({
  global: recentIds(r),
  window: Object.fromEntries(windows.map((w) => [w, windowList(r, w)])),
  focus: windowOrder(r, windows, 0),
});

describe('TB-05 recents.events', () => {
  it.each<{ name: string; steps: Step[]; expected: object }>([
    {
      name: 'C-REC-03 activation moves the tab first in its window and globally',
      steps: [use(3, 1)],
      expected: { global: [3, 6, 4, 1], window: { 1: [3, 1] } },
    },
    {
      name: 'C-REC-04 a closed tab leaves every order',
      steps: [use(2, 1), use(3, 1), close(2, 1)],
      expected: { global: [3, 6, 4, 1], window: { 1: [3, 1] } },
    },
    {
      name: 'C-REC-05 a moved tab joins its new window as least recent',
      steps: [use(2, 1), close(2, 1), attach(2, 2)],
      expected: { global: [6, 4, 1], window: { 1: [1], 2: [4] } },
    },
    {
      name: 'C-REC-05 a moved tab active in its new window goes first',
      steps: [use(2, 1), close(2, 1), attach(2, 2), use(2, 2)],
      expected: { global: [2, 6, 4, 1], window: { 1: [1], 2: [2, 4] } },
    },
    {
      name: 'C-REC-05 reconcile relocates a tab whose move events were lost, as least recent',
      steps: [use(2, 1), use(1, 1), (r) => reconcile(r, live(win(1, 1, 1, 3), win(2, 4, 4, 5, 2), win(3, 6, 6)))],
      expected: { window: { 1: [1], 2: [4] } },
    },
    {
      name: 'C-REC-06 a replaced tab keeps its place',
      steps: [use(2, 1), use(3, 1), (r) => tabReplaced(r, 9, 2)],
      expected: { window: { 1: [3, 9, 1] } },
    },
    {
      name: 'C-REC-07 a closed window and its tabs leave every order',
      steps: [focus(2), focus(1), (r) => windowRemoved(r, 2)],
      expected: { global: [1, 6], window: { 2: [] } },
    },
    {
      name: 'C-REC-09 boot records each window active tab, in browser order',
      steps: [],
      expected: { global: [6, 4, 1], window: { 1: [1], 2: [4], 3: [6] } },
    },
    {
      name: 'C-WIN-12 C-PRIV-09 focus leaving the browser or to a private window (null) changes nothing',
      steps: [focus(2), focus(null)],
      expected: { global: [4, 6, 1], focus: [2, 1, 3] },
    },
    {
      name: 'C-WIN-12 focus on a window recents does not hold changes nothing',
      steps: [focus(2), focus(42)],
      expected: { global: [4, 6, 1], focus: [2, 1, 3] },
    },
    {
      name: 'C-DATA-05 clear empties every order and window recency, then reseeds active tabs in browser order',
      steps: [use(2, 1), use(1, 1), focus(2), use(5, 2), use(4, 2), (r) => clear(r, L)],
      expected: { global: [6, 4, 1], window: { 1: [1], 2: [4], 3: [6] }, focus: [1, 2, 3] },
    },
    {
      // 05-events 7: the second tap reads the first one's optimistic write, so its target is the tab just left.
      name: 'KB-02 C-TAP-08 C-SW-04 a quick tap counts at once, so a second tap before the browser reports goes back',
      steps: [use(2, 1), commit('op', 1, 1)],
      expected: { window: { 1: [1, 2] } },
    },
    {
      name: 'T-60 `gone` restores the earlier tab and window order',
      steps: [focus(3), focus(1), commit('op', 5, 2, true), result('op', 'gone')],
      expected: { global: [1, 6, 4], window: { 2: [4] }, focus: [1, 3, 2] },
    },
    {
      name: 'T-64 C-WIN-07 `focusFailed` keeps the tab first in its window and restores window order',
      steps: [focus(3), focus(1), commit('op', 5, 2, true), result('op', 'focusFailed')],
      expected: { global: [5, 1, 6, 4], window: { 2: [5, 4] }, focus: [1, 3, 2] },
    },
    {
      // 05-events 7: a real activation is never undone.
      name: 'T-60 the browser activation arriving before a `rejected` result keeps the tab first',
      steps: [commit('op', 2, 1), use(2, 1), result('op', 'rejected')],
      expected: { window: { 1: [2, 1] } },
    },
  ])('$name', ({ steps, expected }) => {
    expect(orders(history(L, ...steps))).toMatchObject(expected);
  });

  it('C-REC-08 every activated tab stays in order, no cap at 1,000 tabs', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => i + 1);
    const r = history(live(win(1, 1, ...ids)), ...ids.map((id) => use(id, 1)));
    expect(windowList(r, 1)).toEqual(ids.toReversed());
  });
});

// Seeded so a failure names a reproducible case; plain TS, no property testing dependency.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A random run of activations, focus changes, closes, opens, moves and commits over three normal windows.
function randomRecents(seed: number, events: number): Recents {
  const next = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
  const where = new Map<TabId, WindowId>(L.windows.flatMap((w) => w.tabs.map((t) => [t.tabId, w.windowId])));
  let r = history(L);
  let newId = 100;
  for (let i = 0; i < events; i++) {
    const [tabId, windowId] = pick([...where]);
    switch (pick(['use', 'focus', 'close', 'open', 'move', 'commit'] as const)) {
      case 'use':
        r = tabActivated(r, tabId, windowId);
        break;
      case 'focus':
        r = windowFocused(r, pick([...WINDOWS, null]));
        break;
      case 'close':
        if (where.size > 1) {
          r = tabGone(r, tabId, windowId);
          where.delete(tabId);
        }
        break;
      case 'open': {
        const w = pick(WINDOWS);
        where.set(newId, w);
        r = tabActivated(r, newId++, w);
        break;
      }
      case 'move': {
        const w = pick(WINDOWS);
        r = tabAttached(tabGone(r, tabId, windowId), tabId, w);
        where.set(tabId, w);
        break;
      }
      case 'commit':
        r = record(r, `op${String(i)}`, { tabId, windowId }, next() < 0.5).recents;
        r = settle(r, `op${String(i)}`, pick(['done', 'gone', 'rejected', 'focusFailed'] as const));
        break;
    }
  }
  return r;
}

describe('TB-08 recents.envelope', () => {
  it('C-DATA-02 the next focus after reading saved history outranks a stored focus whose tab was closed', () => {
    // Closing the focused tab leaves the highest stored number on its window (06-data 2.6).
    const stored = project(history(L, focus(2), close(4, 2)));
    const restored = readEnvelope(stored).recents;
    expect(windowOrder(windowFocused(restored, 3), WINDOWS, 0)).toEqual([3, 2, 1]);
  });

  it('C-DATA-02 project then read gives the same orders (property, 200 seeded runs)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = randomRecents(seed, 40);
      const stored: unknown = JSON.parse(JSON.stringify(project(r)));
      const read = readEnvelope(stored);
      expect({ source: read.source, ...orders(read.recents) }, `seed ${String(seed)}`).toEqual({
        source: 'current',
        ...orders(r),
      });
      expect(globalList(read.recents), `seed ${String(seed)}`).toEqual(globalList(r));
    }
  });

  it('C-DATA-01 a tab in a window not known as normal is never stored', () => {
    const r = history(L, use(7, 9));
    expect(recentIds(readEnvelope(project(r)).recents)).toEqual([6, 4, 1]);
  });

  it.each([
    { name: 'wrong version', raw: { version: 2, tabs: [[1, 1, 1]], windows: [] } },
    {
      name: 'duplicate use number',
      raw: {
        version: 1,
        tabs: [
          [1, 1, 5],
          [2, 1, 5],
        ],
        windows: [],
      },
    },
  ])('C-DATA-02 $name: the whole envelope is discarded, no order invented', ({ raw }) => {
    const read = readEnvelope(raw);
    expect({ source: read.source, global: recentIds(read.recents) }).toEqual({ source: 'discarded', global: [] });
  });
});
