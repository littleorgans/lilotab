// Gesture timing log, measurement builds only (`just build-timing`); null in release builds, which drop every hook.
// The worker shell's hooks feed the gesture log with clock times; finished records go to a ring buffer in
// storage.local, written once no gesture is live. Hooks never await, throw or change what they observe. The popup
// page's probe (src/hosts/popup/probe.ts) sends its trace by runtime message; the host link passes it on.

import {
  TIMING_KEY,
  TIMING_MAX,
  onTimingChanged,
  readTiming,
  type GestureRecord,
  type ProbeMessage,
  type TimingRecord,
} from '../../browser/timing.ts';
import type { AttemptId, CoreEvent, DeclineReason, Model, Step } from '../../core/index.ts';
import { clock } from '../adapters/clock/index.ts';
import { fault } from '../diagnostics.ts';
import { createGestureLog } from './record.ts';

const WRITE_AFTER_MS = 2_000; // after the latest gesture ends, so writes stay off the gesture path
const WRITE_BYTES_MAX = 256 * 1024; // trace counts alone permit writes larger than storage.local's quota

export interface Timing {
  gate(): void;
  prepared(event: CoreEvent | null): void;
  dropped(entry: GestureRecord['entry'], at: number): void;
  launched(attempt: AttemptId): void;
  declined(attempt: AttemptId, reason: DeclineReason): void;
  failed(attempt: AttemptId, error: unknown): void;
  probe(message: unknown, fromPopup: (attempt: AttemptId) => boolean): void; // fromPopup: the sender check (05 4.3)
  stepped(before: Model, event: CoreEvent, after: Step): void;
}

const isProbe = (m: unknown): m is ProbeMessage =>
  typeof m === 'object' && m !== null && (m as { t?: unknown }).t === 'timingProbe';

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
    // Serialize only as much recent history as fits. Chrome also copies this string synchronously, so bound both
    // costs; serializing the whole history before trimming would still block an arriving press.
    const recent: string[] = [];
    const encoder = new TextEncoder();
    let bytes = 2; // brackets
    for (let n = records.length - 1; n >= 0; n--) {
      const json = JSON.stringify(records[n]);
      const size = encoder.encode(json).length + (recent.length > 0 ? 1 : 0);
      if (bytes + size > WRITE_BYTES_MAX) break;
      recent.push(json);
      bytes += size;
    }
    records = records.slice(records.length - recent.length);
    chrome.storage.local.set({ [TIMING_KEY]: `[${recent.reverse().join(',')}]` }).catch(fault);
  }

  function schedule(): void {
    clearTimeout(pending);
    pending = setTimeout(write, WRITE_AFTER_MS);
  }

  const log = createGestureLog(
    performance.timeOrigin,
    (record) => {
      if (records) records = add(records, [record]);
      else early.push(record);
      schedule();
    },
    schedule,
  );

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
    failed: guard((attempt, error) => {
      log.failed(attempt, error);
    }),
    probe: guard((message, fromPopup) => {
      if (isProbe(message) && fromPopup(message.attempt) && log.probe(message)) schedule();
    }),
    // Chrome's own last focused window, read once a gesture began, so the read never contends with its preparation.
    stepped: guard((before, event, after) => {
      const began = log.stepped(before, event, after, clock.now());
      if (began === null) return;
      chrome.windows.getLastFocused().then(({ id, type, focused }) => {
        if (id !== undefined) log.lastFocused(began, { windowId: id, type: type ?? 'normal', focused }, clock.now());
      }, fault);
    }),
  };
}

// Tested inline so release builds drop the log code (src/browser/timing.ts).
export const timing: Timing | null = import.meta.env.MODE === 'timing' ? createTiming() : null;
