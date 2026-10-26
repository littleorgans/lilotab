// Recents persistence rules: which envelope to write, retries and supersession (06-data 5.1).
// The storage adapter holds the queue value, performs write and wait, and reports results.

import type { SessionEnvelope } from '../recents/index.ts';
import { diagnostic, type Diagnostic, type RequestId } from '../types.ts';

export const SAVE_ATTEMPTS = 3;
export const RETRY_DELAYS_MS = [250, 1000] as const; // before attempts 2 and 3

type Replies = readonly RequestId[];

export type SaveQueue =
  | { state: 'idle' }
  | {
      state: 'writing';
      envelope: SessionEnvelope;
      attempt: number;
      replies: Replies;
      next: { envelope: SessionEnvelope; replies: Replies } | null;
    }
  | { state: 'waiting'; envelope: SessionEnvelope; attempt: number; replies: Replies };

export const IDLE_QUEUE: SaveQueue = { state: 'idle' };

export type SaveInput =
  | { kind: 'checkpoint'; envelope: SessionEnvelope; reply: RequestId | null }
  | { kind: 'saved' }
  | { kind: 'failed'; quota: boolean }
  | { kind: 'retryDue' };

export type SaveEffect =
  | { kind: 'write'; envelope: SessionEnvelope }
  | { kind: 'wait'; ms: number }
  | { kind: 'cancelWait' }
  | { kind: 'answer'; request: RequestId; ok: boolean }
  | { kind: 'diagnostic'; entry: Diagnostic };

export interface SaveStep {
  queue: SaveQueue;
  effects: readonly SaveEffect[];
}

const withReply = (replies: Replies, reply: RequestId | null): Replies =>
  reply === null ? replies : [...replies, reply];

function write(envelope: SessionEnvelope, attempt: number, replies: Replies, before: SaveEffect[] = []): SaveStep {
  return {
    queue: { state: 'writing', envelope, attempt, replies, next: null },
    effects: [...before, { kind: 'write', envelope }],
  };
}

const answers = (replies: Replies, ok: boolean): SaveEffect[] =>
  replies.map((request) => ({ kind: 'answer', request, ok }));

// One row per state and input of 06 5.1; any other pair changes nothing. A newer envelope always supersedes: every
// envelope is complete, so its save answers the replies of the ones it replaced.
export function saveStep(q: SaveQueue, input: SaveInput): SaveStep {
  const same: SaveStep = { queue: q, effects: [] };
  switch (q.state) {
    case 'idle':
      return input.kind === 'checkpoint' ? write(input.envelope, 1, withReply([], input.reply)) : same;
    case 'waiting':
      if (input.kind === 'checkpoint') {
        return write(input.envelope, 1, withReply(q.replies, input.reply), [{ kind: 'cancelWait' }]);
      }
      return input.kind === 'retryDue' ? write(q.envelope, q.attempt + 1, q.replies) : same;
    case 'writing':
      switch (input.kind) {
        case 'checkpoint': {
          const replies = withReply(q.next?.replies ?? [], input.reply);
          return { queue: { ...q, next: { envelope: input.envelope, replies } }, effects: [] };
        }
        case 'saved': {
          const done = answers(q.replies, true);
          return q.next ? write(q.next.envelope, 1, q.next.replies, done) : { queue: IDLE_QUEUE, effects: done };
        }
        case 'failed': {
          if (q.next) return write(q.next.envelope, 1, [...q.replies, ...q.next.replies]);
          const delay = RETRY_DELAYS_MS[q.attempt - 1];
          if (q.attempt < SAVE_ATTEMPTS && delay !== undefined) {
            return {
              queue: { state: 'waiting', envelope: q.envelope, attempt: q.attempt, replies: q.replies },
              effects: [{ kind: 'wait', ms: delay }],
            };
          }
          const entry = diagnostic('sessionSaveFailed', input.quota ? 'quota' : null);
          return { queue: IDLE_QUEUE, effects: [...answers(q.replies, false), { kind: 'diagnostic', entry }] };
        }
        default:
          return same;
      }
  }
}
