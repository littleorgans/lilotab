// Commands and toolbar action: prepares command and toolbarClicked events (03-components 3.2, 05-events 2.4).

import { readShortcut } from '../../../browser/commands.ts';
import {
  PREP_BUDGET_MS,
  parseBinding,
  type LiveFacts,
  type Millis,
  type Sink,
  type SourceTab,
} from '../../../core/index.ts';
import { reportCode } from '../../diagnostics.ts';
import { SWITCH_COMMAND } from '../../names.ts';
import { timing } from '../../timing/index.ts';
import { settleBy, type Settled } from '../clock/index.ts';
import { isPrivate } from '../tabs/index.ts';

// The tab a press or click came from; none for a Global shortcut (C-KEY-07) or a private tab (C-PRIV-08).
function sourceOf(tab: chrome.tabs.Tab | undefined): SourceTab | null {
  if (!tab || isPrivate(tab) || tab.id === undefined || tab.id < 0) return null;
  return { tabId: tab.id, windowId: tab.windowId, url: tab.url ?? tab.pendingUrl ?? '' };
}

function failed(settled: Settled<unknown>, detail: string): void {
  if (!settled.ok) reportCode(settled.cause === 'timeout' ? 'prepTimeout' : 'prepFailed', detail);
}

// Both queries in parallel, each bounded by the press's at plus the budget. The binding is null when unbound or
// without Cmd, Ctrl or Alt (C-KEY-09, C-KEY-11).
async function prepare(at: Millis, liveFacts: () => Promise<LiveFacts>, entry: 'shortcut' | 'toolbar') {
  const until = at + PREP_BUDGET_MS;
  const [binding, live] = await Promise.all([
    settleBy(readShortcut().then(parseBinding), until),
    settleBy(liveFacts(), until),
  ]);
  failed(binding, 'binding');
  failed(live, 'live');
  if (
    timing &&
    ((!live.ok && live.cause === 'timeout') || (entry === 'shortcut' && !binding.ok && binding.cause === 'timeout'))
  ) {
    timing.dropped(entry, at);
  }
  const unusable = binding.ok && binding.value === null;
  return { binding: binding.ok ? binding.value : null, live: live.ok ? live.value : null, unusable };
}

export function registerEntry(sink: Sink, liveFacts: () => Promise<LiveFacts>): void {
  chrome.commands.onCommand.addListener((command, tab) => {
    const source = command === SWITCH_COMMAND ? sourceOf(tab) : null;
    if (!source) return;
    sink(async (at) => {
      const { binding, live, unusable } = await prepare(at, liveFacts, 'shortcut');
      if (unusable) reportCode('prepFailed', 'unbound'); // the settings page says why (C-KEY-11)
      return binding && live ? { kind: 'command', at, source, binding, live } : null;
    });
  });
  // Fires only while the tab has no action popup; the host link clears it after each opening (C-POP-09).
  chrome.action.onClicked.addListener((tab) => {
    const source = sourceOf(tab);
    if (!source) return;
    sink(async (at) => {
      const { binding, live } = await prepare(at, liveFacts, 'toolbar');
      return live ? { kind: 'toolbarClicked', at, source, binding, live } : null;
    });
  });
}
