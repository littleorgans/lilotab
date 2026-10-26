// Gesture timing log, measurement builds only: one GestureRecord per gesture, assembled from what the worker shell
// already sees, each step's model before and after with its event and effects, plus the preparation, launch and
// decline times around them, a timeline of every stepped event, and the popup page's own trace. It only observes: no
// event, effect or order changes. Callers pass every time.

import {
  EVENTS_MAX,
  PROBE_MAX,
  type AttemptTimes,
  type EndReason,
  type GestureRecord,
  type InputClass,
  type PageClass,
  type PopupTrace,
  type ProbeMessage,
  type TimelineEntry,
  type TimingRecord,
} from '../../browser/timing.ts';
import {
  expiry,
  isWebStore,
  rowOf,
  urlParts,
  type AttemptId,
  type CoreEvent,
  type DeclineReason,
  type Effect,
  type Expiry,
  type HostInput,
  type Interaction,
  type InteractionId,
  type Millis,
  type Model,
  type OpId,
  type Step,
  type TabRef,
  type TimerKind,
} from '../../core/index.ts';

type Press = Extract<CoreEvent, { kind: 'command' | 'toolbarClicked' | 'searchCommand' }>;
type CloseHost = Extract<Effect, { kind: 'closeHost' }>;
type Activate = Extract<Effect, { kind: 'activate' }>;
type Pending = Omit<GestureRecord, 'outcome' | 'switched' | 'reason' | 'end'> & { events: TimelineEntry[] };

const TAIL_MS = 2_000; // a finished gesture keeps its timeline this long, for the activation and focus that follow
const TRACES = 16; // recent attempts a late popup trace can still reach

interface Open {
  id: string; // the interaction
  at: Millis; // its press
  record: Pending;
  attempts: Map<AttemptId, AttemptTimes>;
  declines: Map<AttemptId, DeclineReason>;
}

// A finished gesture still collecting the events after its end.
interface Tail {
  record: GestureRecord & { events: TimelineEntry[] };
  at: Millis; // its press
  until: Millis;
}

export interface GestureLog {
  gate(at: Millis): void;
  prepared(event: CoreEvent | null, at: Millis): void;
  dropped(entry: GestureRecord['entry'], pressAt: Millis, at: Millis): void;
  launched(attempt: AttemptId, at: Millis): void;
  declined(attempt: AttemptId, reason: DeclineReason): void;
  stepped(before: Model, event: CoreEvent, after: Step, at: Millis): InteractionId | null; // a gesture began
  failed(attempt: AttemptId, error: unknown): void;
  lastFocused(id: InteractionId, window: { windowId: number; type: string; focused: boolean }, at: Millis): void;
  probe(message: ProbeMessage): boolean; // reached a recent popup attempt
  live(): boolean;
  drop(): void; // forget the live gesture: recording turned off
}

const INTERNAL = ['chrome', 'chrome-extension', 'chrome-untrusted', 'devtools', 'about', 'view-source'];

// A coarse class only; the address itself never leaves this function.
export function pageClass(url: string): PageClass {
  const parts = urlParts(url);
  const { scheme, host, path } = parts;
  if ((scheme === 'chrome' && (host === 'newtab' || host === 'new-tab-page')) || scheme === 'chrome-search') {
    return 'newtab';
  }
  if (isWebStore(parts)) return 'webstore';
  if (path.toLowerCase().endsWith('.pdf')) return 'pdf';
  if (scheme === 'http' || scheme === 'https') return 'http';
  if (scheme === 'file') return 'file';
  return INTERNAL.includes(scheme) ? 'internal' : 'other';
}

const INPUT_CLASS: Readonly<Record<HostInput['kind'], InputClass>> = {
  release: 'release',
  step: 'key',
  move: 'key',
  window: 'key',
  latchSearch: 'key',
  leaveSearch: 'key',
  query: 'key',
  enter: 'key',
  pick: 'pointer',
  ping: 'other',
  activity: 'other',
  jump: 'key',
  page: 'key',
  close: 'key',
  cancel: 'other',
};

const tenth = (ms: number): number => Math.round(ms * 10) / 10;
const ref = ({ tabId, windowId }: TabRef): TabRef => ({ tabId, windowId });

// Browser error messages can contain titles and any URL scheme. Export only standard error categories.
const scrub = (error: unknown): string =>
  error instanceof Error && ['Error', 'TypeError', 'RangeError', 'AbortError', 'NotAllowedError'].includes(error.name)
    ? error.name
    : 'Error';

// The event as a timeline entry: kinds and ids only, never a query, address or title.
function entryOf(event: CoreEvent, at: number): TimelineEntry {
  switch (event.kind) {
    case 'host':
      return event.input.kind === 'release' && event.input.inferred
        ? { at, e: 'release', inferred: true }
        : { at, e: event.input.kind };
    case 'hostStatus':
      return { at, e: event.status };
    case 'command':
    case 'toolbarClicked':
    case 'searchCommand':
      return { at, e: event.kind, ...ref(event.source) };
    case 'windowFocused':
      return { at, e: 'focus', windowId: event.windowId };
    case 'tabActivated':
    case 'tabRemoved':
    case 'tabDetached':
    case 'tabAttached':
      return { at, e: event.kind, tabId: event.tabId, windowId: event.windowId };
    case 'windowCreated':
    case 'windowRemoved':
      return { at, e: event.kind, windowId: event.windowId };
    case 'timer':
      return { at, e: 'timer', timer: event.timer };
    case 'activated':
      return { at, e: 'activated', ...ref(event.target), result: event.result };
    default:
      return { at, e: event.kind };
  }
}

function initialOf({ snapshot, cursor }: Interaction): TabRef | null {
  const named = rowOf(snapshot, cursor);
  return named && !named.closed ? { tabId: named.row.tabId, windowId: named.window.windowId } : null;
}

function push(record: { events: TimelineEntry[]; eventsLost?: number }, entry: TimelineEntry): void {
  record.events.push(entry);
  if (record.events.length > EVENTS_MAX) {
    record.events.shift();
    record.eventsLost = (record.eventsLost ?? 0) + 1;
  }
}
const isPress = (e: CoreEvent): e is Press =>
  e.kind === 'command' || e.kind === 'toolbarClicked' || e.kind === 'searchCommand';

// The timer whose expiry row ended the gesture; dwell never does (T-13, T-14).
const TIMER_END: Readonly<Record<TimerKind, EndReason>> = { dwell: 'other', hostDeadline: 'deadline', idle: 'idle' };

// seen is the interaction the event's row saw, after expiry.
function inputReason(seen: Interaction, input: HostInput): EndReason {
  switch (input.kind) {
    case 'release':
      if (seen.state === 'ready') return 'quickTap';
      return input.inferred ? 'inferredRelease' : 'release';
    case 'cancel':
      return input.cause;
    case 'enter':
    case 'pick':
      return input.kind;
    default:
      return 'other';
  }
}

// The event that ended the gesture, when no timer did.
function reasonOf(seen: Interaction, event: CoreEvent): EndReason {
  switch (event.kind) {
    case 'host':
      return inputReason(seen, event.input);
    case 'hostStatus':
      return event.status === 'closed' ? 'hostClosed' : 'hostFailed';
    case 'command':
    case 'toolbarClicked':
    case 'searchCommand':
      return 'newPress';
    case 'windowFocused':
      return 'focusLoss';
    case 'tabActivated':
    case 'tabRemoved':
    case 'tabDetached':
    case 'tabReplaced':
    case 'windowRemoved':
      return 'sourceLeft';
    default:
      return 'other';
  }
}

// origin: the epoch of Millis 0, performance.timeOrigin in the worker. touched: a finished record changed.
export function createGestureLog(
  origin: number,
  done: (record: TimingRecord) => void,
  touched: () => void = () => undefined,
): GestureLog {
  let open: Open | null = null;
  let tail: Tail | null = null;
  let gateAt: Millis | null = null;
  let gestures = 0;
  let focus: { windowId: number | null; at: Millis } | null = null; // the last windows.onFocusChanged
  let prevTarget: TabRef | null = null;
  const activations = new Map<OpId, Tail>(); // results can arrive after another gesture replaces the tail
  const preparedAt = new WeakMap<CoreEvent, Millis>();
  const traces = new Map<AttemptId, { times: AttemptTimes; at: Millis }>(); // popup attempts, oldest first

  function addAttempt(
    g: Open,
    attempt: AttemptId,
    host: AttemptTimes['host'],
    start: number,
    more: Pick<AttemptTimes, 'why' | 'windowId'> = {},
  ): void {
    const times: AttemptTimes = { host, start, launched: null, ready: null, declined: null, ...more };
    g.attempts.set(attempt, times);
    g.record.attempts.push(times);
    if (host !== 'popup') return;
    traces.set(attempt, { times, at: g.at });
    if (traces.size > TRACES) traces.delete(traces.keys().next().value as AttemptId);
  }

  function begin(i: Interaction, e: Press, before: Model, step: Step, at: Millis): Open {
    const prepared = preparedAt.get(e);
    const g: Open = {
      id: i.id,
      at: e.at,
      attempts: new Map(),
      declines: new Map(),
      record: {
        epoch: Math.round(origin + e.at),
        entry: i.entry,
        holdDelayMs: before.settings.holdDelayMs,
        quickTap: i.quickTap,
        page: pageClass(e.source.url),
        tabs: e.live.windows.reduce((n, w) => n + w.tabs.length, 0),
        windows: e.live.windows.length,
        workerAge: Math.round(e.at),
        firstOfBoot: gestures === 0,
        gateWaited: gateAt === null || e.at < gateAt,
        prepared: prepared === undefined ? null : tenth(prepared - e.at),
        stepped: tenth(at - e.at),
        source: ref(i.source),
        focus: focus && { windowId: focus.windowId, ago: tenth(e.at - focus.at) },
        lastFocused: null,
        prevTarget,
        initial: initialOf(i),
        attempts: [],
        dwellDue: i.due.dwell === null ? null : tenth(i.due.dwell - e.at),
        dwell: null,
        shown: null,
        input: null,
        presses: 0,
        pressAt: null,
        unheardPress: false,
        deadline: null,
        idleDue: null,
        events: [],
        eventsLost: 0,
        target: null,
      },
    };
    const popup = step.effects.find((f) => f.kind === 'openPopup' && f.attempt === i.attempt.id);
    const why = e.kind === 'toolbarClicked' ? 'toolbar' : before.settings.listSurface === 'popup' ? 'setting' : 'page';
    addAttempt(
      g,
      i.attempt.id,
      i.attempt.host,
      g.record.stepped,
      popup?.kind === 'openPopup' ? { why, windowId: popup.windowId } : {},
    );
    gestures += 1;
    return g;
  }

  // One step of the live gesture g; prev is its interaction before the step, cur the slot after it, and the core's
  // expiry phase (04 3) gives seen, the slot the event's row saw, and the timers fired before it.
  function observe(
    g: Open,
    prev: Interaction,
    cur: Interaction | null,
    event: CoreEvent,
    step: Step,
    at: Millis,
    { interaction: seen, fired }: Expiry,
  ) {
    const r = g.record;
    const off = (t: Millis) => tenth(t - g.at);
    const ended = seen ? undefined : fired.at(-1); // an expiry row ended the gesture
    for (const timer of fired) push(r, { at: off(prev.due[timer] ?? event.at), e: 'expire', timer });
    const entry = entryOf(event, off(event.at));
    entry.state = seen?.state ?? 'ended';
    if ((event.kind === 'host' || event.kind === 'hostStatus') && event.attempt !== prev.attempt.id) entry.stale = true;
    if (cur?.id === prev.id && cur.due.idle !== prev.due.idle)
      entry.idle = cur.due.idle === null ? null : off(cur.due.idle);
    push(r, entry);
    if (cur?.id === prev.id) r.idleDue = cur.due.idle === null ? null : off(cur.due.idle);
    if (fired.includes('dwell')) r.dwell ??= off(at);
    if (ended === 'hostDeadline') r.deadline = off(at);
    if (event.kind === 'hostStatus') {
      const a = g.attempts.get(event.attempt);
      if (a && event.status === 'ready') a.ready ??= off(event.at);
      else if (a?.host === 'overlay' && (event.status === 'declined' || event.status === 'failed')) {
        a.declined ??= { reason: g.declines.get(event.attempt) ?? 'failed', at: off(event.at) };
      }
    } else if (
      event.kind === 'host' &&
      event.attempt === prev.attempt.id &&
      event.input.kind !== 'ping' &&
      seen !== null
    ) {
      const { input } = event;
      r.input ??= {
        at: off(event.at),
        kind: input.kind === 'cancel' && input.cause === 'key' ? 'key' : INPUT_CLASS[input.kind],
        input: input.kind,
        inferred: input.kind === 'release' && input.inferred,
      };
    } else if (event.kind === 'command' && cur?.id === prev.id) {
      if (r.shown !== null && r.input === null) r.unheardPress = true;
      r.presses += 1;
      r.pressAt ??= off(event.at);
    }
    for (const e of step.effects) {
      if (e.kind === 'openPopup' && !g.attempts.has(e.attempt)) {
        addAttempt(g, e.attempt, 'popup', off(at), { why: 'fallback', windowId: e.windowId });
      }
      if (e.kind === 'render' && (e.frame.mode === 'search' || e.frame.visible)) r.shown ??= off(at);
    }
    if (cur?.id === prev.id) {
      if (cur.state === 'holding' || cur.state === 'search') r.shown ??= off(at); // a search entry shows at ready
      return;
    }
    const close = step.effects.find((e): e is CloseHost => e.kind === 'closeHost' && e.attempt === prev.attempt.id);
    const activate = step.effects.find((e): e is Activate => e.kind === 'activate');
    const record = {
      ...r,
      outcome: close?.outcome ?? 'cancel',
      switched: activate !== undefined,
      reason: ended ? TIMER_END[ended] : seen ? reasonOf(seen, event) : 'other',
      end: off(at),
      target: activate ? { ...ref(activate.target), focusWindow: activate.focusWindow } : null,
    };
    done(record);
    open = null;
    tail = { record, at: g.at, until: at + TAIL_MS };
    if (activate) {
      activations.set(activate.op, tail);
      if (activations.size > TRACES) activations.delete(activations.keys().next().value as OpId);
    }
  }

  // After the end: what followed, such as the activation's result and the focus moves it caused.
  function follow(t: Tail, event: CoreEvent): void {
    const at = tenth(event.at - t.at);
    push(t.record, entryOf(event, at));
    touched();
  }

  return {
    gate(at) {
      gateAt ??= at;
    },
    prepared(event, at) {
      if (event && isPress(event)) preparedAt.set(event, at);
    },
    dropped(entry, pressAt, at) {
      done({
        epoch: Math.round(origin + pressAt),
        entry,
        workerAge: Math.round(pressAt),
        firstOfBoot: gestures === 0,
        gateWaited: gateAt === null || pressAt < gateAt,
        prepared: tenth(at - pressAt),
        outcome: 'dropped',
        reason: 'prepTimeout',
        end: tenth(at - pressAt),
      });
      gestures += 1;
    },
    launched(attempt, at) {
      const a = open?.attempts.get(attempt);
      if (a && open) a.launched ??= tenth(at - open.at);
    },
    declined(attempt, reason) {
      open?.declines.set(attempt, reason);
    },
    failed(attempt, error) {
      const a = open?.attempts.get(attempt);
      if (a) a.error ??= scrub(error);
    },
    lastFocused(id, { windowId, type, focused }, at) {
      if (open?.id === id) open.record.lastFocused = { windowId, type, focused, at: tenth(at - open.at) };
    },
    probe(m) {
      const trace = traces.get(m.attempt);
      if (!trace) return false;
      const off = (t: number) => tenth(m.origin + t - (origin + trace.at));
      const p: PopupTrace = (trace.times.popup ??= {
        start: null,
        focusing: null,
        focused: null,
        closed: null,
        events: [],
        lost: 0,
      });
      if (m.start) p.start = { ...m.start, at: off(m.start.at) };
      if (m.focusing) p.focusing = { ...m.focusing, at: off(m.focusing.at) };
      if (typeof m.focused === 'number') p.focused = off(m.focused);
      if (typeof m.closed === 'number') p.closed = off(m.closed);
      for (const w of m.windows ?? []) (p.windows ??= []).push({ ...w, at: off(w.at) });
      for (const e of m.events) {
        p.events.push({ ...e, at: off(e.at), ...(e.stamp === undefined ? {} : { stamp: off(e.stamp) }) });
        if (p.events.length > PROBE_MAX) {
          p.events.shift();
          p.lost += 1;
        }
      }
      return true;
    },
    stepped(before, event, after, at) {
      const prev = before.interaction;
      const cur = after.model.interaction;
      if (tail && (isPress(event) || event.at > tail.until)) tail = null;
      if (tail) follow(tail, event);
      if (event.kind === 'activated') {
        const activation = activations.get(event.op);
        if (activation?.record.target) {
          const at = tenth(event.at - activation.at);
          activation.record.target.result = event.result;
          activation.record.target.resultAt = at;
          if (activation !== tail) push(activation.record, entryOf(event, at));
          activations.delete(event.op);
          touched();
        }
      }
      if (open && prev?.id !== open.id) open = null; // lost track, as after recording was off
      if (open && prev) observe(open, prev, cur, event, after, at, expiry(before, event.at));
      let began: InteractionId | null = null;
      if (cur && cur.id !== prev?.id && isPress(event)) {
        open = begin(cur, event, before, after, at);
        began = cur.id;
      }
      if (event.kind === 'windowFocused') focus = { windowId: event.windowId, at: event.at };
      for (const e of after.effects) if (e.kind === 'activate') prevTarget = ref(e.target);
      return began;
    },
    live: () => open !== null,
    drop() {
      open = null;
      tail = null;
      activations.clear();
      traces.clear();
    },
  };
}
