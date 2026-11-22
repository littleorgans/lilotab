// Selection within one interaction: the hold cursor, search results and highlight, the close key target and the repair
// after a row goes (04-state-machine 5 Steps, C-HOLD-14). Interaction values in and out; no effects, the snapshot never
// changes. Neither the hold cursor nor a search result is ever a gone row.

import type { HostInput } from '../protocol/index.ts';
import { rank, titleKey, titleOrder } from '../ranking/index.ts';
import { candidates, rowAt, rowOf, type Snapshot } from '../snapshot/index.ts';
import { hasRow, listsRows, sameRow, type Cursor, type RowRef, type TabId } from '../types.ts';
import { urlParts } from '../url.ts';
import type { Interaction, SearchState } from './types.ts';

const wrap = (n: number, delta: number, length: number): number => (((n + delta) % length) + length) % length;

// The first of at + delta, at + 2 delta, ... around a ring of length that passes ok; at itself when none does.
function seek(at: number, delta: number, length: number, ok: (n: number) => boolean): number {
  for (let k = 1; k <= length; k++) {
    const n = wrap(at, delta * k, length);
    if (ok(n)) return n;
  }
  return at;
}

// ---- the active order (C-HOLD-29, C-HOLD-31)

// The row's title key, open or recently closed.
function keyOf(s: Snapshot, ref: RowRef): string {
  const row = rowOf(s, ref)?.row;
  return row ? titleKey(row.title, urlParts(row.url).host) : '';
}

const sorted = (i: Pick<Interaction, 'snapshot' | 'sort'>, refs: readonly RowRef[]): readonly RowRef[] =>
  i.sort === 'title' ? titleOrder(refs, (ref) => keyOf(i.snapshot, ref)) : refs;

// A window's rows in the active order, gone ones included: the frozen tab order, or title order (T-81).
export function shownOrder(i: Pick<Interaction, 'snapshot' | 'sort'>, window: number): number[] {
  const refs = (i.snapshot.windows[window]?.rows ?? []).map((_, row) => ({ window, row }));
  return sorted(i, refs).map((ref) => ref.row);
}

// ---- search results

// Search over every listed row not gone, in the active order, highlighting the given row when it is a result (T-18,
// T-31, T-55, T-75, C-SRCH-08, C-SRCH-29).
export function searchOf(i: Pick<Interaction, 'snapshot' | 'gone' | 'sort'>, query: string, highlight: Cursor | null) {
  const results = sorted(
    i,
    rank(
      query,
      candidates(i.snapshot).filter((c) => !hasRow(i.gone, c.ref)),
    ),
  );
  return { query, results, highlight: Math.max(0, highlight ? results.findIndex((r) => sameRow(r, highlight)) : 0) };
}

// The highlighted result; none with no results (T-38, T-40, C-SRCH-26).
export const highlightOf = (search: SearchState): RowRef | undefined => search.results[search.highlight];

// ---- hold cursor: every move returns a new value except a window step that changes nothing (T-25)

// Whether a row of this window still shows: rows closed with the close key leave the hold list (C-HOLD-14).
const visible = (i: Interaction, window: number) => (row: number) => !hasRow(i.gone, { window, row });

// The source window's current row, which the close key never closes (C-SRCH-25).
const home = (i: Interaction): Cursor => ({ window: 0, row: i.snapshot.windows[0]?.current ?? 0 });

// The first row not gone from row, delta steps at a time along the window's active order, wrapping; row itself when
// none is.
function seekRow(i: Interaction, window: number, row: number, delta: number): number {
  const order = shownOrder(i, window);
  const shows = visible(i, window);
  return order[seek(order.indexOf(row), delta, order.length, (n) => shows(order[n] ?? row))] ?? row;
}

// Within the shown window in its visible order; an arrow here ends history stepping for the hold (D6).
const moveCursor = (i: Interaction, delta: number): Interaction => {
  const { window } = i.cursor;
  return { ...i, history: false, cursor: { window, row: seekRow(i, window, i.cursor.row, delta) } };
};

// Shortcut presses: in history, one step along the global stack from the highlighted row, the shown window following
// (D1, D4); else as an arrow.
export const stepCursor = (i: Interaction, delta: number): Interaction => {
  const { stack } = i.snapshot;
  if (!i.history || !stack) return moveCursor(i, delta);
  const at = stack.findIndex((c) => sameRow(c, i.cursor));
  const shows = (n: number) => stack[n] !== undefined && !hasRow(i.gone, stack[n]);
  return { ...i, cursor: stack[seek(at, delta, stack.length, shows)] ?? i.cursor };
};

// Shown window steps past windows whose rows are all gone, row = its current row, else its first row not gone (T-24),
// ending history stepping (D6); with one window shown nothing moves (T-25, C-WIN-10).
function stepWindow(i: Interaction, delta: number): Interaction {
  const { windows } = i.snapshot;
  const window = seek(i.cursor.window, delta, windows.length, (w) => listsRows(windows, i.gone, w));
  if (window === i.cursor.window) return i.history ? { ...i, history: false } : i;
  const current = windows[window]?.current ?? 0;
  const row = visible(i, window)(current) ? current : seekRow(i, window, current, 1);
  return { ...i, history: false, cursor: { window, row } };
}

type Jump = Extract<HostInput, { kind: 'jump' | 'page' }>;

// Home, End and the page keys: the first or last index, or at plus or minus rows, clamped to 0..last without
// wrapping (T-77, T-84).
const jumpIndex = (at: number, input: Jump, last: number): number =>
  Math.max(0, Math.min(input.kind === 'page' ? at + input.delta * input.rows : input.to === 'first' ? 0 : last, last));

// Within the shown window's rows not gone, in the active order; it ends history stepping as an arrow does (T-84).
function jumpCursor(i: Interaction, input: Jump): Interaction {
  const { window, row } = i.cursor;
  const order = shownOrder(i, window).filter(visible(i, window));
  const to = order[jumpIndex(order.indexOf(row), input, order.length - 1)] ?? row;
  return { ...i, history: false, cursor: { window, row: to } };
}

type HoldMove = Extract<HostInput, { kind: 'step' | 'move' | 'window' | 'jump' | 'page' }>;
const HOLD_MOVES: ReadonlySet<HostInput['kind']> = new Set(['step', 'move', 'window', 'jump', 'page']);
export const isHoldMove = (input: HostInput): input is HoldMove => HOLD_MOVES.has(input.kind);

export function holdMove(i: Interaction, input: HoldMove): Interaction {
  if (input.kind === 'step') return stepCursor(i, input.delta);
  if (input.kind === 'move') return moveCursor(i, input.delta);
  return input.kind === 'window' ? stepWindow(i, input.delta) : jumpCursor(i, input);
}

// ---- search highlight: i itself with no results, else a new value (T-40, T-77)

// A press, or a step or move: highlight ±1, wrapping (T-36, T-37).
export const moveHighlight = (i: Interaction, delta: number): Interaction => {
  const { search } = i;
  if (!search?.results.length) return i;
  return { ...i, search: { ...search, highlight: wrap(search.highlight, delta, search.results.length) } };
};

type SearchMove = Extract<HostInput, { kind: 'step' | 'move' | 'jump' | 'page' }>;

// Step and move wrap (T-36); Home, End and the page keys clamp to the results without wrapping (T-77).
export function searchMove(i: Interaction, input: SearchMove): Interaction {
  if (input.kind === 'step' || input.kind === 'move') return moveHighlight(i, input.delta);
  const { search } = i;
  if (!search?.results.length) return i;
  return { ...i, search: { ...search, highlight: jumpIndex(search.highlight, input, search.results.length - 1) } };
}

// Back to hold: the query goes and history stays (04 5 Steps); the highlighted tab stays when the shown window lists
// it, else the initial cursor, or the current tab once that row is gone (T-67).
export function unlatched(i: Interaction, search: SearchState): Interaction {
  const target = highlightOf(search);
  const cursor = target?.window === i.cursor.window ? target : i.snapshot.initial;
  return { ...i, search: null, cursor: hasRow(i.gone, cursor) ? home(i) : cursor };
}

// ---- the close key

// The highlighted row when it is an open tab other than the source and not gone (T-74, T-75); else null (T-76). A
// recently closed row has no rowAt, so it never closes and never goes (03 4.6).
export function closable(i: Interaction): { ref: RowRef; tabId: TabId } | null {
  const ref = i.search ? highlightOf(i.search) : i.cursor;
  const row = ref && !hasRow(i.gone, ref) ? rowAt(i.snapshot, ref) : undefined;
  return ref && row && row.tabId !== i.source.tabId ? { ref, tabId: row.tabId } : null;
}

// T-74: the next row of the shown window not gone in the active order, else the previous one, else window 0's current
// row.
function pastGone(i: Interaction): Interaction {
  const { window, row } = i.cursor;
  const order = shownOrder(i, window);
  const at = order.indexOf(row);
  const shows = visible(i, window);
  const next = order.slice(at + 1).find(shows) ?? order.slice(0, at).findLast(shows);
  return { ...i, cursor: next === undefined ? home(i) : { window, row: next } };
}

// T-75: rank again without gone rows, keeping the highlight index, or the last result.
function rerank(i: Interaction, search: SearchState): Interaction {
  const { query, results } = searchOf(i, search.query, null);
  return { ...i, search: { query, results, highlight: Math.max(0, Math.min(search.highlight, results.length - 1)) } };
}

// T-81 to T-83: the other order, which ends history stepping as an arrow does (C-WIN-06). Search ranks its query again
// and highlights the first result (C-SRCH-29); hold highlights the shown window's first row in the new order
// (C-HOLD-29).
export function toggleSort(i: Interaction): Interaction {
  const next: Interaction = { ...i, sort: i.sort === 'title' ? 'default' : 'title', history: false };
  if (next.search) return { ...next, search: searchOf(next, next.search.query, null) };
  const { window, row } = next.cursor;
  return { ...next, cursor: { window, row: shownOrder(next, window).find(visible(next, window)) ?? row } };
}

// The only way a row goes: it leaves the list and the selection moves off it in the same value (T-74, T-75).
export function withGone(i: Interaction, ref: RowRef): Interaction {
  const next = { ...i, gone: [...i.gone, ref] };
  return next.search ? rerank(next, next.search) : pastGone(next);
}
