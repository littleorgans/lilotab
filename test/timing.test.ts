/// <reference lib="dom" />

// Gesture timing log, measurement builds only: one record per gesture from the real core's steps, with times as ms
// after the press. The interaction harness's press is at 1000; each step here runs 1 ms after its event's at.

import { expect, onTestFinished, test, vi } from 'vite-plus/test';
import { readTiming, TIMING_KEY, TIMING_MAX, type ProbeEvent, type TimingRecord } from '../src/browser/timing.ts';
import { init, step, type CoreEvent, type DeclineReason, type Effect, type Settings } from '../src/core/index.ts';
import { createGestureLog } from '../src/worker/timing/record.ts';
import { createProbe } from '../src/hosts/popup/probe.ts';
import {
  LIVE,
  STORED,
  esc,
  focus,
  move,
  press,
  ready,
  release,
  status,
  tick,
  win,
  type Ev,
} from './interaction-harness.ts';

const ORIGIN = 1_700_000_000_000;

function setup(settings: Partial<Settings> = {}) {
  const records: TimingRecord[] = [];
  const touched = vi.fn();
  const log = createGestureLog(ORIGIN, (r) => records.push(r), touched);
  const ctx = {
    model: init('boot', undefined, { ...STORED, ...settings }, LIVE.two).model,
    live: LIVE.two,
    last: null as string | null,
    effects: [] as readonly Effect[],
  };
  const event = (ev: Ev): CoreEvent => ev(ctx);
  const run = (e: CoreEvent) => {
    const before = ctx.model;
    const after = step(before, e);
    ctx.model = after.model;
    ctx.effects = after.effects;
    ctx.last = after.model.interaction?.id ?? ctx.last;
    log.stepped(before, e, after, e.at + 1);
  };
  const attempt = (n: number) => `boot:1:${String(n)}`;
  const decline = (n: number, reason: DeclineReason) => {
    log.declined(attempt(n), reason);
  };
  return { records, log, event, run, attempt, decline, touched, ctx };
}

test('a quick tap after ready: prepared, launched and ready times, then a quick tap commit', () => {
  const { records, log, event, run, attempt } = setup();
  log.gate(500);
  const tap = event(press(0));
  log.prepared(tap, 1004);
  run(tap);
  log.launched(attempt(1), 1009);
  run(event(ready(20)));
  run(event(release(30)));
  expect(records).toEqual([
    {
      epoch: ORIGIN + 1000,
      entry: 'shortcut',
      holdDelayMs: 50,
      quickTap: 'flip',
      page: 'http',
      tabs: 7,
      windows: 2,
      workerAge: 1000,
      firstOfBoot: true,
      gateWaited: false,
      prepared: 4,
      stepped: 1,
      source: { tabId: 11, windowId: 1 },
      focus: null,
      lastFocused: null,
      prevTarget: null,
      initial: { tabId: 11, windowId: 1 },
      attempts: [{ host: 'overlay', start: 1, launched: 9, ready: 20, declined: null }],
      dwellDue: 50,
      dwell: null,
      shown: null,
      input: { at: 30, kind: 'release', input: 'release', inferred: false },
      presses: 0,
      pressAt: null,
      unheardPress: false,
      deadline: null,
      idleDue: null,
      events: [
        { at: 20, e: 'ready', state: 'overlayPending' },
        { at: 30, e: 'release', state: 'ready' },
      ],
      eventsLost: 0,
      target: null,
      outcome: 'commit',
      switched: false,
      reason: 'quickTap',
      end: 31,
    },
  ]);
});

// C-HOLD-12, C-POP-07: the release came before the popup listened, so the list shows and stays, with no idle in the
// popup (C-HOLD-13), until the next unheld input commits it.
test('a declined overlay, a late popup and a list with no host input until an inferred release commits it', () => {
  const { records, event, run, decline } = setup();
  run(event(press(0)));
  decline(1, 'unfocused');
  run(event(status(10, 'declined')));
  run(event(ready(150)));
  run(event(press(400)));
  run(event(tick(10_400)));
  run(event(release(10_500, true)));
  expect(records).toMatchObject([
    {
      gateWaited: true,
      attempts: [
        { host: 'overlay', start: 1, ready: null, declined: { reason: 'unfocused', at: 10 } },
        { host: 'popup', start: 11, ready: 150, declined: null },
      ],
      dwell: 151,
      shown: 151,
      input: { at: 10_500, input: 'release', inferred: true },
      presses: 1,
      pressAt: 400,
      unheardPress: true,
      idleDue: null,
      outcome: 'commit',
      reason: 'inferredRelease',
      end: 10_501,
    },
  ]);
});

// Expiry precedes the event row: a late release cannot become a quick tap or erase an idle cancellation.
test('a release that expires dwell is labelled release, and one after idle is not counted as input', () => {
  const { records, event, run } = setup();
  run(event(press(0)));
  run(event(ready(20)));
  run(event(release(60)));
  expect(records[0]).toMatchObject({ shown: 61, outcome: 'commit', reason: 'release' });
  run(event(press(100)));
  run(event(ready(170)));
  run(event(release(10_171)));
  expect(records[1]).toMatchObject({ shown: 71, input: null, outcome: 'cancel', reason: 'idle' });
  run(event(press(20_000)));
  run(event(ready(20_020)));
  run(event(release(30_100))); // dwell shows the list, then the idle it starts expires before the release
  expect(records[2]).toMatchObject({ input: null, outcome: 'cancel', reason: 'idle' });
});

// AC-02: preparation timed out before an interaction existed; only observed worker times are available.
test('a dropped preparation produces a minimal record on the press clock', () => {
  const { records, log } = setup();
  log.gate(1200);
  log.dropped('shortcut', 1000, 1250);
  expect(records).toEqual([
    {
      epoch: ORIGIN + 1000,
      entry: 'shortcut',
      workerAge: 1000,
      firstOfBoot: true,
      gateWaited: true,
      prepared: 250,
      outcome: 'dropped',
      reason: 'prepTimeout',
      end: 250,
    },
  ]);
});

// The persisted form stays compact, while the reader also accepts and bounds older array logs.
test('saved JSON and legacy arrays read back as bounded export records', async () => {
  const record = { outcome: 'dropped', reason: 'prepTimeout', epoch: ORIGIN };
  const records = Array.from({ length: TIMING_MAX + 1 }, (_, n) => ({ ...record, epoch: ORIGIN + n }));
  let stored: unknown = JSON.stringify(records);
  const get = vi.fn(() => Promise.resolve({ [TIMING_KEY]: stored }));
  vi.stubGlobal('chrome', { storage: { local: { get } } });
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  expect((await readTiming()).records).toEqual(records.slice(-TIMING_MAX));
  stored = records;
  expect((await readTiming()).records).toEqual(records.slice(-TIMING_MAX));
});

// Repeats before the host shows the list are ordinary stepping, with no evidence of a missed input.
test('a repeat before the list shows is distinguishable from a retry, and Escape is key input', () => {
  const { records, event, run } = setup();
  run(event(press(0)));
  run(event(press(10)));
  run(event(ready(60)));
  run(event(release(70)));
  expect(records[0]).toMatchObject({ pressAt: 10, shown: 61, unheardPress: false });
  run(event(press(100)));
  run(event(ready(160)));
  run(event(esc(170)));
  expect(records[1]).toMatchObject({ input: { kind: 'key', input: 'cancel' }, outcome: 'cancel', reason: 'key' });
});

// The popup's own trace on its clock, which started 40 ms after the press: a Meta keyup before the session listened,
// a move the session heard, no idle in the popup (C-HOLD-13), then Escape cancels, and a focus move and the closing
// page after the end.
test('a popup trace lines up with the timeline and reaches the record after its end', () => {
  const { records, log, event, run, attempt, touched, ctx } = setup({ listSurface: 'popup' });
  run(event(focus(-300, 2)));
  run(event(press(0)));
  log.lastFocused('boot:1', { windowId: 2, type: 'normal', focused: true }, 1010);
  const key = (at: number, t: ProbeEvent['t'], heard: string | null): ProbeEvent => {
    const facts = { key: 'Meta', code: 'MetaLeft', meta: t === 'keydown', ctrl: false, alt: false, repeat: false };
    return { at, t, stamp: at - 1, ...facts, focus: true, visible: true, heard };
  };
  const probe = (m: object) =>
    log.probe({ t: 'timingProbe', attempt: attempt(1), origin: ORIGIN + 1040, events: [], ...m });
  expect(probe({ start: { at: 5, focus: false, visible: true }, focusing: { at: 20, focus: false } })).toBe(true);
  expect(
    probe({ focused: 50, windows: [{ at: 52, windowId: 1, focused: true }], events: [key(30, 'keyup', null)] }),
  ).toBe(true);
  run(event(ready(91)));
  run(event(move(200, 1)));
  run(event(tick(10_200)));
  run(event(esc(10_250)));
  run(event(focus(10_300, 1)));
  expect(probe({ closed: 9_170 })).toBe(true);
  expect(touched).toHaveBeenCalled();
  expect(records[0]).toMatchObject({
    source: { tabId: 11, windowId: 1 },
    focus: { windowId: 2, ago: 300 },
    lastFocused: { windowId: 2, focused: true, at: 10 },
    attempts: [
      {
        host: 'popup',
        why: 'setting',
        windowId: 1,
        ready: 91,
        popup: {
          start: { at: 45, focus: false, visible: true },
          focusing: { at: 60, focus: false },
          focused: 90,
          closed: 9_210,
          windows: [{ at: 92, windowId: 1, focused: true }],
          events: [{ at: 70, stamp: 69, t: 'keyup', key: 'Meta', heard: null }],
          lost: 0,
        },
      },
    ],
    events: [
      { at: 50, e: 'expire', timer: 'dwell' },
      { at: 91, e: 'ready', state: 'popupPending' },
      { at: 200, e: 'move', state: 'holding' },
      { at: 10_200, e: 'timer', timer: 'idle', state: 'holding' },
      { at: 10_250, e: 'cancel', state: 'holding' },
      { at: 10_300, e: 'focus', windowId: 1 },
    ],
    idleDue: null,
    input: { at: 200, input: 'move' },
    outcome: 'cancel',
    reason: 'key',
  });
  run(event(press(20_000)));
  run(event(ready(20_020)));
  run(event(win(20_100, 1)));
  run(event(release(20_200)));
  const activate = ctx.effects.find((e) => e.kind === 'activate');
  if (activate?.kind !== 'activate') throw new Error('no activation');
  run({ kind: 'activated', at: 21_250, op: activate.op, target: activate.target, result: 'focusFailed' });
  expect(records[1]).toMatchObject({
    prevTarget: null,
    target: { ...activate.target, focusWindow: true, result: 'focusFailed', resultAt: 250 },
    outcome: 'commit',
  });
});

// read-window S4: a cross window activation may settle after the next gesture has started.
test('an overlapping activation result stays with its originating gesture after its tail ends', () => {
  const { records, event, run, ctx } = setup({ listSurface: 'popup' });
  run(event(press(0)));
  run(event(ready(60)));
  run(event(win(100, 1)));
  run(event(release(120)));
  const activate = ctx.effects.find((e) => e.kind === 'activate');
  if (activate?.kind !== 'activate') throw new Error('no activation');
  run(event(press(130)));
  run({ kind: 'activated', at: 1200, op: activate.op, target: activate.target, result: 'focusFailed' });
  run(event(ready(210)));
  run(event(release(220)));
  expect(records[0]).toMatchObject({ target: { ...activate.target, result: 'focusFailed', resultAt: 200 } });
  expect(records[1]).toMatchObject({ prevTarget: activate.target, target: null });
});

// Injection and popup errors can contain quoted titles or addresses without ://.
test('launch failures retain a safe error category without page text', () => {
  const { records, log, event, run, attempt } = setup({ listSurface: 'popup' });
  run(event(press(0)));
  log.failed(attempt(1), new Error("Cannot open 'Private report' at about:private#secret"));
  run(event(ready(60)));
  run(event(release(70)));
  expect(records[0]).toMatchObject({ attempts: [{ error: 'Error' }] });
  expect(JSON.stringify(records)).not.toMatch(/Private report|about:|secret/);
});

// A full trace is much larger than the original timing summary. Exercise the actual worker storage write.
test('a saturated timing log writes a bounded recent history while no gesture is live', async () => {
  const { records, log, event, run, attempt } = setup({ listSurface: 'popup' });
  run(event(press(0)));
  run(event(ready(60)));
  for (let at = 61; at < 220; at++) run(event(press(at)));
  run(event(release(220)));
  log.probe({
    t: 'timingProbe',
    attempt: attempt(1),
    origin: ORIGIN + 1040,
    events: Array.from({ length: 120 }, (_, at) => ({
      at,
      t: 'keydown',
      key: 'ArrowDown',
      code: 'ArrowDown',
      meta: true,
      ctrl: false,
      alt: false,
      shift: false,
      repeat: false,
      stamp: at,
      focus: true,
      visible: true,
      heard: 'consume post:move',
    })),
  });
  const history = Array.from({ length: TIMING_MAX }, (_, epoch) => ({ ...records[0], epoch }));
  const set = vi.fn((_value: Record<string, string>) => Promise.resolve());
  vi.useFakeTimers();
  vi.stubEnv('MODE', 'timing');
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: () => Promise.resolve({ [TIMING_KEY]: JSON.stringify(history) }), set },
      onChanged: { addListener: vi.fn() },
    },
  });
  onTestFinished(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });
  vi.resetModules();
  const { timing } = await import('../src/worker/timing/index.ts');
  await vi.advanceTimersByTimeAsync(0);
  timing?.dropped('shortcut', 0);
  await vi.advanceTimersByTimeAsync(2000);
  expect(set).toHaveBeenCalledOnce();
  const json = set.mock.calls[0]?.[0][TIMING_KEY] ?? '';
  expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(256 * 1024);
  const saved = JSON.parse(json) as TimingRecord[];
  expect(saved.at(-2)).toMatchObject({ epoch: TIMING_MAX - 1 });
  expect(saved.at(-1)).toMatchObject({ outcome: 'dropped' });
});

// Diagnostic transport must let the session call window.close even if Chrome rejects the probe send.
test('the popup closes before its final probe send and transport errors stay outside the session', async () => {
  const calls: string[] = [];
  vi.useFakeTimers();
  const popupWindow = {
    addEventListener: vi.fn(),
    close: () => {
      calls.push('close');
    },
  };
  vi.stubGlobal('window', popupWindow);
  vi.stubGlobal('document', { addEventListener: vi.fn(), hasFocus: () => true, visibilityState: 'visible' });
  vi.stubGlobal('chrome', {
    windows: { getCurrent: () => Promise.reject(new Error('unavailable')) },
    runtime: {
      sendMessage: () => {
        calls.push('send');
        throw new Error('context invalidated');
      },
    },
  });
  onTestFinished(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const probe = createProbe('attempt');
  probe.focusing();
  probe.focused();
  expect(() => {
    probe.closed();
    popupWindow.close();
  }).not.toThrow();
  expect(calls).toEqual(['close']);
  await vi.runAllTimersAsync();
  expect(calls).toEqual(['close', 'send']);
});
