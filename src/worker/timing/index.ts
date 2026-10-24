// Gesture timing log, measurement builds only (`just build-timing`); null in release builds, which drop every hook.
// The worker shell's hooks feed the gesture log with clock times; finished records go to a ring buffer in
// storage.local, written once no gesture is live. Hooks never await, throw or change what they observe.

import {
  TIMING_KEY,
  TIMING_MAX,
  onTimingChanged,
  readTiming,
  type GestureRecord,
  type TimingRecord,
} from '../../browser/timing.ts';
import type { AttemptId, CoreEvent, DeclineReason, Model, Step } from '../../core/index.ts';
import { clock } from '../adapters/clock/index.ts';
import { fault } from '../diagnostics.ts';
import { createGestureLog } from './record.ts';

const WRITE_AFTER_MS = 2_000; // after the latest gesture ends, so writes stay off the gesture path

export interface Timing {
  gate(): void;
  prepared(event: CoreEvent | null): void;
  dropped(entry: GestureRecord['entry'], at: number): void;
  launched(attempt: AttemptId): void;
  declined(attempt: AttemptId, reason: DeclineReason): void;
  stepped(before: Model, event: CoreEvent, after: Step): void;
}

function createTiming(): Timing {
  let on = true; // until the stored switch is read
  let records: TimingRecord[] | null = null; // null until the stored log is read; earlier records wait in early
  let early: TimingRecord[] = [];
  let pending: ReturnType<typeof setTimeout> | undefined;

  const add = (list: TimingRecord[], more: readonly TimingRecord[]) => [...list, ...more].slice(-TIMING_MAX);

  function write(): void {
    if (!records) return;
    if (log.live()) {
      schedule();
      return;
    }
    // Chrome walks nested objects synchronously before returning the promise. A bounded JSON string avoids that
    // expensive traversal; a press that arrives during this save waits about 1 ms in the storage probe.
    chrome.storage.local.set({ [TIMING_KEY]: JSON.stringify(records) }).catch(fault);
  }

  function schedule(): void {
    clearTimeout(pending);
    pending = setTimeout(write, WRITE_AFTER_MS);
  }

  const log = createGestureLog(performance.timeOrigin, (record) => {
    if (records) records = add(records, [record]);
    else early.push(record);
    schedule();
  });

  function stop(): void {
    on = false;
    log.drop();
    early = [];
  }

  readTiming().then((state) => {
    if (!state.on) stop();
    records = add(state.records, early);
    if (early.length > 0) schedule();
    early = [];
  }, fault);

  onTimingChanged(({ cleared, on: next }) => {
    if (cleared) {
      records &&= [];
      early = [];
    }
    if (next === false) stop();
    else if (next) on = true;
  });

  // Every hook is guarded: a fault here never reaches the step that called it.
  const guard =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A): void => {
      if (!on) return;
      try {
        fn(...args);
      } catch (error) {
        fault(error);
      }
    };

  return {
    gate() {
      log.gate(clock.now()); // kept while off too, so a later press still knows the gate
    },
    prepared: guard((event) => {
      log.prepared(event, clock.now());
    }),
    dropped: guard((entry, at) => {
      log.dropped(entry, at, clock.now());
    }),
    launched: guard((attempt) => {
      log.launched(attempt, clock.now());
    }),
    declined: guard((attempt, reason) => {
      log.declined(attempt, reason);
    }),
    stepped: guard((before, event, after) => {
      log.stepped(before, event, after, clock.now());
    }),
  };
}

// Tested inline so release builds drop the log code (src/browser/timing.ts).
export const timing: Timing | null = import.meta.env.MODE === 'timing' ? createTiming() : null;
