import { expect, test, vi } from 'vite-plus/test';
import { DEFAULTS, WARM_TABS_KEY, init, project, step, tabActivated, warmDiff, warmTabs } from '../src/core/index.ts';
import { createKeepWarm } from '../src/worker/adapters/keep-warm/index.ts';
import { createTabs } from '../src/worker/adapters/tabs/index.ts';
import { installFakeChrome, settle, tab, win as browserWindow } from './adapters/fake-chrome.ts';
import { history, live, use, win } from './data-fixtures.ts';
import { enter, move, press, ready, release, type Ev } from './interaction-harness.ts';

test('the toggle pair follows quick tap scope across listed windows (C-TAP-03, C-TAP-04, C-HOLD-24)', () => {
  const facts = live(win(1, 11, 11, 12, 13), win(2, 21, 21));
  const r = history(facts, use(12, 1), use(21, 2), use(11, 1), use(91, 9));
  expect(warmTabs(r, DEFAULTS, 1)).toEqual([11, 21]);
  expect(warmTabs(r, { ...DEFAULTS, quickScope: 'window' }, 1)).toEqual([11, 12]);
  expect(warmTabs(r, { ...DEFAULTS, quickTap: 'list' }, 1)).toEqual([]);
});

test('the diff restores only owned flags, forgets closed tabs and records only new holds', () => {
  const held = { autoDiscardable: false, discarded: false };
  const free = { autoDiscardable: true, discarded: false };
  const facts = new Map([
    [11, held],
    [12, null],
    [13, free],
    [14, held],
  ]);
  expect(warmDiff([13, 14], [11, 12], facts)).toEqual({ restore: [11], records: [13], protect: [13] });
});

test('Keep list open preserves the toggle pair through release and rotates it when Enter switches (C-TAP-12)', () => {
  const facts = live(win(1, 11, 11, 12, 13));
  const recent = history(facts, use(13, 1), use(12, 1), use(11, 1));
  let model = init('boot', project(recent), { version: 1, onRelease: 'keep' }, facts).model;
  const apply = (input: Ev) => {
    model = step(model, input({ model, live: facts, last: model.interaction?.id ?? null })).model;
  };
  for (const input of [press(0), ready(10), move(20, 1), release(30)]) apply(input);
  expect(model.interaction?.open).toBe(true);
  expect(warmTabs(model.recents, model.settings, 1)).toEqual([11, 12]);
  apply(enter(40));
  expect(warmTabs(model.recents, model.settings, 1)).toEqual([13, 11]);
});

test('a third activation during a hold write leaves only the latest pair protected', async () => {
  const browser = installFakeChrome();
  browser.tabs.push(tab(13, 1));
  const r = history(await createTabs().liveFacts(), use(12, 1), use(11, 1));
  const keepWarm = createKeepWarm();
  const gate = Promise.withResolvers<undefined>();
  browser.gates['storage.local.set'] = gate.promise;
  const save = vi.spyOn(chrome.storage.local, 'set');
  const first = keepWarm.update({ recents: r, settings: DEFAULTS });
  await settle();
  expect(save).toHaveBeenCalledWith({ [WARM_TABS_KEY]: [11, 12] });
  expect(browser.log).toEqual([]);
  const third = tabActivated(r, 13, 1);
  const next = keepWarm.update({ recents: third, settings: DEFAULTS });
  gate.resolve(undefined);
  await Promise.all([first, next]);
  expect(browser.tabs.map((t) => [t.id, t.autoDiscardable])).toEqual([
    [11, false],
    [12, true],
    [13, false],
  ]);
  expect(browser.local[WARM_TABS_KEY]).toEqual([11, 13]);
  const writes = [...browser.log];
  await keepWarm.update({ recents: tabActivated(third, 11, 1), settings: DEFAULTS });
  expect(browser.log).toEqual(writes);
});

test('boot restores the old pair, drops a closed id and leaves preprotected and sleeping tabs alone', async () => {
  const browser = installFakeChrome();
  browser.windows.push(browserWindow(2));
  browser.tabs.push(
    tab(13, 1, { autoDiscardable: false }),
    tab(14, 1, { discarded: true }),
    tab(21, 2, { active: true }),
  );
  const tabs = createTabs();
  const r = history(await tabs.liveFacts(), use(12, 1), use(11, 1));
  await createKeepWarm().update({ recents: r, settings: DEFAULTS });
  expect(browser.local[WARM_TABS_KEY]).toEqual([11, 12]);

  // The new recents checkpoint reached storage before the old worker could apply its new pair.
  const recent = tabActivated(tabActivated(r, 14, 1), 13, 1);
  const checkpoint = project(tabActivated(recent, 21, 2));
  browser.removeTab(12);
  await chrome.tabs.update(13, { active: true });
  browser.log.length = 0;
  const booted = init('next', checkpoint, { version: 1, quickScope: 'window' }, await tabs.liveFacts()).model;
  const keepWarm = createKeepWarm();
  await keepWarm.update(booted);
  expect(browser.log).toEqual(['autoDiscardable 11 true']);
  expect(browser.local[WARM_TABS_KEY]).toEqual([]);
  expect(browser.tabs.map((t) => [t.id, t.autoDiscardable, t.discarded])).toEqual([
    [11, true, false],
    [13, false, false],
    [14, true, true],
    [21, true, false],
  ]);

  await chrome.tabs.update(14, { active: true }); // the user wakes it
  await keepWarm.update({ ...booted, recents: tabActivated(booted.recents, 14, 1) });
  expect(browser.local[WARM_TABS_KEY]).toEqual([14]);
  expect(browser.tabs.find((t) => t.id === 14)?.autoDiscardable).toBe(false);
});

test('an extension reload restores the old pair when later activations replace it', async () => {
  const browser = installFakeChrome();
  browser.tabs.push(tab(13, 1), tab(14, 1));
  const tabs = createTabs();
  const recents = history(await tabs.liveFacts(), use(12, 1), use(11, 1));
  await createKeepWarm().update({ recents, settings: DEFAULTS });
  expect(browser.tabs.map((t) => t.autoDiscardable)).toEqual([false, false, true, true]);

  browser.session = {};
  const booted = init('reloaded', undefined, { version: 1 }, await tabs.liveFacts()).model;
  const keepWarm = createKeepWarm();
  await keepWarm.update(booted);
  let recent = booted.recents;
  for (const id of [13, 14]) {
    await chrome.tabs.update(id, { active: true });
    recent = tabActivated(recent, id, 1);
    await keepWarm.update({ ...booted, recents: recent });
  }
  expect(browser.tabs.map((t) => [t.id, t.autoDiscardable])).toEqual([
    [11, true],
    [12, true],
    [13, false],
    [14, false],
  ]);
});

test('browser startup clears old ownership and preserves claims made by an in flight reconcile', async () => {
  const browser = installFakeChrome();
  browser.tabs[0] = tab(11, 1, { active: true, autoDiscardable: false });
  browser.tabs.push(tab(13, 1));
  browser.local[WARM_TABS_KEY] = [11]; // The previous browser session used the same id.
  const recent = history(await createTabs().liveFacts(), use(12, 1), use(11, 1));
  const keepWarm = createKeepWarm();
  const gate = Promise.withResolvers<undefined>();
  browser.gates['storage.local.set'] = gate.promise;
  const save = vi.spyOn(chrome.storage.local, 'set');
  const first = keepWarm.update({ recents: recent, settings: DEFAULTS });
  await settle();
  expect(save).toHaveBeenCalledExactlyOnceWith({ [WARM_TABS_KEY]: [11, 12] });

  const startup = keepWarm.onStartup();
  const next = tabActivated(tabActivated(recent, 12, 1), 13, 1);
  const rotated = keepWarm.update({ recents: next, settings: DEFAULTS });
  await settle();
  expect(save).toHaveBeenCalledTimes(1);
  expect(browser.log).toEqual([]);

  gate.resolve(undefined);
  await Promise.all([first, startup, rotated]);
  expect(save).toHaveBeenNthCalledWith(2, { [WARM_TABS_KEY]: [12] });
  expect(browser.local[WARM_TABS_KEY]).toEqual([12, 13]);
  expect(browser.log).toEqual(['autoDiscardable 12 false', 'autoDiscardable 13 false']);
});

test('a fresh worker can finish either side of an interrupted flag change', async () => {
  const browser = installFakeChrome();
  const recents = history(await createTabs().liveFacts());
  const model = { recents, settings: DEFAULTS };
  browser.failing.add('tabs.update');
  await createKeepWarm().update(model);
  expect(browser.local[WARM_TABS_KEY]).toEqual([11]);
  expect(browser.tabs[0]?.autoDiscardable).toBe(true);

  browser.failing.clear();
  const keepWarm = createKeepWarm();
  await keepWarm.update(model);
  expect(browser.tabs[0]?.autoDiscardable).toBe(false);
  const list = { recents, settings: { ...DEFAULTS, quickTap: 'list' as const } };
  browser.failing.add('storage.local.set');
  await keepWarm.update(list);
  expect(browser.tabs[0]?.autoDiscardable).toBe(true);
  expect(browser.local[WARM_TABS_KEY]).toEqual([11]);

  browser.failing.clear();
  await createKeepWarm().update(list);
  expect(browser.log).toEqual(['autoDiscardable 11 false', 'autoDiscardable 11 true']);
  expect(browser.local[WARM_TABS_KEY]).toEqual([]);
});
