// Clock.now() and one timer handle per interaction and timer kind (03-components 3.2, 05-events 2.2, 2.3).

import type { Clock, InteractionId, Millis, Sink, TimerKind, Timers } from '../../../core/index.ts';

// Monotonic within one worker boot; Date.now() never enters the core (05 2.2).
export const clock: Clock = { now: () => performance.now() };

export type Settled<T> = { ok: true; value: T } | { ok: false; cause: 'timeout' | 'rejected' };

// The value if p settles before until, else a failure; a late result is discarded (05 2.4 budget).
export function settleBy<T>(p: Promise<T>, until: Millis): Promise<Settled<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => {
        resolve({ ok: false, cause: 'timeout' });
      },
      Math.max(0, until - clock.now()),
    );
    p.then(
      (value) => {
        clearTimeout(timer);
        // Promise jobs can run after the budget but before the timeout's task (05 2.4).
        resolve(clock.now() < until ? { ok: true, value } : { ok: false, cause: 'timeout' });
      },
      () => {
        clearTimeout(timer);
        resolve({ ok: false, cause: 'rejected' });
      },
    );
  });
}

// A cancelled or replaced handle never fires; an early firing rearms for the remainder, so a timer event's at is at
// least its due (05 2.3). Timers never keep the worker alive.
export function createTimers(sink: Sink): Timers {
  const handles = new Map<string, ReturnType<typeof setTimeout>>();
  const keyOf = (id: InteractionId, timer: TimerKind) => `${id}|${timer}`;

  function arm(id: InteractionId, timer: TimerKind, due: Millis): void {
    const key = keyOf(id, timer);
    const fire = () => {
      handles.delete(key);
      if (clock.now() < due) {
        arm(id, timer, due);
        return;
      }
      sink((at) => ({ kind: 'timer', at, id, timer }));
    };
    handles.set(key, setTimeout(fire, Math.max(0, due - clock.now())));
  }

  const cancel = (id: InteractionId, timer: TimerKind) => {
    const key = keyOf(id, timer);
    clearTimeout(handles.get(key));
    handles.delete(key);
  };

  return {
    start(id, timer, due) {
      cancel(id, timer);
      arm(id, timer, due);
    },
    cancel,
  };
}
