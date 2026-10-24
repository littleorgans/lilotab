// The transition table of 04-state-machine 4.2, grouped by event; each branch cites its T row.

import type { HostInput } from '../protocol/index.ts';
import { isNormal, reconcile } from '../recents/index.ts';
import { chooseHost } from '../settings/index.ts';
import { buildSnapshot, listedTabs, lookOf, rowAt } from '../snapshot/index.ts';
import type { Millis, TabRef } from '../types.ts';
import {
  cancel,
  cancelTimer,
  commit,
  emit,
  loadIcons,
  nextId,
  publish,
  searchOf,
  setInteraction,
  setRecents,
  startTimer,
  startView,
  wrap,
  type Run,
} from './run.ts';
import {
  HOST_DEADLINE_MS,
  type CoreEvent,
  type HostStatus,
  type Interaction,
  type SearchState,
  type TimerKind,
} from './types.ts';

type Press = Extract<CoreEvent, { kind: 'command' | 'toolbarClicked' }>;

const sameTab = (a: TabRef, b: TabRef) => a.tabId === b.tabId && a.windowId === b.windowId;

const isPending = (i: Interaction) => i.state === 'overlayPending' || i.state === 'popupPending';

// ---- presses

// T-02 to T-04 and T-55: reconcile, freeze the snapshot, open attempt 1 with the start view.
function startGesture(run: Run, e: Press): void {
  const entry = e.kind === 'command' ? 'shortcut' : 'toolbar';
  if (entry === 'shortcut' && listedTabs(e.live) <= 1) return; // T-02, C-HOLD-15
  setRecents(run, reconcile(run.model.recents, e.live));
  const { settings } = run.model;
  const source = { tabId: e.source.tabId, windowId: e.source.windowId };
  const snapshot = buildSnapshot(run.model.recents, e.live, settings, source);
  if (!snapshot) return;
  const host = entry === 'toolbar' ? 'popup' : chooseHost(e.source, settings);
  const id = nextId(run);
  let i: Interaction = {
    id,
    entry,
    source,
    binding: e.binding,
    look: lookOf(settings),
    quickTap: settings.quickTap,
    snapshot,
    state: host === 'overlay' ? 'overlayPending' : 'popupPending',
    attempt: { id: `${id}:1`, host },
    due: { dwell: null, hostDeadline: null, idle: null },
    away: false,
    cursor: snapshot.initial,
    history: snapshot.stack !== null,
    search: entry === 'toolbar' ? searchOf({ snapshot }, '', snapshot.initial) : null,
    open: false,
  };
  // Open tab list has no dwell: a ready host shows the list at once (T-03, T-04, C-HOLD-24).
  if (entry === 'shortcut' && i.quickTap === 'flip') i = startTimer(run, i, 'dwell', e.at + settings.holdDelayMs);
  i = startTimer(run, i, 'hostDeadline', e.at + HOST_DEADLINE_MS);
  setInteraction(run, i);
  launch(run, i);
}

function launch(run: Run, i: Interaction): void {
  const { id: attempt, host } = i.attempt;
  const start = startView(i);
  if (host === 'overlay') emit(run, { kind: 'mountOverlay', attempt, tabId: i.source.tabId, start });
  else emit(run, { kind: 'openPopup', attempt, tabId: i.source.tabId, windowId: i.source.windowId, start });
}

// Within the shown window in its visible order; an arrow here ends history stepping for the hold (D6).
const moveCursor = (i: Interaction, delta: number): Interaction => {
  const rows = i.snapshot.windows[i.cursor.window]?.rows.length ?? 1;
  return { ...i, history: false, cursor: { ...i.cursor, row: wrap(i.cursor.row, delta, rows) } };
};

// Shortcut presses: in history, one step along the global stack from the highlighted row, the shown window following
// (D1, D4); else as an arrow.
const stepCursor = (i: Interaction, delta: number): Interaction => {
  const { stack } = i.snapshot;
  if (!i.history || !stack) return moveCursor(i, delta);
  const at = stack.findIndex((c) => c.window === i.cursor.window && c.row === i.cursor.row);
  return { ...i, cursor: stack[wrap(at, delta, stack.length)] ?? i.cursor };
};

const moveHighlight = (i: Interaction, delta: number): Interaction =>
  i.search ? { ...i, search: { ...i.search, highlight: wrap(i.search.highlight, delta, i.search.results.length) } } : i;

// A press from the live interaction's tab steps it (C-KEY-04, C-HOLD-21).
function stepPress(run: Run, i: Interaction, at: Millis): void {
  if (isPending(i) || i.state === 'ready') {
    if (i.entry === 'shortcut') setInteraction(run, stepCursor(i, 1)); // T-15
  } else if (i.state === 'holding') {
    publish(run, stepCursor(i, 1), at, true); // T-22
  } else if (i.search?.results.length) {
    publish(run, moveHighlight(i, 1), at, true); // T-37
  } else {
    publish(run, i, at, false); // T-40
  }
}

export function onPress(run: Run, e: Press): void {
  const i = run.model.interaction;
  if (i && e.kind === 'command' && sameTab(i.source, e.source)) {
    stepPress(run, i, e.at);
  } else {
    if (i) cancel(run, i); // T-05, T-55
    startGesture(run, e);
  }
}

// ---- expiry by time (04 3): the due itself is the row's time

export function onExpiry(run: Run, i: Interaction, timer: TimerKind, at: Millis): void {
  if (timer === 'dwell') {
    if (i.state === 'ready') show(run, i, at); // T-14; pending: dwell done (T-13)
  } else if (timer === 'hostDeadline') {
    if (!isPending(i)) return;
    if (i.entry === 'shortcut' && !i.away) commit(run, i, i.cursor); // T-11
    else cancel(run, i); // T-62, T-63
  } else {
    cancel(run, i); // T-32, T-46
  }
}

// Show the hold list: holding, idle started, visible frame (T-07, T-10, T-14, T-17).
function show(run: Run, i: Interaction, at: Millis): void {
  publish(run, { ...i, state: 'holding' }, at, true);
}

// Latch search: rank the empty query, highlight the cursor's tab (T-18, T-31).
function latch(run: Run, i: Interaction, at: Millis): void {
  publish(run, { ...i, state: 'search', search: searchOf(i, '', i.cursor) }, at, true);
}

// Back to hold with the held key down, as the F press itself shows: the query goes; the highlighted tab stays when the
// shown window lists it, else the initial cursor (T-67).
function unlatch(run: Run, i: Interaction, search: SearchState, at: Millis): void {
  const target = search.results[search.highlight];
  show(run, { ...i, search: null, cursor: target?.window === i.cursor.window ? target : i.snapshot.initial }, at);
}

// ---- host status (rows naming the active attempt; others are T-51)

function hostReady(run: Run, i: Interaction, at: Millis): void {
  const next = cancelTimer(run, i, 'hostDeadline');
  if (next.entry === 'toolbar') {
    publish(run, { ...next, state: 'search' }, at, false); // T-61
  } else if (next.due.dwell !== null) {
    setInteraction(run, { ...next, state: 'ready' }); // T-06, T-09
  } else {
    show(run, next, at); // T-07, T-10
  }
  loadIcons(run, i);
}

export function onStatus(run: Run, i: Interaction, status: HostStatus, at: Millis): void {
  if (status === 'closed') {
    cancel(run, i); // T-20, T-30, T-44
  } else if (status === 'ready' && isPending(i)) {
    hostReady(run, i, at);
  } else if (i.state === 'overlayPending' && (status === 'declined' || status === 'failed')) {
    // T-08: retire the overlay (always attempt 1), open the popup as attempt 2; dwell and deadline keep running.
    emit(run, { kind: 'closeHost', attempt: i.attempt.id, outcome: 'cancel' });
    const next: Interaction = { ...i, state: 'popupPending', attempt: { id: `${i.id}:2`, host: 'popup' } };
    setInteraction(run, next);
    launch(run, next);
  } else if (i.state === 'popupPending' && status === 'failed') {
    if (i.entry === 'shortcut' && !i.away) commit(run, i, i.cursor); // T-12
    else cancel(run, i); // T-58, T-62
  }
}

// ---- host input

function onReadyInput(run: Run, i: Interaction, input: HostInput, at: Millis): void {
  if (input.kind === 'release') {
    commit(run, i, i.cursor); // T-16
  } else if (input.kind === 'cancel') {
    cancel(run, i); // T-20
  } else if (input.kind === 'latchSearch') {
    latch(run, cancelTimer(run, i, 'dwell'), at); // T-18
  } else if (input.kind === 'step' || input.kind === 'move' || input.kind === 'window') {
    show(run, holdMove(cancelTimer(run, i, 'dwell'), input), at); // T-17
  }
}

// Shown window steps, row = its current row (T-24), ending history stepping (D6); with one window nothing moves
// (T-25, C-WIN-10).
function stepWindow(i: Interaction, delta: number): Interaction {
  const { windows } = i.snapshot;
  if (windows.length < 2) return i.history ? { ...i, history: false } : i;
  const window = wrap(i.cursor.window, delta, windows.length);
  return { ...i, history: false, cursor: { window, row: windows[window]?.current ?? 0 } };
}

type HoldMove = Extract<HostInput, { kind: 'step' | 'move' | 'window' }>;

const holdMove = (i: Interaction, input: HoldMove): Interaction => {
  if (input.kind === 'step') return stepCursor(i, input.delta);
  return input.kind === 'move' ? moveCursor(i, input.delta) : stepWindow(i, input.delta);
};

function onHoldInput(run: Run, i: Interaction, input: HostInput, at: Millis): void {
  switch (input.kind) {
    case 'step': // T-22
    case 'move': // T-23
    case 'window': {
      // T-24, T-25
      const moved = holdMove(i, input);
      publish(run, moved, at, moved !== i);
      break;
    }
    case 'activity': // T-26
      publish(run, i, at, false);
      break;
    case 'release':
      if (i.open) break; // T-69
      if (i.quickTap === 'list' && rowAt(i.snapshot, i.cursor)?.tabId === i.source.tabId) {
        publish(run, { ...i, open: true }, at, true); // T-68
      } else {
        commit(run, i, i.cursor); // T-27, T-28
      }
      break;
    case 'enter': // T-70
      if (i.open) commit(run, i, i.cursor);
      break;
    case 'pick': // T-71
      if (i.open && rowAt(i.snapshot, input.row)) commit(run, i, input.row);
      break;
    case 'cancel': // T-29, T-30
      cancel(run, i);
      break;
    case 'latchSearch': // T-31
      latch(run, i, at);
      break;
    default: // ping T-73, query and leaveSearch: due.idle stays
      break;
  }
}

function onSearchInput(run: Run, i: Interaction, input: HostInput, at: Millis): void {
  const search = i.search;
  if (!search) return;
  const results = search.results.length > 0;
  switch (input.kind) {
    case 'query': // T-35
      if (input.text !== search.query) publish(run, { ...i, search: searchOf(i, input.text, null) }, at, true);
      break;
    case 'step':
    case 'move': // T-36, T-40
      publish(run, results ? moveHighlight(i, input.delta) : i, at, results);
      break;
    case 'enter': {
      // T-38, T-40
      const target = search.results[search.highlight];
      if (target) commit(run, i, target);
      else publish(run, i, at, false);
      break;
    }
    case 'pick': // T-39
      if (rowAt(i.snapshot, input.row)) commit(run, i, input.row);
      break;
    case 'window': // T-42
    case 'latchSearch':
    case 'activity': // T-66
      publish(run, i, at, false);
      break;
    case 'cancel': // T-43, T-44
      cancel(run, i);
      break;
    case 'leaveSearch': // T-67; a toolbar list has no hold mode, so no row
      if (i.entry === 'shortcut') unlatch(run, i, search, at);
      break;
    default: // release T-41, ping T-45: due.idle stays
      break;
  }
}

export function onInput(run: Run, i: Interaction, input: HostInput, at: Millis): void {
  if (i.state === 'ready') onReadyInput(run, i, input, at);
  else if (i.state === 'holding') onHoldInput(run, i, input, at);
  else if (i.state === 'search') onSearchInput(run, i, input, at);
  else if (input.kind === 'cancel') cancel(run, i); // T-20
}

// ---- tab and window events, after recents (04 4.1 Recents first)

type Browser = Extract<
  CoreEvent,
  { kind: 'tabActivated' | 'tabRemoved' | 'tabDetached' | 'tabReplaced' | 'windowRemoved' | 'windowFocused' }
>;

function sourceLeft(run: Run, i: Interaction, e: Browser): boolean {
  const { tabId, windowId } = i.source;
  switch (e.kind) {
    case 'tabActivated':
      return e.windowId === windowId && e.tabId !== tabId;
    case 'tabRemoved':
    case 'tabDetached':
      return e.tabId === tabId;
    case 'tabReplaced':
      return e.removed === tabId;
    case 'windowRemoved':
      return e.windowId === windowId;
    case 'windowFocused':
      return e.windowId !== null && e.windowId !== windowId && isNormal(run.model.recents, e.windowId);
  }
}

// Source left cancels (T-20, T-33); focus lost cancels a launching overlay (T-56) and marks a popup away (T-57).
// Other listed tabs and windows closing leave the rows (T-34).
export function onBrowser(run: Run, i: Interaction, e: Browser): void {
  if (sourceLeft(run, i, e)) {
    cancel(run, i);
  } else if (e.kind === 'windowFocused') {
    const lost = e.windowId === null || !isNormal(run.model.recents, e.windowId);
    if (i.state === 'overlayPending' && lost) cancel(run, i);
    else if (i.state === 'popupPending') setInteraction(run, { ...i, away: lost });
  }
}
