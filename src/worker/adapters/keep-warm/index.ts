import {
  WARM_TABS_KEY,
  readWarmRecords,
  warmDiff,
  warmTabs,
  type Model,
  type TabId,
  type WindowId,
} from '../../../core/index.ts';
import { reportCode } from '../../diagnostics.ts';
import { isPrivate } from '../tabs/index.ts';

const sameTabSet = (a: readonly TabId[], b: readonly TabId[]): boolean =>
  a.length === b.length && a.every((id) => b.includes(id));

const saveRecords = (ids: readonly TabId[]) => chrome.storage.local.set({ [WARM_TABS_KEY]: ids });
const loadRecords = async (): Promise<TabId[]> =>
  readWarmRecords((await chrome.storage.local.get(WARM_TABS_KEY))[WARM_TABS_KEY]);

async function ifOpen<T>(call: Promise<T>): Promise<T | null> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof Error && /^No tab with id:/i.test(error.message)) return null;
    throw error; // other failures must preserve the restoration record
  }
}

// One writer. A fresh worker always reads the journal, even for an empty pair. In flight work finishes before
// the latest request runs, and flipping within an already protected pair needs no tab or storage calls.
export function createKeepWarm() {
  let pending: (Pick<Model, 'recents' | 'settings'> & { sourceWindow: WindowId | undefined }) | null = null;
  let applied: readonly TabId[] | null = null;
  let inherited: Set<TabId> | null = null; // initial records that this worker has yet to claim
  let resetPending = false;
  let queue = Promise.resolve();

  // Startup and reconciliation share a queue. If startup arrives during a write, retain claims this worker made.
  async function clearInheritedRecords(recorded?: readonly TabId[]): Promise<TabId[]> {
    const stale = inherited;
    const kept = stale ? (recorded ?? (await loadRecords())).filter((id) => !stale.has(id)) : [];
    await saveRecords(kept);
    inherited = new Set();
    resetPending = false;
    applied = null;
    return kept;
  }

  async function reconcile(wanted: readonly TabId[]): Promise<boolean> {
    let recorded = await loadRecords();
    inherited ??= new Set(recorded);
    const ids = new Set([...recorded, ...wanted]);
    const reads = [...ids].map(async (id) => {
      const tab = await ifOpen(chrome.tabs.get(id));
      return [id, tab && !isPrivate(tab) ? tab : null] as const;
    });
    const facts = new Map(await Promise.all(reads));
    if (resetPending) recorded = await clearInheritedRecords(recorded);
    const plan = warmDiff(wanted, recorded, facts);

    for (const id of plan.restore) {
      if (resetPending && inherited.has(id)) continue;
      await ifOpen(chrome.tabs.update(id, { autoDiscardable: true }));
    }
    // Persist restoration records before holding any tab (06 3). Recents checkpoints can coalesce (06 5.1).
    if (!sameTabSet(recorded, plan.records)) await saveRecords(plan.records);
    const closed = new Set<TabId>();
    for (const id of plan.protect) {
      inherited.delete(id);
      if ((await ifOpen(chrome.tabs.update(id, { autoDiscardable: false }))) === null) closed.add(id);
    }
    if (closed.size) await saveRecords(plan.records.filter((id) => !closed.has(id)));

    // Recheck a sleeping member on the next recency change, including its natural activation.
    return closed.size === 0 && wanted.every((id) => facts.get(id)?.discarded === false);
  }

  async function applyLatest(): Promise<void> {
    if (resetPending) await clearInheritedRecords();
    if (!pending) return;
    const { recents, settings, sourceWindow } = pending;
    pending = null;
    let source = sourceWindow;
    if (source === undefined && settings.quickTap === 'flip' && settings.quickScope === 'window') {
      const last = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
      if (last && !isPrivate(last)) source = last.id;
    }
    const wanted = warmTabs(recents, settings, source ?? null);
    if (applied && sameTabSet(applied, wanted)) return;
    applied = (await reconcile(wanted)) ? wanted : null;
  }

  function enqueue(): Promise<void> {
    queue = queue.then(applyLatest).catch(() => {
      applied = null; // the next event or boot replays from durable state
      reportCode('keepWarmFailed');
    });
    return queue;
  }

  return {
    update({ recents, settings }: Pick<Model, 'recents' | 'settings'>, sourceWindow?: WindowId): Promise<void> {
      pending = { recents, settings, sourceWindow };
      return enqueue();
    },
    onStartup(): Promise<void> {
      resetPending = true;
      return enqueue();
    },
  };
}
