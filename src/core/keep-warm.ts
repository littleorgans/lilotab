import { isCount } from './guards.ts';
import { togglePair, type Recents } from './recents/index.ts';
import type { Settings } from './settings/index.ts';
import type { TabId, WindowId } from './types.ts';

export function warmTabs(r: Recents, settings: Settings, sourceWindow: WindowId | null): TabId[] {
  return settings.quickTap === 'flip' ? togglePair(r, settings.quickScope, sourceWindow).map((t) => t.tabId) : [];
}

// Each recorded id had autoDiscardable true. A tab already protected by somebody else never acquires a record.
export const WARM_TABS_KEY = 'keepWarm'; // storage.local key (06 3)

export function readWarmRecords(raw: unknown): TabId[] {
  return Array.isArray(raw) ? [...new Set(raw.filter((id): id is TabId => isCount(id, 0)))] : [];
}

interface DiscardState {
  autoDiscardable: boolean;
  discarded: boolean;
}

// Apply restores first, persist the new records, then protect. Replaying any prefix after a worker stop is safe.
// A null fact means the tab is gone. A discarded tab can leave protection without being activated or reloaded.
export function warmDiff(
  wanted: readonly TabId[],
  recorded: readonly TabId[],
  facts: ReadonlyMap<TabId, DiscardState | null>,
) {
  const records = new Set(recorded);
  const protect: TabId[] = [];
  const restore: TabId[] = [];
  for (const [id, tab] of facts) {
    if (!tab || !wanted.includes(id)) {
      if (records.has(id) && tab?.autoDiscardable === false) restore.push(id);
      records.delete(id);
    } else if (tab.autoDiscardable && !tab.discarded) {
      records.add(id);
      protect.push(id);
    }
  }
  return { restore, records: [...records], protect };
}
