// The list view's rows: the listbox, its empty state, row painting, names and selection.

import { letterOf } from '../../core/icon.ts';
import { ageCapped, type IconSrc, type ListRow, type ListView, type StartView } from '../../core/protocol/index.ts';
import { titleRuns, type Run } from '../../core/title/runs.ts';
import { hasRow, type RowRef } from '../../core/types.ts';
import { LIST_TEXT } from '../../strings.ts';
import { el, glyph, iconSlot, reveal, sameRefs, SOUND, windowName } from './paint.ts';
import type { Face, Strip } from './strip.ts';

export interface Rows {
  readonly list: HTMLUListElement;
  readonly empty: HTMLElement;
  start(view: ListView): void;
  icon(w: number, r: number, src: IconSrc | null): void; // the row half of an icon patch
  faces(): void; // the strip's faces changed: search markers follow
  setMode(mode: StartView['mode']): void; // entering search empties the results
  mode(): StartView['mode'];
  setGone(gone: readonly RowRef[]): void; // rows closed with the close key: left out in hold, and no longer copies
  // In the frame's order, gone ones left out.
  placeWindow(w: number, order: readonly number[] | null, selection: RowRef | null): void;
  showResults(results: readonly RowRef[], highlight: number, query: string): void;
  select(ref: RowRef | null): void;
  picture(): HTMLElement;
  rowAt(target: EventTarget | null): RowRef | null;
  pageRows(): number;
}

const PIN = [
  {
    d: 'M10.5 1.5l4 4-1.3 1.3-.8-.4-2.5 2.5.4 3.2L9 13.4l-2.7-2.7-3.6 3.6-1-1 3.6-3.6L2.6 7l1.3-1.3 3.2.4 2.5-2.5-.4-.8z',
  },
];

// A clock with a turning back arrow: a recently closed row, in the window marker's place (C-SRCH-27).
const CLOSED = [
  {
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.4',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    d: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9L2.5 5.5M2.5 2.5v3h3M8 5v3l2 1.5',
  },
];

const ROW_CONTAINMENT_THRESHOLD = 160;
// Keep more than one viewport of rows on each side for scroll and resize. The panel caps
// at 640 px and the shortest rows are 32 px (C-HOLD-19, C-A11Y-05).
const VIEWPORT_BUFFER_ROWS = 24;

// Runs as nodes, never markup (C-SEC-03): marks in full ink, noise in the quiet colour (C-HOLD-34, C-SRCH-30).
function paintRuns(box: Element, runs: readonly Run[]): void {
  box.replaceChildren(
    ...runs.map((run) => {
      if (run.kind === 'plain') return run.text;
      const node = run.kind === 'mark' ? el('mark', '') : el('span', 'noise');
      node.textContent = run.text;
      return node;
    }),
  );
}

// A built row and the parts its painting touches, so painting never searches the row.
interface Built {
  readonly li: HTMLLIElement;
  readonly title: HTMLElement;
  readonly site: HTMLElement | null;
  readonly dup: HTMLElement;
  readonly marker: HTMLElement | null; // none on a closed row
  face: Face | undefined; // the face its marker shows
  painted: string; // the mode and query its text shows
  name: string; // the title as painted, which leads the accessible name
  label: string; // the accessible name last set
}

// What a row reference outside the view paints as.
const BLANK: ListRow = {
  title: '',
  site: '',
  pinned: false,
  audible: false,
  sleeping: false,
  icon: null,
  noise: { lead: 0, tail: null },
  age: null,
  dup: null,
};

// panel takes the none class and the picture; field mirrors the active row; the strip says one window is listed and
// gives each window's face.
export function createRows(panel: HTMLElement, field: HTMLInputElement, strip: Pick<Strip, 'solo' | 'face'>): Rows {
  const list = el('ul', 'list');
  list.id = 'list';
  list.tabIndex = -1;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', LIST_TEXT.tabs);
  const empty = el('div', 'empty');
  empty.setAttribute('role', 'status');

  let windows: ListView['windows'] = [];
  let closed: ListView['closed'] = []; // the closed window, after the listed ones (05-events 4.9)
  let icons: (IconSrc | null)[][] = [];
  let mode: StartView['mode'] = 'hold';
  let query = ''; // the search frame's, which the rows' marks follow
  let results: readonly RowRef[] = [];
  let gone: readonly RowRef[] = [];
  const copies = new Map<number, number>(); // duplicate group to its rows still listed (C-HOLD-33)
  let selected: Built | null = null;
  const built: Built[][] = [];
  const refs = new WeakMap<Element, RowRef>();
  let containsRows = false;
  let viewportRows = new Set<Element>();
  const moveBefore = (list as { moveBefore?: HTMLUListElement['moveBefore'] }).moveBefore;

  const isClosed = (ref: RowRef) => ref.window === windows.length;
  const dataOf = (ref: RowRef) => (isClosed(ref) ? closed[ref.row] : windows[ref.window]?.rows[ref.row]) ?? BLANK;
  const iconAt = (ref: RowRef, src: IconSrc | null) => {
    const data = dataOf(ref);
    return iconSlot(src, letterOf(data));
  };

  function updateViewportRows(): void {
    if (!containsRows) return;
    const first = list.firstElementChild;
    const height = first instanceof HTMLElement ? first.offsetHeight : 0;
    if (!height) return;
    const top = list.scrollTop;
    const start = Math.max(0, Math.floor(top / height) - VIEWPORT_BUFFER_ROWS);
    const end = Math.min(list.childElementCount, Math.ceil((top + list.clientHeight) / height) + VIEWPORT_BUFFER_ROWS);

    const near = new Set<Element>();
    for (let i = start; i < end; i++) {
      const row = list.children[i];
      if (row) near.add(row);
    }
    for (const row of viewportRows) {
      if (!near.has(row)) row.classList.remove('near-viewport');
    }
    for (const row of near) {
      if (!viewportRows.has(row)) row.classList.add('near-viewport');
    }
    viewportRows = near;
  }

  function setContainment(): void {
    const enabled = list.childElementCount > ROW_CONTAINMENT_THRESHOLD;
    if (enabled === containsRows) return;
    containsRows = enabled;
    list.classList.toggle('contain-rows', enabled);
    if (enabled) {
      list.addEventListener('scroll', updateViewportRows);
    } else {
      list.removeEventListener('scroll', updateViewportRows);
      for (const row of viewportRows) row.classList.remove('near-viewport');
      viewportRows.clear();
    }
  }

  // The title and domain as this mode and query show them, repainted only when those change (C-HOLD-34, C-SRCH-30,
  // C-SRCH-31); an empty title shows the host, else "Untitled" (C-HOLD-17).
  function paintText(row: Built, data: ListRow): void {
    const key = mode === 'search' ? `search\n${query}` : 'hold';
    if (row.painted === key) return;
    row.painted = key;
    const runs = titleRuns(data, query, mode);
    if (runs.title.length) paintRuns(row.title, runs.title);
    else row.title.textContent = LIST_TEXT.untitled;
    row.name = runs.title.length ? runs.title.map((run) => run.text).join('') : LIST_TEXT.untitled;
    if (row.site) paintRuns(row.site, runs.site);
  }

  // Another window's marker repeats its strip icon at 12 px, numbered where two cells show the same one (C-SRCH-07).
  function paintMarker(row: Built, w: number): void {
    const face = w ? strip.face(w) : undefined;
    if (!row.marker || face === row.face) return;
    row.face = face;
    if (face) row.marker.replaceChildren(iconSlot(face[0], face[1]), face[2] ? String(face[2]) : '');
  }

  // Copies still listed and the age, shown in the right column and spoken as the description (C-HOLD-32, C-HOLD-33,
  // C-A11Y-02); a copy left alone shows none.
  function paintExtras({ li, dup }: Built, data: ListRow): void {
    const n = data.dup === null ? 0 : (copies.get(data.dup) ?? 0);
    dup.textContent = n > 1 ? LIST_TEXT.copies(n) : '';
    const said = [
      n > 1 ? LIST_TEXT.copiesName(n) : '',
      data.age ? LIST_TEXT.ageName(data.age, ageCapped(data.age)) : '',
    ].filter(Boolean);
    if (said.length) li.setAttribute('aria-description', LIST_TEXT.rowName(said));
    else li.removeAttribute('aria-description');
  }

  // Text first; the icon box is already there, so a late icon moves nothing (C-ICON-04). The age box is on every
  // row, so ages hold one x; the 2x box shows only with copies (C-HOLD-32, C-HOLD-33).
  function rowOf(ref: RowRef): Built {
    const { window: w, row: r } = ref;
    const known = built[w]?.[r];
    if (known) return known;
    const data = dataOf(ref);
    const li = el('li', isClosed(ref) ? 'row past' : data.sleeping ? 'row asleep' : 'row');
    li.id = `row-${String(w)}-${String(r)}`;
    li.setAttribute('role', 'option');
    const title = el('span', 'title');
    li.append(iconAt(ref, icons[w]?.[r] ?? null), title);
    // In hold the host the highlight shows sits right after the title and takes room from it alone, so no mark moves;
    // search orders it after the marks and the 2x, so the host ends at one x there (style.css, C-SRCH-21).
    const site = data.title && data.site ? el('span', 'site') : null;
    if (site) li.append(site);
    if (data.pinned) li.append(glyph('pin', PIN)); // C-HOLD-16
    if (data.audible) li.append(glyph('sound', SOUND)); // read at the press, never updated (C-HOLD-25)
    const dup = el('span', 'dup');
    dup.setAttribute('aria-hidden', 'true');
    li.append(dup);
    const marker = isClosed(ref) ? null : el('span', w ? 'marker' : 'marker current');
    if (marker) {
      marker.setAttribute('aria-hidden', 'true');
      li.append(marker);
    } else li.append(glyph('closed', CLOSED));
    const ago = el('span', 'ago');
    ago.setAttribute('aria-hidden', 'true');
    ago.textContent = data.age ? LIST_TEXT.age(data.age, ageCapped(data.age)) : '';
    li.append(ago);
    const row: Built = { li, title, site, dup, marker, face: undefined, painted: '', name: '', label: '' };
    paintExtras(row, data);
    (built[w] ??= [])[r] = row;
    refs.set(li, { window: w, row: r });
    return row;
  }

  // Keep options attached where possible when search narrows or reorders them.
  function placeResults(items: readonly HTMLLIElement[]): void {
    const wanted = new Set<Element>(items);
    if (wanted.size !== items.length) {
      list.replaceChildren(...items);
      return;
    }
    for (let row = list.firstElementChild; row;) {
      const after = row.nextElementSibling;
      if (!wanted.has(row)) row.remove();
      row = after;
    }
    let before = list.firstElementChild;
    for (const row of items) {
      if (row === before) before = row.nextElementSibling;
      else if (moveBefore && row.parentElement === list) moveBefore.call(list, row, before);
      else list.insertBefore(row, before);
    }
  }

  // The accessible name holds the title, in search the domain after it, the sound, Sleeping, the pinned state and, in
  // search, the window, or Recently closed for a closed row, set only when it changes (C-A11Y-02, C-SRCH-27).
  function place(rows: readonly RowRef[], selection: RowRef | null, reuse = false): void {
    const items = rows.map((ref) => {
      const row = rowOf(ref);
      const data = dataOf(ref);
      paintText(row, data);
      if (mode === 'search') paintMarker(row, ref.window);
      const parts = [row.name];
      if (mode === 'search' && data.title && data.site) parts.push(data.site);
      if (data.audible) parts.push(LIST_TEXT.audible);
      if (data.sleeping) parts.push(LIST_TEXT.sleeping);
      if (data.pinned) parts.push(LIST_TEXT.pinned);
      if (isClosed(ref)) parts.push(LIST_TEXT.closed);
      else if (mode === 'search' && !strip.solo()) parts.push(windowName(ref.window));
      const label = LIST_TEXT.rowName(parts);
      if (row.label !== label) row.li.setAttribute('aria-label', (row.label = label));
      return row;
    });
    const lis = items.map((row) => row.li);
    if (reuse) placeResults(lis);
    else list.replaceChildren(...lis);
    setContainment();
    if (mode === 'search') cut(items.flatMap((row) => (row.site ? [row.site] : [])));
    const none = items.length === 0;
    panel.classList.toggle('none', none);
    const status = none ? LIST_TEXT.noResults : ''; // C-SRCH-16
    if (empty.textContent !== status) empty.textContent = status;
    select(selection, true);
  }

  // Live copy counts across windows: open rows only, gone ones left out (C-HOLD-33).
  function count(next: readonly RowRef[]): void {
    gone = next;
    copies.clear();
    windows.forEach((w, window) => {
      w.rows.forEach(({ dup }, row) => {
        if (dup !== null && !hasRow(gone, { window, row })) copies.set(dup, (copies.get(dup) ?? 0) + 1);
      });
    });
    built.forEach((shown, w) => {
      shown.forEach((row, r) => {
        paintExtras(row, dataOf({ window: w, row: r }));
      });
    });
  }

  // A domain cut by its width fades (C-HOLD-35). Every width is read before any class changes, so one layout serves.
  function cut(sites: readonly Element[]): void {
    const over = sites.map((site) => site.scrollWidth > site.clientWidth);
    sites.forEach((site, i) => site.classList.toggle('cut', over[i]));
  }

  // Hold shows the domain on the highlighted row only, telling apart tabs that share a title (C-SRCH-21).
  function mark(next: Built | null): void {
    if (next === selected) return;
    selected?.li.setAttribute('aria-selected', 'false');
    selected = next;
    if (next) {
      const { li, site } = next;
      li.setAttribute('aria-selected', 'true');
      if (site && mode === 'hold') cut([site]);
      list.setAttribute('aria-activedescendant', li.id);
      field.setAttribute('aria-activedescendant', li.id);
    } else {
      list.removeAttribute('aria-activedescendant');
      field.removeAttribute('aria-activedescendant');
    }
  }

  function select(ref: RowRef | null, fromTop = false): void {
    const next = ref ? rowOf(ref) : null;
    mark(next);
    if (next) reveal(list, next.li, true, fromTop);
    else if (fromTop) list.scrollTop = 0;
    updateViewportRows();
  }

  return {
    list,
    empty,
    start(view) {
      ({ windows, closed } = view);
      icons = [...windows, { rows: closed }].map((w) => w.rows.map((r) => r.icon));
      count([]);
    },
    icon(w, r, src) {
      const row = icons[w];
      if (!row) return;
      row[r] = src;
      built[w]?.[r]?.li.firstElementChild?.replaceWith(iconAt({ window: w, row: r }, src));
    },
    faces() {
      if (mode === 'search') for (const ref of results) paintMarker(rowOf(ref), ref.window);
    },
    setMode(next) {
      mode = next;
      if (next === 'search') [results, query] = [[], ''];
      list.classList.toggle('search', next === 'search');
    },
    mode: () => mode,
    setGone: count,
    placeWindow(w, order, selection) {
      const rows = order ?? windows[w]?.rows.map((_, row) => row) ?? [];
      place(
        rows.map((row) => ({ window: w, row })).filter((ref) => !hasRow(gone, ref)),
        selection,
      );
    },
    // A new query repaints its marks even when the results stay (C-SRCH-30).
    showResults(next, highlight, text) {
      const selection = next[highlight] ?? null;
      const placed = list.childElementCount === results.length;
      if (!placed || !sameRefs(results, next) || text !== query) {
        const reuse = placed && results.length > 0 && next.length > 0;
        results = next;
        query = text;
        place(results, selection, reuse);
      } else {
        select(selection);
      }
    },
    select,
    // An inert picture of the shown rows or empty state, outside layout over the live one: no ids, references,
    // selection state or row cache of its own.
    picture() {
      const shown = panel.classList.contains('none') ? empty : list;
      const copy = shown.cloneNode(true) as HTMLElement;
      for (const node of [copy, ...copy.querySelectorAll('[id]')]) node.removeAttribute('id');
      copy.removeAttribute('aria-activedescendant');
      copy.removeAttribute('role');
      copy.setAttribute('aria-hidden', 'true');
      copy.inert = true;
      copy.classList.add('copy');
      Object.assign(copy.style, {
        top: `${String(shown.offsetTop)}px`,
        left: `${String(shown.offsetLeft)}px`,
        width: `${String(shown.offsetWidth)}px`,
        height: `${String(shown.offsetHeight)}px`,
      });
      panel.append(copy);
      copy.scrollTop = shown.scrollTop;
      return copy;
    },
    rowAt(target) {
      const row = target instanceof Element ? target.closest('.row') : null;
      return row ? (refs.get(row) ?? null) : null;
    },
    pageRows() {
      const row = list.firstElementChild;
      const style = getComputedStyle(list);
      const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      return row instanceof HTMLElement && row.offsetHeight > 0
        ? Math.floor((list.clientHeight - pad) / row.offsetHeight)
        : 1;
    },
  };
}
