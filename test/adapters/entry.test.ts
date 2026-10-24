// Entry adapter: which presses and toolbar clicks become events, against a fake chrome (07-tests 2.2, AC-05;
// 05-events 2.4).

import { expect, test } from 'vite-plus/test';
import { registerEntry } from '../../src/worker/adapters/entry/index.ts';
import { createTabs } from '../../src/worker/adapters/tabs/index.ts';
import { CTRL_SHIFT_E } from '../host-fixtures.ts';
import { collect, installFakeChrome, settle, tab, win, type FakeBrowser } from './fake-chrome.ts';

// C-TAP-03, C-KEY-07, C-KEY-11, C-POP-09; KB-01, KB-03
test.each<{ name: string; shortcut?: string; act: (b: FakeBrowser) => void; steps: object[] }>([
  {
    name: "a press's source is the command's tab, though its window reports focused false",
    act: (b) => {
      b.windows = [win(1), win(2, { focused: true })];
      b.tabs.push(tab(21, 2, { active: true }));
      b.press(11);
    },
    steps: [{ kind: 'command', source: { tabId: 11, windowId: 1 }, binding: CTRL_SHIFT_E }],
  },
  {
    name: 'a command without a tab steps nothing',
    act: (b) => {
      b.press();
    },
    steps: [],
  },
  {
    name: 'with no shortcut set a press does nothing',
    shortcut: '',
    act: (b) => {
      b.press(11);
    },
    steps: [],
  },
  {
    name: 'with a shortcut without Cmd, Ctrl or Alt a press does nothing',
    shortcut: 'MediaPlayPause',
    act: (b) => {
      b.press(11);
    },
    steps: [],
  },
  {
    name: 'with no shortcut set a toolbar click still steps, binding null',
    shortcut: '',
    act: (b) => {
      b.click(11);
    },
    steps: [{ kind: 'toolbarClicked', source: { tabId: 11, windowId: 1 }, binding: null }],
  },
  {
    name: 'with a shortcut without Cmd, Ctrl or Alt a toolbar click still steps, binding null',
    shortcut: 'MediaPlayPause',
    act: (b) => {
      b.click(11);
    },
    steps: [{ kind: 'toolbarClicked', source: { tabId: 11, windowId: 1 }, binding: null }],
  },
])('AC-05 entry.acceptance: $name', async ({ shortcut, act, steps }) => {
  const browser = installFakeChrome();
  if (shortcut !== undefined) browser.shortcut = shortcut;
  const { ingress, stepped } = collect();
  registerEntry(ingress, () => createTabs().liveFacts());
  act(browser);
  await settle();
  expect(stepped).toMatchObject(steps);
});
