import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { BENCH_ARMED, BENCH_MARK, BENCH_TAP, TAP_MARK, TIMING_KEY } from '../../src/browser/timing.ts';
import { HOLD_IDLE_MS } from '../../src/core/interaction/types.ts';
import { SWITCH_COMMAND } from '../../src/worker/names.ts';
import { evaluateCDP, eventListener, extensionWorld } from '../chrome/browser.mjs';
import { keyEvents } from '../key-input.ts';
import { requestCommand, waitForGesture, waitForMark } from './journey.mjs';

const PAGE_KEYUP = 'lilotab:tap-page-keyup';
const RELOAD = 'lilotab:tap-target-complete';
const META = 'Meta';
const [metaUp] = keyEvents(META, { phase: 'up' });
const stamp = () => performance.timeOrigin + performance.now();
const pageMarks = {
  request: BENCH_MARK.request,
  keyup: PAGE_KEYUP,
  startReceived: BENCH_MARK.startReceived,
  listStart: BENCH_MARK.listStart,
  listEnd: BENCH_MARK.listEnd,
  listening: TAP_MARK.listening,
  shown: BENCH_MARK.frame,
  releaseSeen: TAP_MARK.releaseSeen,
  releasePosted: TAP_MARK.releasePosted,
  overlayCut: TAP_MARK.overlayCut,
  overlayRemoved: TAP_MARK.overlayRemoved,
};
const workerMarks = {
  queryStart: BENCH_MARK.queryStart,
  queryEnd: BENCH_MARK.queryEnd,
  startSent: BENCH_MARK.startSent,
  switchRequested: TAP_MARK.switchRequested,
  tabUpdate: TAP_MARK.tabUpdate,
  tabUpdated: TAP_MARK.tabUpdated,
  activated: BENCH_MARK.activated,
  focusRequested: TAP_MARK.focusRequested,
  switchSettled: TAP_MARK.switchSettled,
  targetComplete: RELOAD,
};

// Runs only in the disposable timing extension's worker. Keep the Chrome queries, then substitute fixture data.
function installTapInputs(command, sourceWindow, reloadMark, targetId) {
  const { commands, windows, scripting, tabs } = globalThis.chrome;
  const getCommands = commands.getAll.bind(commands);
  commands.getAll = async () => {
    const all = await getCommands();
    return all.map((item) => (item.name === command ? { ...item, shortcut: 'Command+E' } : item));
  };
  let padding = 0;
  const getWindows = windows.getAll.bind(windows);
  windows.getAll = async (options) => {
    const all = await getWindows(options);
    const source = all.find((window) => window.id === sourceWindow);
    if (!padding || !source?.tabs?.length) return all;
    const maxId = Math.max(0, ...all.flatMap((window) => window.tabs?.map((tab) => tab.id ?? 0) ?? []));
    const url = source.tabs[0].url;
    const extra = Array.from({ length: padding }, (_, index) => ({
      id: maxId + index + 1,
      title: 'Synthetic tab ' + (index + 1),
      url,
      incognito: false,
      active: false,
      pinned: false,
    }));
    source.tabs = source.tabs.concat(extra);
    return all;
  };
  let gate;
  const execute = scripting.executeScript.bind(scripting);
  scripting.executeScript = async (injection) => {
    if (injection.files && gate) await gate.promise;
    return execute(injection);
  };
  tabs.onUpdated.addListener((tabId, change) => {
    if (tabId === targetId && change.status === 'complete') performance.mark(reloadMark);
  });
  return {
    configure(rows, deferInjection) {
      padding = rows;
      gate = deferInjection ? Promise.withResolvers() : undefined;
    },
    allowInjection() {
      gate?.resolve();
      gate = undefined;
    },
  };
}

export async function prepareTap(fixture) {
  const targetId = fixture.fixtures[1].tabId;
  const parkId = fixture.fixtures[2].tabId;
  const workerTarget = await fixture.workerTarget();
  const worker = await workerTarget.worker();
  const session = await workerTarget.createCDPSession();
  const seed = await eventListener(session, 'tabs', 'onActivated', 'tap-recents');
  const inputs = await worker.evaluateHandle(
    installTapInputs,
    SWITCH_COMMAND,
    fixture.source.windowId,
    RELOAD,
    targetId,
  );
  return { ...fixture, worker, workerSession: session, seed, inputs, targetId, parkId };
}

export function moveTapTarget({ worker, targetId, parkId }) {
  return worker.evaluate(
    async (target, park) => {
      const { windows, tabs } = globalThis.chrome;
      // Adopt an existing tab so setting up the cross window case never increases the real tab count.
      const { id } = await windows.create({ tabId: park, focused: false, type: 'normal' });
      await tabs.move(target, { windowId: id, index: -1 });
      return id;
    },
    targetId,
    parkId,
  );
}

function armKeyup(flag, mark, key) {
  globalThis[flag] = true;
  window.addEventListener(
    'keyup',
    (event) => {
      if (event.isTrusted && event.key === key) performance.mark(mark);
    },
    { capture: true },
  );
}

function readMarks(names, after = 0) {
  const origin = performance.timeOrigin;
  return Object.fromEntries(
    Object.entries(names).map(([key, name]) => {
      const mark = performance.getEntriesByName(name, 'mark').find((entry) => origin + entry.startTime >= after);
      return [key, mark ? origin + mark.startTime : null];
    }),
  );
}

const tenth = (ms) => Math.round(ms * 10) / 10;
const between = (from, to) => (from === null || to === null ? null : tenth(to - from));

async function preparePage(rig, where, trial) {
  const { worker, workerSession, seed, inputs, source, page, targetId, parkId } = rig;
  await worker.evaluate(
    async (activate, source) => {
      const { tabs, windows } = globalThis.chrome;
      await tabs.update(activate, { active: true });
      await windows.update(source.windowId, { focused: true });
      await tabs.update(source.id, { active: true });
    },
    where.cross ? parkId : targetId,
    { id: source.id, windowId: source.windowId },
  );
  await page.bringToFront();
  await page.reload({ waitUntil: 'load' });
  const target = await worker.evaluate(
    async (input, rows, early, discard, targetId, sourceId) => {
      const { tabs, scripting } = globalThis.chrome;
      if (discard) await tabs.discard(targetId);
      const { active, windowId, discarded, status } = await tabs.get(targetId);
      await scripting.executeScript({
        target: { tabId: sourceId, frameIds: [0] },
        world: 'ISOLATED',
        func: () => 0,
      });
      input.configure(rows, early);
      return { active, windowId, discarded, status };
    },
    inputs,
    trial.padding,
    trial.release === 'before-listen',
    trial.discarded,
    targetId,
    source.id,
  );
  assert.equal(target.windowId, where.windowId, 'Target fixture is in the wrong window');
  assert(!target.active && target.discarded === trial.discarded, 'Expected an inactive target in the requested state');
  if (!trial.discarded) assert.equal(target.status, 'complete', 'Live target is still loading');
  if (where.cross) {
    // A real focus change to the parking tab would make it newer than the inactive target. Seed only the history
    // through the worker callback before the measured press. The snapshot reads actual Chrome tab activity.
    const reply = await workerSession.send('Runtime.callFunctionOn', {
      objectId: seed,
      functionDeclaration: 'function(info){this(info)}',
      arguments: [{ value: { tabId: targetId, windowId: where.windowId } }],
    });
    assert(!reply.exceptionDetails, 'Could not seed target recency');
  }
  assert(await page.evaluate(() => document.hasFocus()), 'Source fixture does not have document focus');
}

function measure(command, marks, gesture) {
  return {
    atMs: Object.fromEntries(Object.entries(marks).map(([name, value]) => [name, between(command, value)])),
    ms: {
      commandToListen: between(command, marks.listening),
      dispatchToPage: between(marks.dispatch, marks.keyup),
      keyupToHost: between(marks.keyup, marks.releaseSeen),
      hostReleaseToSwitch: between(marks.releaseSeen, marks.switchRequested),
      hostPostToSwitch: between(marks.releasePosted, marks.switchRequested),
      keyupToSwitch: between(marks.keyup, marks.switchRequested),
      keyupToActivated: between(marks.keyup, marks.activated),
      switchToActivated: between(marks.switchRequested, marks.activated),
      getTarget: between(marks.switchRequested, marks.tabUpdate),
      updateTab: between(marks.tabUpdate, marks.tabUpdated),
      focusWindow: between(marks.focusRequested, marks.switchSettled),
      switchToSettled: between(marks.switchRequested, marks.switchSettled),
      cutToSettled: between(marks.overlayCut, marks.switchSettled),
      removedToSettled: between(marks.overlayRemoved, marks.switchSettled),
      activatedToTargetComplete: between(marks.activated, marks.targetComplete),
    },
    worker: {
      gateWaited: gesture.gateWaited,
      prepared: gesture.prepared,
      stepped: gesture.stepped ?? null,
      attempts: gesture.attempts ?? [],
      dwellDue: gesture.dwellDue ?? null,
      dwell: gesture.dwell ?? null,
      idleDue: gesture.idleDue ?? null,
      deadline: gesture.deadline ?? null,
      end: gesture.end,
      reason: gesture.reason,
      result: gesture.target?.result ?? null,
      releaseIngress: gesture.events?.find(({ e, stale }) => e === 'release' && !stale)?.at ?? null,
      timers: (gesture.events ?? []).filter(({ e }) => e === 'timer' || e === 'expire' || e === 'ping'),
      input: gesture.input ?? null,
    },
  };
}

export async function runTapTrial(rig, where, trial, signal) {
  const { page, id, worker, inputs, targetId } = rig;
  await preparePage(rig, where, trial);
  const session = await page.createCDPSession();
  try {
    const context = await extensionWorld(session, id);
    const own = (fn, ...args) =>
      evaluateCDP(session, '(' + fn.toString() + ')(...' + JSON.stringify(args) + ')', context);
    await own(armKeyup, BENCH_ARMED, PAGE_KEYUP, META);
    const command = await own(requestCommand, BENCH_MARK.request, BENCH_TAP);
    assert(Number.isFinite(command), 'The switch command entry did not acknowledge the fixture message');
    if (trial.release === 'shown') await own(waitForMark, BENCH_MARK.frame);
    const remaining = command + (trial.delayMs ?? 0) - stamp();
    if (remaining > 0) await pause(Math.ceil(remaining), undefined, { signal });
    signal.throwIfAborted();
    const dispatch = stamp();
    await session.send('Input.dispatchKeyEvent', metaUp);
    if (trial.release === 'before-listen') {
      await own(waitForMark, PAGE_KEYUP);
      await worker.evaluate((input) => input.allowInjection(), inputs);
    }
    const gesture = await worker.evaluate(waitForGesture, TIMING_KEY, command, HOLD_IDLE_MS + 6000);
    const marks = {
      ...(await own(readMarks, pageMarks)),
      ...(await worker.evaluate(readMarks, workerMarks, command)),
      dispatch,
    };
    if (trial.release === 'before-listen') {
      assert(marks.keyup !== null && marks.releaseSeen === null, 'The early keyup reached the host');
      assert(marks.listening === null || marks.keyup < marks.listening, 'Early keyup did not precede listeners');
    }
    if (gesture.outcome !== 'dropped') {
      assert.equal(gesture.initial?.tabId, targetId, 'Gesture did not start on the intended switch target');
      assert.equal(gesture.tabs, rig.fixtures.length + trial.padding, 'Gesture did not receive the intended row count');
    }
    const after = await worker.evaluate(async (tabId) => {
      const { active, status, discarded } = await globalThis.chrome.tabs.get(tabId);
      return { active, status, discarded };
    }, targetId);
    if (marks.activated !== null)
      assert(gesture.target?.tabId === targetId && after.active, 'Chrome activated an unexpected tab');
    return { ...measure(command, marks, gesture), after };
  } finally {
    await session.detach();
  }
}
