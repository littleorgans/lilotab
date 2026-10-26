// Gesture timing log, measurement builds only (`just build-timing`): the record shape and its storage.local keys,
// shared by the worker, which writes records, the popup page's probe, which sends its trace, and the options page,
// which reads, exports and clears them. Release builds record nothing (C-SET-14): each root tests the build mode
// inline, `import.meta.env.MODE === 'timing'`, which the bundler folds before it splits chunks, so this module drops
// out too. A flag imported from here would fold only after chunking and leave this module in a shared chunk. Records
// hold no URL, title or tab content.

import type { DeclineReason, HostInput, InteractionState, TabRef, TimerKind } from '../core/index.ts';

export const TIMING_KEY = 'timingLog'; // JSON TimingRecord[], oldest first; the worker is its only writer
export const TIMING_OFF_KEY = 'timingOff'; // true while the options page has recording off; absent means on
export const TIMING_MAX = 500; // count bound; the worker also limits the serialized history by bytes
export const EVENTS_MAX = 120; // per gesture timeline, oldest dropped
export const PROBE_MAX = 120; // per popup trace, oldest dropped

export type PageClass = 'http' | 'newtab' | 'internal' | 'webstore' | 'pdf' | 'file' | 'other';
export type InputClass = 'release' | 'key' | 'pointer' | 'other';
export type EndReason =
  | 'quickTap' // release before the list showed (T-16)
  | 'release' // T-27
  | 'inferredRelease' // unheld input after a missed release (C-HOLD-12, T-28)
  | 'enter'
  | 'pick'
  | 'key' // the cancel causes the host sends (T-20, T-29, T-43)
  | 'blur'
  | 'hidden'
  | 'pageLeave'
  | 'deadline' // HOST_DEADLINE_MS with no ready host (T-11, T-62)
  | 'idle' // T-32, T-46
  | 'newPress' // T-05, T-55
  | 'focusLoss' // T-33, T-56
  | 'sourceLeft' // T-20, T-33
  | 'hostClosed' // T-30, T-44
  | 'hostFailed' // T-12, T-58
  | 'other';

// Times are ms after the press, one decimal; null when the step never happened.
export interface AttemptTimes {
  host: 'overlay' | 'popup';
  start: number; // the worker initiated the injection or the popup opening
  launched: number | null; // executeScript or openPopup settled
  ready: number | null; // `ready` received
  declined: { reason: DeclineReason | 'failed'; at: number } | null; // an overlay that fell back (T-08)
  why?: 'toolbar' | 'setting' | 'page' | 'fallback'; // the popup's cause: the icon, List surface, the page, attempt [0]
  windowId?: number; // the openPopup effect's requested window; retirement can skip the browser API call
  error?: string; // a standard error category only; browser messages can name pages
  popup?: PopupTrace; // the popup page's own trace
}

// One stepped event during the gesture, or after it in the tail (TAIL_MS), at its ingress arrival.
export interface TimelineEntry {
  at: number;
  e: string; // a host input or status kind, focus, expire (a due the expiry phase ran), else the core event kind
  state?: InteractionState | 'ended'; // the interaction the event's row saw; ended: an expiry ended it first
  stale?: true; // a host event from an attempt the interaction no longer has
  inferred?: true; // release only
  timer?: TimerKind;
  windowId?: number | null; // focus: null when focus left the browser
  tabId?: number;
  result?: string; // activated
  idle?: number | null; // the idle due after this step, when the step changed it
}

// The popup page's trace, on the popup's clock moved to ms after the press. Keys are every trusted keydown and keyup
// at window capture, including those the session never heard.
export interface PopupTrace {
  start: { at: number; focus: boolean; visible: boolean } | null; // the page script ran; focus: document.hasFocus()
  focusing: { at: number; focus: boolean } | null; // the start view painted, the wait for focus began
  focused: number | null; // focus resolved: listeners installed and ready posted in the same task
  closed: number | null; // the session ended and the page called window.close()
  windows?: { at: number; windowId: number; focused: boolean }[]; // windows.getCurrent(), the popup's own window
  events: ProbeEvent[];
  lost: number; // events dropped by PROBE_MAX
}

export interface ProbeEvent {
  at: number; // the probe's listener ran
  t: 'keydown' | 'keyup' | 'focus' | 'blur' | 'visibilitychange' | 'pagehide';
  stamp?: number; // the event's timeStamp
  key?: string;
  code?: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  repeat?: boolean;
  window?: boolean; // focus and blur: the window's own, else an element's
  focus: boolean; // document.hasFocus() at the event
  visible: boolean;
  heard: string | null; // what the session did: its effects, 'none', or null when it was not listening
}

// Popup to worker, measurement builds only; times on the popup's own clock (performance.now()).
export type ProbeMessage = Partial<Omit<PopupTrace, 'events' | 'lost'>> & {
  t: 'timingProbe';
  attempt: string;
  origin: number; // the popup's performance.timeOrigin
  events: ProbeEvent[];
};

export interface GestureRecord {
  epoch: number; // the press, ms since 1970
  entry: 'shortcut' | 'search'; // search: the toolbar icon or the Search tabs command; 'toolbar' in old logs
  holdDelayMs: number;
  quickTap: 'flip' | 'list';
  page: PageClass;
  tabs: number;
  windows: number;
  workerAge: number; // ms since the worker started, at the press
  firstOfBoot: boolean; // the first gesture since the worker started
  gateWaited: boolean; // the press arrived before the init gate settled
  prepared: number | null; // the press's preparation settled
  stepped: number; // the press stepped: host chosen
  source?: TabRef; // the press's tab
  focus?: { windowId: number | null; ago: number } | null; // the last windows.onFocusChanged before the press
  lastFocused?: { windowId: number; type: string; focused: boolean; at: number } | null; // async sample after the press; at: settlement
  prevTarget?: TabRef | null; // the previous activation's target, any gesture
  initial?: TabRef | null; // the row the list offered at the press, the quick target in flip; null: closed or none
  attempts: AttemptTimes[]; // [0] the chosen host; [1] the popup after a declined or failed overlay
  dwellDue: number | null; // no dwell with Open tab list or a search entry
  dwell: number | null; // the worker expired the dwell
  shown: number | null; // the worker sent the visible list
  input: { at: number; kind: InputClass; input: HostInput['kind']; inferred: boolean } | null; // first host input
  presses: number; // further shortcut presses during the gesture
  pressAt: number | null; // the first of them
  unheardPress?: boolean; // a further press while the list was already shown with no host input; absent in old logs
  deadline: number | null; // the host deadline fired with the host still pending
  idleDue?: number | null; // the last idle due before the end
  events?: TimelineEntry[]; // every stepped event, then the tail
  eventsLost?: number; // entries dropped by EVENTS_MAX
  target?: (TabRef & { focusWindow: boolean; result?: string; resultAt?: number }) | null; // the commit's activation
  outcome: 'commit' | 'cancel';
  switched: boolean; // a commit that activated another tab
  reason: EndReason;
  end: number;
}

// A timed out preparation never reaches the core, so no host, settings or live tab facts are claimed.
export interface DroppedPressRecord {
  epoch: number;
  entry: GestureRecord['entry'];
  workerAge: number;
  firstOfBoot: boolean;
  gateWaited: boolean;
  prepared: number;
  outcome: 'dropped';
  reason: 'prepTimeout';
  end: number;
}

export type TimingRecord = GestureRecord | DroppedPressRecord;

export interface TimingState {
  on: boolean;
  records: TimingRecord[];
}

// Written only by this extension, so the shape is trusted; anything else reads as empty.
export async function readTiming(): Promise<TimingState> {
  const stored = await chrome.storage.local.get([TIMING_KEY, TIMING_OFF_KEY]);
  let records: unknown = stored[TIMING_KEY];
  if (typeof records === 'string') {
    try {
      records = JSON.parse(records);
    } catch {
      records = [];
    }
  }
  return {
    on: stored[TIMING_OFF_KEY] !== true,
    records: Array.isArray(records) ? (records as TimingRecord[]).slice(-TIMING_MAX) : [],
  };
}

export function onTimingChanged(listener: (change: { cleared: boolean; on?: boolean }) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const log = changes[TIMING_KEY];
    const off = changes[TIMING_OFF_KEY];
    if (!log && !off) return;
    listener({
      cleared: log !== undefined && log.newValue === undefined,
      ...(off ? { on: off.newValue !== true } : {}),
    });
  });
}
