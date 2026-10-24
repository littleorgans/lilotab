// Worker shell ingress and preparation budget against a fake chrome (07-tests 2.2, AC-01, AC-02; 05-events 2.1, 2.4).

import { beforeEach, expect, test, vi } from 'vite-plus/test';
import { createTimers } from '../../src/worker/adapters/clock/index.ts';
import { registerEntry } from '../../src/worker/adapters/entry/index.ts';
import { createTabs } from '../../src/worker/adapters/tabs/index.ts';
import { collect, installFakeChrome, settle, sleep, tab, type FakeBrowser } from './fake-chrome.ts';

const timingHooks = vi.hoisted(() => ({ prepared: vi.fn(), dropped: vi.fn() }));
vi.mock('../../src/worker/timing/index.ts', () => ({ timing: timingHooks }));

let browser: FakeBrowser;
beforeEach(() => {
  browser = installFakeChrome();
});

// Live facts that settle after the next delay in the list, one per press.
const liveAfter = (delays: number[]) => async () => {
  await sleep(delays.shift() ?? 0);
  return createTabs().liveFacts();
};

// C-SW-05, KB-02
test('AC-01 shell.ingressOrder: two presses whose preparations settle in reverse step in press order', async () => {
  browser.tabs.push(tab(13, 1));
  const { ingress, stepped } = collect();
  registerEntry(ingress, liveAfter([200, 10]));
  browser.press(11);
  browser.press(13);
  await settle();
  expect(stepped).toMatchObject([
    { kind: 'command', source: { tabId: 11 } },
    { kind: 'command', source: { tabId: 13 } },
  ]);
});

// C-SW-04: the timer steps behind the press it queued after, with the at it fired at, which decides its expiry.
test('AC-01 shell.ingressOrder: a timer queued behind a preparing press steps after it with its own at', async () => {
  const { ingress, stepped } = collect();
  registerEntry(ingress, liveAfter([200]));
  browser.press(11);
  createTimers(ingress).start('boot:1', 'hostDeadline', 100);
  await settle();
  expect(stepped.map((e) => [e.kind, e.at])).toEqual([
    ['command', 0],
    ['timer', 100],
  ]);
});

// C-POP-05 exception: the press's shortcut and open tabs must settle within 250 ms of it.
test.each([
  { facts: 'open tabs', call: 'windows.getAll', ms: 240, outcome: 'the press steps', steps: ['command'] },
  { facts: 'open tabs', call: 'windows.getAll', ms: 260, outcome: 'the press does nothing', steps: [] },
  { facts: 'shortcut', call: 'commands.getAll', ms: 260, outcome: 'the press does nothing', steps: [] },
] as const)('AC-02 shell.prepBudget: $facts at $ms ms, $outcome', async ({ call, ms, steps }) => {
  const { ingress, stepped } = collect();
  registerEntry(ingress, () => createTabs().liveFacts());
  browser.gates[call] = sleep(ms);
  browser.press(11);
  await settle(); // past the late result too: it is discarded
  expect(stepped.map((e) => e.kind)).toEqual(steps);
});

// Measurement must retain the preparation timeout without stepping a replacement event into the core.
test('a preparation timeout records a dropped shortcut or toolbar press', async () => {
  for (const entry of ['shortcut', 'toolbar'] as const) {
    vi.clearAllMocks();
    browser = installFakeChrome();
    const { ingress, stepped } = collect();
    registerEntry(ingress, liveAfter([260]));
    if (entry === 'shortcut') browser.press(11);
    else browser.click(11);
    await settle();
    expect(stepped).toEqual([]);
    expect(timingHooks.dropped).toHaveBeenCalledWith(entry, expect.any(Number));
  }
});
