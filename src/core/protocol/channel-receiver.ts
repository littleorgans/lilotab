// The worker channel receiver and the port name both sides accept (05-events 4.1, 4.4, 4.6).

import { hasExactly, isIndex, isOneOf, isRecord, isRowRef, isText } from '../guards.ts';
import type { AttemptId } from '../types.ts';
import { PAGE_MAX, PROTOCOL, QUERY_MAX, type ChannelPhase, type HostInput, type HostToWorker } from './messages.ts';

// ---- channel names and phases (05 4.1, 4.4)

const ATTEMPT = /^[A-Za-z0-9_-]+:\d+:\d+$/;

// null: another protocol version or a bad shape.
export function parsePortName(name: string): AttemptId | null {
  const bar = name.indexOf('|');
  const attempt = name.slice(bar + 1);
  return bar > 0 && name.slice(0, bar) === String(PROTOCOL) && ATTEMPT.test(attempt) ? attempt : null;
}

// The handshake rule: ready opens, an overlay may decline once, input only once open (05 4.4).
export function admit(host: 'overlay' | 'popup', phase: ChannelPhase, m: HostToWorker): ChannelPhase | 'violation' {
  if (phase === 'opening' && m.t === 'ready') return 'open';
  if (phase === 'opening' && m.t === 'declined' && host === 'overlay') return 'done';
  if (phase === 'open' && m.t === 'input') return 'open';
  return 'violation';
}

// ---- host to worker (05 4.6)

const DELTAS = [1, -1] as const;
const CAUSES = ['key', 'blur', 'hidden', 'pageLeave'] as const;
const REASONS = ['unfocused', 'frameFocus', 'pdf', 'unsupported'] as const;
const ENDS = ['first', 'last'] as const;
const BARE = ['latchSearch', 'leaveSearch', 'enter', 'ping', 'activity', 'close', 'sort'] as const;

function parseInput(raw: unknown): HostInput | null {
  if (!isRecord(raw)) return null;
  const kind = raw['kind'];
  if (isOneOf(kind, BARE)) return hasExactly(raw, ['kind']) ? { kind } : null;
  const field = (name: string): unknown => (hasExactly(raw, ['kind', name]) ? raw[name] : undefined);
  switch (kind) {
    case 'release': {
      const inferred = field('inferred');
      return typeof inferred === 'boolean' ? { kind, inferred } : null;
    }
    case 'step':
    case 'move':
    case 'window': {
      const delta = field('delta');
      return isOneOf(delta, DELTAS) ? { kind, delta } : null;
    }
    case 'query': {
      const text = field('text');
      return isText(text, QUERY_MAX) ? { kind, text } : null;
    }
    case 'jump': {
      const to = field('to');
      return isOneOf(to, ENDS) ? { kind, to } : null;
    }
    case 'page': {
      if (!hasExactly(raw, ['kind', 'delta', 'rows'])) return null;
      const { delta, rows } = raw;
      return isOneOf(delta, DELTAS) && isIndex(rows, PAGE_MAX + 1) && rows > 0 ? { kind, delta, rows } : null;
    }
    case 'pick': {
      const row = field('row');
      return isRowRef(row) ? { kind, row: { window: row.window, row: row.row } } : null;
    }
    case 'cancel': {
      const cause = field('cause');
      return isOneOf(cause, CAUSES) ? { kind, cause } : null;
    }
    default:
      return null;
  }
}

export function parseHostToWorker(raw: unknown): HostToWorker | null {
  if (hasExactly(raw, ['t'])) return raw['t'] === 'ready' ? { t: 'ready' } : null;
  if (hasExactly(raw, ['t', 'reason'])) {
    return raw['t'] === 'declined' && isOneOf(raw['reason'], REASONS) ? { t: 'declined', reason: raw['reason'] } : null;
  }
  if (hasExactly(raw, ['t', 'input']) && raw['t'] === 'input') {
    const input = parseInput(raw['input']);
    return input ? { t: 'input', input } : null;
  }
  return null;
}
