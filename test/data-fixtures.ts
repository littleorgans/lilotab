// Browser facts and recent histories for the data core tables (07-tests TB-04, TB-05, TB-08).
// Histories run the public recents operations, so a table states the events a user caused, never stored numbers.

import {
  EMPTY_RECENTS,
  globalList,
  reconcile,
  tabActivated,
  tabGone,
  windowFocused,
  type LiveFacts,
  type LiveTab,
  type Recents,
  type TabId,
  type WindowId,
} from '../src/core/index.ts';

export const tab = (tabId: TabId, fields: Partial<LiveTab> = {}): LiveTab => ({
  tabId,
  title: `Tab ${String(tabId)}`,
  url: `https://t${String(tabId)}.example/`,
  pinned: false,
  audible: false,
  active: false,
  iconKey: null,
  ...fields,
});

// One normal window in tab bar order; `active` names its active tab.
export const win = (windowId: WindowId, active: TabId, ...tabs: (TabId | LiveTab)[]) => ({
  windowId,
  tabs: tabs.map((t) => (typeof t === 'number' ? tab(t) : t)).map((t) => ({ ...t, active: t.tabId === active })),
});

// Normal windows in browser order.
export const live = (...windows: ReturnType<typeof win>[]): LiveFacts => ({ windows });

export type Step = (r: Recents) => Recents;
export const use =
  (tabId: TabId, windowId: WindowId): Step =>
  (r) =>
    tabActivated(r, tabId, windowId);
export const focus =
  (windowId: WindowId | null): Step =>
  (r) =>
    windowFocused(r, windowId);
export const close =
  (tabId: TabId, windowId: WindowId): Step =>
  (r) =>
    tabGone(r, tabId, windowId);

// Browser start (boot reconcile seeds each active tab, C-REC-09), then the steps in order.
export const history = (facts: LiveFacts, ...steps: Step[]): Recents =>
  steps.reduce((r, step) => step(r), reconcile(EMPTY_RECENTS, facts));

export const recentIds = (r: Recents): TabId[] => globalList(r).map((t) => t.tabId);
