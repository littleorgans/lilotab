// Key classification and host sensor rules, run inside hosts (04-state-machine 7, 03-components 4.9).
// Hosts read keys and paint; these rules decide what each trusted event means and whether the page may see it.

import { NAMED_KEYS, QUERY_MAX, fitText, type Binding, type HostInput, type HostMode } from '../protocol/index.ts';

export interface KeyFacts {
  type: 'keydown' | 'keyup' | 'pointermove' | 'pointerdown';
  key: string;
  code: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  trusted: boolean;
  composing: boolean;
  repeat: boolean;
}

// binding null (toolbar search only): no key is the held letter or its Shift form (C-POP-09). origin: the start view's
// mode; a list that started in search (toolbar) has no hold mode to go back to. open: hold is the open list (T-68).
export interface KeyContext {
  binding: Binding | null;
  mode: HostMode;
  origin: HostMode;
  open: boolean;
}

export interface Classified {
  input: HostInput | null;
  swallow: boolean;
}

const HELD_KEY: Readonly<Record<Binding['held'], string>> = { meta: 'Meta', ctrl: 'Control', alt: 'Alt' };

const PRINTABLE = /^[A-Za-z0-9]$/;

// The produced character decides when it is a plain letter or digit; otherwise (Alt on macOS changes it, a
// non Latin layout) the physical code does. Layouts beyond US are a round 3 check (05-events 10).
function isToken(f: KeyFacts, token: string): boolean {
  const named = NAMED_KEYS[token];
  if (named) return f.key === named.key || f.code === named.code;
  if (PRINTABLE.test(f.key)) return f.key.toUpperCase() === token;
  return f.code === (/^\d$/.test(token) ? `Digit${token}` : `Key${token}`);
}

const isHeld = (f: KeyFacts, b: Binding | null): b is Binding => b !== null && f[b.held];

const sameMods = (f: KeyFacts, m: Binding['mods']) =>
  f.meta === m.meta && f.ctrl === m.ctrl && f.alt === m.alt && f.shift === m.shift;

// Held letter with the binding's exact modifiers steps down (K-04, K-12); its Shift form steps up only when Shift
// is not part of the shortcut (K-05, C-KEY-05).
function letterMove(f: KeyFacts, b: Binding | null): 1 | -1 | null {
  if (!isHeld(f, b) || !isToken(f, b.key)) return null;
  if (sameMods(f, b.mods)) return 1;
  return !b.mods.shift && sameMods(f, { ...b.mods, shift: true }) ? -1 : null;
}

const ARROWS: Readonly<Record<string, 1 | -1>> = { ArrowDown: 1, ArrowUp: -1 };
const SIDES: Readonly<Record<string, 1 | -1>> = { ArrowRight: 1, ArrowLeft: -1 };

const send = (input: HostInput | null, swallow: boolean): Classified => ({ input, swallow });
const NOTHING = send(null, false);

// A keydown in hold, open or not. Cancel comes first, so Esc and Backspace still cancel after a missed release; only
// closed hold reads a key without the held key as that release. letterMove comes before F, also for a binding whose
// letter is F. The open list is latched like search: no key is a release, and the list keeps every key (C-TAP-11).
function classifyHoldKeydown(f: KeyFacts, b: Binding | null, open: boolean): Classified {
  if (f.key === 'Escape' || f.key === 'Backspace') return send({ kind: 'cancel', cause: 'key' }, true); // K-02, K-27
  if (!open && !isHeld(f, b)) return send({ kind: 'release', inferred: true }, false); // K-03
  const step = letterMove(f, b);
  if (step) return send({ kind: 'step', delta: step }, true); // K-04, K-05, K-23
  const arrow = ARROWS[f.key];
  if (arrow) return send({ kind: 'move', delta: arrow }, true); // K-04, K-05, K-23
  const side = SIDES[f.key];
  if (side) return send({ kind: 'window', delta: side }, true); // K-06, K-24, swallowed even with one window
  if (open && f.key === 'Enter') return send({ kind: 'enter' }, true); // K-25
  // K-07, K-26; a held down F toggles once
  if (isToken(f, 'F')) return send(f.repeat ? null : { kind: 'latchSearch' }, true);
  return send({ kind: 'activity' }, open); // K-08; K-29, Tab included: focus stays on the list
}

function classifyHold(f: KeyFacts, b: Binding | null): Classified {
  const held = isHeld(f, b);
  if (f.type === 'pointermove' || f.type === 'pointerdown') {
    return send(held ? { kind: 'activity' } : { kind: 'release', inferred: true }, false); // K-08, K-03
  }
  if (f.type === 'keyup') {
    if (b && f.key === HELD_KEY[b.held]) return send({ kind: 'release', inferred: false }, false); // K-01
    return held ? send({ kind: 'activity' }, false) : NOTHING;
  }
  return classifyHoldKeydown(f, b, false);
}

function classifyOpen(f: KeyFacts, b: Binding | null): Classified {
  if (f.type !== 'keydown') return NOTHING; // K-28; the host swallows a keyup whose keydown it swallowed
  return classifyHoldKeydown(f, b, true);
}

function classifySearch(f: KeyFacts, b: Binding | null, origin: HostMode): Classified {
  if (f.type !== 'keydown' || f.composing) return NOTHING; // K-14, K-18; K-20 reports presses at keyup
  if (f.key === 'Enter') return send({ kind: 'enter' }, true); // K-10
  if (f.key === 'Escape') return send({ kind: 'cancel', cause: 'key' }, true); // K-11
  const step = ARROWS[f.key] ?? letterMove(f, b);
  if (step) return send({ kind: 'move', delta: step }, true); // K-12
  if (isHeld(f, b) && isToken(f, 'F')) {
    return send(origin === 'hold' && !f.repeat ? { kind: 'leaveSearch' } : null, true); // K-22, else K-14
  }
  return NOTHING; // editing keys belong to the field (C-SRCH-15)
}

// Untrusted events never mean anything (K-16, C-SEC-01).
export function classify(f: KeyFacts, c: KeyContext): Classified {
  if (!f.trusted) return NOTHING;
  if (c.mode === 'search') return classifySearch(f, c.binding, c.origin);
  return c.open ? classifyOpen(f, c.binding) : classifyHold(f, c.binding);
}

// The full text, only when it changed and no composition is active (K-09, K-19, C-SRCH-11).
export function queryInput(value: string, lastSent: string, composing: boolean): HostInput | null {
  const text = fitText(value, QUERY_MAX);
  return composing || text === lastSent ? null : { kind: 'query', text };
}

// K-20: codes of search key presses seen at keydown that have sent nothing yet.
export type Presses = ReadonlySet<string>;
export const NO_PRESSES: Presses = new Set();

// Call with each trusted search key event and what classify sent for it; a query sent meanwhile resets to NO_PRESSES.
export function trackPress(
  p: Presses,
  f: KeyFacts,
  sent: HostInput | null,
): { presses: Presses; input: HostInput | null } {
  if (f.type === 'keydown') {
    const next = new Set(p);
    if (sent) next.delete(f.code);
    else next.add(f.code);
    return { presses: next, input: null };
  }
  if (f.type === 'keyup' && p.has(f.code)) {
    const next = new Set(p);
    next.delete(f.code);
    return { presses: next, input: { kind: 'activity' } };
  }
  return { presses: p, input: null };
}
