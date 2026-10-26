// Popup page probe, measurement builds only (`just build-timing`): the popup page creates it behind its inline build
// mode test, so release builds drop it and every hook.
// From the page's first script, before the session listens, it traces every trusted keydown and keyup at window
// capture, focus, blur and visibility, and what the session made of each key, then sends the trace to the worker's
// gesture log (src/worker/timing/) once per task. Its listeners only read: they never prevent, stop or move focus.

import type { ProbeEvent, ProbeMessage } from '../../browser/timing.ts';
import type { HostEffect } from '../../core/index.ts';

export interface Probe {
  focusing(): void; // the start view painted; the wait for focus begins
  focused(): void; // focus resolved; the session listens and posts ready in the same task
  sensed: (e: Event, effects: readonly HostEffect[]) => void; // the session's hook (Host.sensed)
  closed(): void; // records before window.close(); sends after it, at the task's microtask checkpoint
}

const label = (f: HostEffect): string =>
  f.kind !== 'post'
    ? f.kind
    : f.input.kind === 'release' && f.input.inferred
      ? 'post:inferredRelease'
      : `post:${f.input.kind}`;

export function createProbe(attempt: string): Probe {
  let batch: ProbeMessage | null = null;
  let listening = false;
  const keys = new WeakMap<Event, ProbeEvent>(); // this task's key entries, which the session may still classify

  function flush(): void {
    if (!batch) return;
    const message = batch;
    batch = null;
    try {
      chrome.runtime.sendMessage(message).catch(() => undefined);
    } catch {
      // A closing extension context can reject synchronously too; diagnostics never interrupt the session.
    }
  }

  // After the event's whole dispatch, so the session's classification is in.
  function current(): ProbeMessage {
    if (!batch) {
      batch = { t: 'timingProbe', attempt, origin: performance.timeOrigin, events: [] };
      setTimeout(flush, 0);
    }
    return batch;
  }

  const facts = () => ({ focus: document.hasFocus(), visible: document.visibilityState === 'visible' });

  function record(e: Event, entry: Omit<ProbeEvent, 'at' | 'stamp' | 'focus' | 'visible' | 'heard'>): ProbeEvent {
    const event: ProbeEvent = { at: performance.now(), stamp: e.timeStamp, ...entry, ...facts(), heard: null };
    current().events.push(event);
    return event;
  }

  for (const t of ['keydown', 'keyup'] as const) {
    window.addEventListener(
      t,
      (e) => {
        if (!e.isTrusted) return;
        const { key, code, metaKey: meta, ctrlKey: ctrl, altKey: alt, shiftKey: shift, repeat } = e;
        const event = record(e, { t, key, code, meta, ctrl, alt, shift, repeat });
        if (listening) {
          event.heard = 'none';
          keys.set(e, event);
        }
      },
      { capture: true },
    );
  }
  for (const t of ['focus', 'blur'] as const) {
    window.addEventListener(
      t,
      (e) => {
        if (e.isTrusted) record(e, { t, window: e.target === window });
      },
      { capture: true },
    );
  }
  document.addEventListener(
    'visibilitychange',
    (e) => {
      if (e.isTrusted) record(e, { t: 'visibilitychange' });
    },
    { capture: true },
  );
  window.addEventListener(
    'pagehide',
    (e) => {
      if (e.isTrusted) record(e, { t: 'pagehide' });
    },
    { capture: true },
  );

  // The browser window this popup belongs to, and whether Chrome calls it focused; the session waits for none of it.
  function readWindow(): void {
    chrome.windows.getCurrent().then(
      ({ id, focused }) => {
        if (id !== undefined) (current().windows ??= []).push({ at: performance.now(), windowId: id, focused });
      },
      () => undefined,
    );
  }

  current().start = { at: performance.now(), ...facts() };
  readWindow();

  return {
    focusing() {
      current().focusing = { at: performance.now(), focus: document.hasFocus() };
    },
    focused() {
      listening = true;
      current().focused = performance.now();
      readWindow();
    },
    sensed: (e, effects) => {
      const event = keys.get(e);
      if (!event || effects.length === 0) return;
      const heard = effects.map(label).join(' ');
      event.heard = event.heard === 'none' ? heard : `${String(event.heard)} ${heard}`;
    },
    closed() {
      listening = false;
      current().closed = performance.now();
      queueMicrotask(flush); // window.close() runs first; do not serialize or send on its path
    },
  };
}
