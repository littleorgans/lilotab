// Sessions adapter: when a recently closed tab closed, against a fake chrome (07-tests 2.2, AC-35; 05-events 2.4).

import { expect, test } from 'vite-plus/test';
import { recentlyClosed } from '../../src/worker/adapters/sessions/index.ts';
import { installFakeChrome, tab } from './fake-chrome.ts';

// C-HOLD-32: Session.lastModified is in seconds; the closing time is in ms, and none reads as null.
test('AC-35 sessions.closedAt: a closed tab closed at its session time in ms, and a missing one is null', async () => {
  installFakeChrome();
  const entries = [
    { lastModified: 1_800_000_000, tab: { ...tab(13, 1), sessionId: 's1' } },
    { tab: { ...tab(14, 1), sessionId: 's2' } },
  ];
  Object.assign(chrome, { sessions: { getRecentlyClosed: () => Promise.resolve(entries) } });
  expect((await recentlyClosed()).map((t) => t.closedAt)).toEqual([1_800_000_000_000, null]);
});
