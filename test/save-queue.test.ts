// TB-09 saveQueue.step (07-tests 2.1): which answer "Clear now" gets as recents saves (C-DATA-09, 06-data 5).

import { describe, expect, it } from 'vite-plus/test';
import {
  IDLE_QUEUE,
  SESSION_VERSION,
  saveStep,
  type RequestId,
  type SaveEffect,
  type SaveInput,
  type SaveQueue,
  type SessionEnvelope,
} from '../src/core/index.ts';

const envelope = (used: number): SessionEnvelope => ({ version: SESSION_VERSION, tabs: [[1, 1, used]], windows: [] });
const checkpoint = (used: number, reply: RequestId | null = null): SaveInput => ({
  kind: 'checkpoint',
  envelope: envelope(used),
  reply,
});
const failed: SaveInput = { kind: 'failed', quota: false };

const answers = (effects: readonly SaveEffect[]) =>
  effects.flatMap((e) => (e.kind === 'answer' ? [{ request: e.request, ok: e.ok }] : []));

// Steps the inputs, then lets storage settle every later write the same way, retries included, until the queue idles.
function run(inputs: readonly SaveInput[], storage: 'saves' | 'fails') {
  let queue: SaveQueue = IDLE_QUEUE;
  const effects: SaveEffect[] = [];
  const step = (input: SaveInput) => {
    const next = saveStep(queue, input);
    queue = next.queue;
    effects.push(...next.effects);
  };
  inputs.forEach(step);
  while (queue.state !== 'idle') {
    if (queue.state === 'waiting') step({ kind: 'retryDue' });
    else step(storage === 'saves' ? { kind: 'saved' } : failed);
  }
  return answers(effects);
}

describe('TB-09 saveQueue.step', () => {
  it.each<{ name: string; inputs: SaveInput[]; storage: 'saves' | 'fails'; expected: object[] }>([
    {
      name: 'C-DATA-09 the cleared history saved answers the clear ok',
      inputs: [checkpoint(1, 7)],
      storage: 'saves',
      expected: [{ request: 7, ok: true }],
    },
    {
      name: 'C-DATA-09 a save that ultimately fails answers the clear not ok',
      inputs: [checkpoint(1, 7)],
      storage: 'fails',
      expected: [{ request: 7, ok: false }],
    },
    {
      name: 'C-DATA-09 a newer checkpoint during a failing write answers the clear when it saves',
      inputs: [checkpoint(1, 7), checkpoint(2), failed],
      storage: 'saves',
      expected: [{ request: 7, ok: true }],
    },
    {
      name: 'C-DATA-05 C-DATA-09 a newer checkpoint during a retry wait answers the clear when it saves',
      inputs: [checkpoint(1, 7), failed, checkpoint(2)],
      storage: 'saves',
      expected: [{ request: 7, ok: true }],
    },
  ])('$name', ({ inputs, storage, expected }) => {
    expect(run(inputs, storage)).toEqual(expected);
  });
});
