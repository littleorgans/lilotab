// The worker's one door for every input (05-events 2.1): seq and at are taken synchronously, before any await;
// the drain steps entries strictly in seq order, after the init gate, waiting only on the head's preparation.

import type { Clock, CoreEvent, Millis } from '../core/index.ts';
import { fault } from './diagnostics.ts';
import { timing } from './timing/index.ts';

type Prepared = CoreEvent | null | Promise<CoreEvent | null>;

// The core Sink, which it satisfies, with the entry's seq too: the clear request's id is its ingress seq (03 4.2 RequestId).
export type Ingress = (prepare: (at: Millis, seq: number) => Prepared) => void;

// Async preparations settle by their own at plus the budget (entry and storage adapters), so a slow head delays later
// entries by at most that (05 2.4). A preparation that throws or rejects steps nothing.
export function createIngress(clock: Clock, gate: Promise<unknown>, apply: (event: CoreEvent) => void): Ingress {
  let seq = 0;
  const queue: Promise<CoreEvent | null>[] = [];
  let draining = false;

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    await gate;
    for (let head = queue.shift(); head; head = queue.shift()) {
      const event = await head;
      try {
        if (event) apply(event);
      } catch (error) {
        fault(error);
      }
    }
    draining = false;
  }

  return (prepare) => {
    seq += 1;
    const at = clock.now();
    let event: Promise<CoreEvent | null>;
    try {
      event = Promise.resolve(prepare(at, seq)).catch((error: unknown) => {
        fault(error);
        return null;
      });
    } catch (error) {
      fault(error);
      event = Promise.resolve(null);
    }
    // A side branch: the drain still awaits event itself.
    if (timing) {
      void event.then((prepared) => {
        timing?.prepared(prepared);
      });
    }
    queue.push(event);
    void drain();
  };
}
