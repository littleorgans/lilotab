// Commands and toolbar action: prepares command, searchCommand and toolbarClicked events (03-components 3.2,
// 05-events 2.4).

import { readShortcut } from '../../../browser/commands.ts';
import { BENCH_MARK, BENCH_OPEN, BENCH_TAP, armBenchMarks, benchMark } from '../../../browser/timing.ts';
import {
  PREP_BUDGET_MS,
  parseBinding,
  type ClosedTab,
  type LiveFacts,
  type Millis,
  type Sink,
  type SourceTab,
} from '../../../core/index.ts';
import { reportCode } from '../../diagnostics.ts';
import { SEARCH_COMMAND, SWITCH_COMMAND } from '../../names.ts';
import { timing } from '../../timing/index.ts';
import { settleBy, wall, type Settled } from '../clock/index.ts';
import { isPrivate } from '../tabs/index.ts';

// The tab a press or click came from; none for a Global shortcut (C-KEY-07) or a private tab (C-PRIV-08).
function sourceOf(tab: chrome.tabs.Tab | undefined): SourceTab | null {
  if (!tab || isPrivate(tab) || tab.id === undefined || tab.id < 0) return null;
  return { tabId: tab.id, windowId: tab.windowId, url: tab.url ?? tab.pendingUrl ?? '' };
}

function failed(settled: Settled<unknown>, detail: string): void {
  if (!settled.ok) reportCode(settled.cause === 'timeout' ? 'prepTimeout' : 'prepFailed', detail);
}

type Entry = 'shortcut' | 'search';
type Reads = { liveFacts: () => Promise<LiveFacts>; closedTabs: (entry: Entry) => Promise<readonly ClosedTab[]> };

// Every query in parallel, each bounded by the press's at plus the budget. The binding is null when unbound or
// without Cmd, Ctrl or Alt (C-KEY-09, C-KEY-11). Recently closed tabs that fail or come late are none (C-SRCH-27).
async function prepare(at: Millis, reads: Reads, entry: Entry) {
  const until = at + PREP_BUDGET_MS;
  const shortcut = settleBy(readShortcut(SWITCH_COMMAND).then(parseBinding), until);
  const query = import.meta.env.MODE === 'timing' && benchMark(BENCH_MARK.queryStart);
  const facts = reads.liveFacts();
  if (query) {
    const end = () => {
      benchMark(BENCH_MARK.queryEnd);
    };
    void facts.then(end, end);
  }
  const [binding, live, closed] = await Promise.all([
    shortcut,
    settleBy(facts, until),
    settleBy(reads.closedTabs(entry), until),
  ]);
  failed(binding, 'binding');
  failed(live, 'live');
  failed(closed, 'closed');
  if (
    timing &&
    ((!live.ok && live.cause === 'timeout') || (entry === 'shortcut' && !binding.ok && binding.cause === 'timeout'))
  ) {
    timing.dropped(entry, at);
  }
  const unusable = binding.ok && binding.value === null;
  return {
    binding: binding.ok ? binding.value : null,
    live: live.ok ? live.value : null,
    closed: closed.ok ? closed.value : [],
    unusable,
  };
}

export function registerEntry(
  sink: Sink,
  liveFacts: () => Promise<LiveFacts>,
  closedTabs: (entry: Entry) => Promise<readonly ClosedTab[]>,
): void {
  const reads: Reads = { liveFacts, closedTabs };
  // A search entry steps without a usable binding; it only loses the shortcut keys (C-POP-09, C-KEY-12).
  // Each press stamps its wall time before its first await: ingress calls the preparation at once (05-events 2.2).
  const search = (kind: 'toolbarClicked' | 'searchCommand', source: SourceTab): void => {
    sink(async (at) => {
      const stamp = wall();
      const { binding, live, closed } = await prepare(at, reads, 'search');
      return live ? { kind, at, wall: stamp, source, binding, live, closed } : null;
    });
  };
  function onCommand(command: string, tab?: chrome.tabs.Tab): void {
    const source = sourceOf(tab);
    if (!source) return;
    if (command === SEARCH_COMMAND) search('searchCommand', source);
    if (command !== SWITCH_COMMAND) return;
    sink(async (at) => {
      const stamp = wall();
      const { binding, live, closed, unusable } = await prepare(at, reads, 'shortcut');
      if (unusable) reportCode('prepFailed', 'unbound'); // the settings page says why (C-KEY-11)
      return binding && live ? { kind: 'command', at, wall: stamp, source, binding, live, closed } : null;
    });
  }
  chrome.commands.onCommand.addListener(onCommand);
  if (import.meta.env.MODE === 'timing') {
    // Unlike calling a worker callback over CDP, a content script message can wake a stopped worker.
    chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
      if (
        (message !== BENCH_OPEN && message !== BENCH_TAP) ||
        sender.id !== chrome.runtime.id ||
        sender.frameId !== 0 ||
        !sender.tab?.active
      )
        return;
      armBenchMarks();
      const entry = benchMark(BENCH_MARK.entry);
      onCommand(message === BENCH_TAP ? SWITCH_COMMAND : SEARCH_COMMAND, sender.tab);
      reply(message === BENCH_TAP && entry ? performance.timeOrigin + entry.startTime : true);
    });
  }
  // Fires only while the tab has no action popup; the host link clears it after each opening (C-POP-09).
  chrome.action.onClicked.addListener((tab) => {
    const source = sourceOf(tab);
    if (source) search('toolbarClicked', source);
  });
}
