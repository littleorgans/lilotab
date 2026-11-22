// Shared DOM renderer for both hosts (03-components 3.3): strip, rows, search field and selection from the start
// view and frames, text before icons, listbox semantics, and the frozen look. Never sends messages or reads keys.

import { QUERY_MAX, type Frame, type HostMode, type ListView, type StartView } from '../../core/protocol/index.ts';
import type { HostSurface } from '../../core/seams.ts';
import { rowsLeft, type RowRef } from '../../core/types.ts';
import { LIST_TEXT } from '../../strings.ts';
import { createClipboard } from './clipboard.ts';
import { createNotice } from './notice.ts';
import { el, sameOrder, sameRefs } from './paint.ts';
import { createRows } from './rows.ts';
import { createStrip } from './strip.ts';
import css from './style.css?inline';

export type Flavor = 'overlay' | 'popup';

export interface ListSurface extends HostSurface {
  readonly element: HTMLElement; // the panel; the host reads row clicks on it
  readonly field: HTMLInputElement;
  readonly list: HTMLUListElement; // the host scrolls this container on wheel input
  latch(): void; // host local switch to search: field in the strip's place, shown, focused (03 4.12)
  unlatch(): void; // host local switch back to hold (T-67): the strip back, the field gone, no highlight
  // Starts the close at once and makes the list inert: a fade on a cancel, else a cut (03 4.12, C-A11Y-04).
  hide(fade: boolean): void;
  focus(): void; // the field in search, else the list (the popup takes focus; the overlay leaves it to the page)
  inField(): boolean;
  rowAt(target: EventTarget | null): RowRef | null;
  pageRows(): number; // the whole rows the list shows (K-32)
  // Copies in the trusted key handler, or says it could not when text is null or the browser refuses (C-SRCH-26).
  copy(text: string | null): void;
}

// The one source of list motion (02-contract, List motion): open, cancel close, search swap and the sort cross fade.
const MOTION = {
  open: 100,
  close: 70,
  swap: 90,
  enter: 'cubic-bezier(0.2, 0, 0, 1)',
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
} as const;
const REDUCE = '(prefers-reduced-motion: reduce)';

// Animations and the cleanup they own. Ending a run applies its final state at once: it cancels what still runs and
// cleans up once, so a superseded run never touches what a later one owns.
interface Run {
  end(): void;
}

// Animations that join the rows' cross fade, and what to undo when it ends.
interface Joined {
  fades: readonly Animation[];
  cleanup(): void;
}
const ALONE: Joined = { fades: [], cleanup: () => undefined };

let sheet: CSSStyleSheet | null = null;

export function createListSurface(root: Document | ShadowRoot, flavor: Flavor): ListSurface {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
  }
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];

  const panel = el('div', `panel ${flavor}`);
  const head = el('div', 'head');
  const field = el('input', 'field');
  const box = 'body' in root ? root.body : root;
  const strip = createStrip();
  const rows = createRows(panel, field, strip);
  const notice = createNotice();
  const clipboard = createClipboard(root, box, notice);
  field.type = 'text';
  field.maxLength = QUERY_MAX;
  field.autocomplete = 'off';
  field.spellcheck = false;
  field.setAttribute('role', 'combobox');
  field.setAttribute('aria-label', LIST_TEXT.search);
  field.setAttribute('aria-autocomplete', 'list');
  field.setAttribute('aria-expanded', 'true');
  field.setAttribute('aria-controls', rows.list.id);
  // The hint line: only a kept Keep list open list shows it (C-TAP-12).
  const foot = el('p', 'foot');
  panel.append(rows.list, rows.empty, notice.element);

  let windows: ListView['windows'] = [];
  let gone: readonly RowRef[] = []; // hidden in hold (C-HOLD-14); search results already omit them
  let order: readonly number[] | null = null; // the shown window's rows in title order, null for the snapshot order
  let painted: { mode: HostMode; title: boolean } | null = null; // the last frame's mode and whether it was Title
  let shownWindow = -1;
  let reduceMotion: StartView['look']['reduceMotion'] = 'system';
  let keep = false; // On release Keep list open (C-SET-30)
  const reduced = matchMedia(REDUCE);
  const runs = new Set<Run>();
  let fading: Run | null = null;
  const { promise: removed, resolve: release } = Promise.withResolvers<undefined>(); // the panel is gone

  // Nothing animates when motion is reduced; Never moves whatever the OS asks (C-A11Y-04, C-SET-08).
  const moves = () => reduceMotion === 'never' || (reduceMotion === 'system' && !reduced.matches);
  const settle = () => {
    for (const run of runs) run.end(); // a run deletes itself; Set iteration allows it
  };
  // An OS change to reduce mid motion finishes it at once (C-A11Y-04).
  const onReduce = () => {
    if (!moves()) settle();
  };
  reduced.addEventListener('change', onReduce);

  function animate(animations: readonly Animation[], cleanup: () => void = () => undefined): Run {
    let over = false;
    const run: Run = {
      end() {
        if (over) return;
        over = true;
        runs.delete(run);
        for (const a of animations) a.cancel();
        cleanup();
      },
    };
    runs.add(run);
    Promise.all(animations.map((a) => a.finished)).then(
      () => {
        run.end();
      },
      () => undefined, // cancelled: the run already ended
    );
    return run;
  }

  const swapFade = (node: Element, opacity: [number, number]): Animation =>
    node.animate({ opacity }, { duration: MOTION.swap, easing: MOTION.enter });

  const setRows = (n: number) => {
    panel.style.setProperty('--rows', String(n));
  };
  // Open (02-contract, List motion): the overlay fades and grows about its centre, the popup's window holds still and
  // only its content fades. Later frames never replay it.
  const setShown = (shown: boolean) => {
    const was = panel.classList.contains('shown');
    panel.classList.toggle('shown', shown);
    if (!shown || was || !moves()) return;
    const timing = { duration: MOTION.open, easing: MOTION.enter };
    animate(
      flavor === 'overlay'
        ? [panel.animate({ opacity: [0, 1], transform: ['scale(0.98)', 'none'] }, timing)]
        : [...panel.children].map((child) => child.animate({ opacity: [0, 1] }, timing)),
    );
  };
  const holdRows = () => Math.max(...windows.map((w) => w.rows.length)); // the tallest window (C-WIN-15)

  // With one listed window left the strip goes, as at start (C-WIN-10); in search the head keeps the field.
  function fillStrip(): void {
    strip.fill((w) => rowsLeft(windows, gone, w));
    panel.classList.toggle('solo', strip.solo());
    if (strip.solo() && rows.mode() === 'hold') head.remove();
  }

  // fresh: the gone rows or the order changed, so the shown window's rows are placed again.
  function showWindow(w: number, selection: RowRef | null, fresh = false): void {
    if (w === shownWindow && !fresh) {
      rows.select(selection);
    } else {
      shownWindow = w;
      strip.show(w);
      rows.placeWindow(w, order, selection);
    }
  }

  // The rows' cross fade (02-contract, List motion): a picture of the outgoing rows fades out while the live list fades
  // in, so a slow worker reply replaces those rows when it arrives; it cannot hold the animation or its cleanup open.
  // more joins the same run with its cleanup. Instant until the list shows.
  function crossFade(change: () => void, more: (moving: boolean) => Joined = () => ALONE): void {
    settle();
    const moving = moves() && panel.classList.contains('shown');
    const copy = moving ? rows.picture() : null;
    const extra = more(moving);
    if (copy) {
      const fades = [swapFade(copy, [1, 0]), swapFade(rows.list, [0, 1]), swapFade(rows.empty, [0, 1])];
      animate([...fades, ...extra.fades], () => {
        copy.remove();
        extra.cleanup();
      });
    }
    change();
  }

  // Search swap: strip and field share the head's one grid cell and cross fade with the rows. next is the head's
  // incoming side, null with one window (C-WIN-10). Only F mode changes swap.
  function swap(next: HTMLElement | null, change: () => void): void {
    crossFade(change, (moving) => {
      const prior = head.isConnected ? head.firstElementChild : null;
      if (next) {
        if (moving) head.append(next);
        else head.replaceChildren(next);
        panel.prepend(head);
      } else if (!moving) head.remove();
      if (!moving) return ALONE;
      return {
        fades: [prior && swapFade(prior, [1, 0]), next && swapFade(next, [0, 1])].filter((a) => a !== null),
        cleanup: () => {
          prior?.remove();
          if (!next) head.remove();
        },
      };
    });
  }

  function enterSearch(): void {
    swap(field, () => {
      field.value = '';
      rows.setMode('search');
      const listed = windows.reduce((n, w) => n + w.rows.length, 0);
      setRows(listed);
      field.placeholder = LIST_TEXT.searchIn(listed - gone.length); // scale at a glance, without the strip
      setShown(true);
      if (keep) foot.textContent = LIST_TEXT.kept;
      field.focus({ preventScroll: true });
    });
  }

  // The shown window's rows again; the hold frame that follows sets the window and the highlight. The field keeps
  // its text while it fades out; entering search empties it.
  function leaveSearch(): void {
    swap(strip.solo() ? null : strip.element, () => {
      rows.setMode('hold');
      setRows(holdRows());
      const shown = Math.max(shownWindow, 0);
      shownWindow = -1;
      showWindow(shown, null);
    });
  }

  function removePanel(): void {
    reduced.removeEventListener('change', onReduce);
    notice.dispose();
    panel.remove();
    release(undefined);
  }

  // The session paints only frames of the shown mode (05 4.5), so the frame's mode picks the branch. Both carry the
  // rows closed with the close key, for counts and copies (C-WIN-17, C-HOLD-33).
  function paint(frame: Frame): void {
    const fresh = !sameRefs(gone, frame.gone);
    gone = frame.gone;
    if (fresh) {
      rows.setGone(gone);
      fillStrip();
    }
    if (frame.mode === 'hold') {
      const sorted = !sameOrder(order, frame.order);
      order = frame.order;
      setShown(frame.visible);
      showWindow(frame.window, { window: frame.window, row: frame.row }, fresh || sorted);
      foot.textContent = keep && frame.open ? LIST_TEXT.kept : '';
      return;
    }
    rows.showResults(frame.results, frame.highlight, frame.query);
  }

  // A toggle between the default order and Title cross fades the rows, and the notice names the new order
  // (C-HOLD-29, C-HOLD-30, C-SRCH-29).
  function update(frame: Frame): void {
    const title = frame.sort === 'title';
    const toggled = painted?.mode === frame.mode && painted.title !== title;
    painted = { mode: frame.mode, title };
    if (!toggled) {
      paint(frame);
      return;
    }
    crossFade(() => {
      paint(frame);
    });
    notice.say(LIST_TEXT.sorted(LIST_TEXT.sort[frame.sort]));
  }

  box.append(panel);

  return {
    element: panel,
    field,
    list: rows.list,
    start(s) {
      windows = s.view.windows;
      rows.start(s.view);
      panel.classList.add(s.look.theme);
      if (s.look.textSize === 'large') panel.classList.add('large');
      reduceMotion = s.look.reduceMotion;
      keep = s.mode === 'hold' && s.onRelease === 'keep';
      if (keep) notice.element.before(foot);
      setRows(holdRows());
      // No strip with one listed window (C-WIN-10).
      if (windows.length > 1) {
        strip.build(windows);
        fillStrip();
        head.replaceChildren(strip.element);
        panel.prepend(head);
      } else panel.classList.add('solo');
      if (s.mode === 'search') enterSearch();
      update(s.frame);
    },
    update,
    icons(patch) {
      let faced = false;
      for (const { w, r, src } of patch) {
        rows.icon(w, r, src);
        faced = strip.icon(w, r, src) || faced;
      }
      if (faced) rows.faces();
    },
    latch: enterSearch,
    unlatch: leaveSearch,
    // A repeated hide never restarts the fade; a cut ends it at once. Only a shown list fades.
    hide(fade) {
      if (fading) {
        if (!fade) fading.end();
        return;
      }
      const opacity = Number(getComputedStyle(panel).opacity); // from where a cancelled open left it
      panel.inert = true;
      settle();
      if (!fade || !moves() || !panel.classList.contains('shown') || !panel.isConnected) {
        setShown(false);
        return;
      }
      const timing = { duration: MOTION.close, easing: MOTION.exit, fill: 'forwards' } as const;
      fading = animate([panel.animate({ opacity: [opacity, 0] }, timing)], removePanel);
    },
    focus() {
      (rows.mode() === 'search' ? field : rows.list).focus({ preventScroll: true });
    },
    inField: () => root.activeElement === field,
    rowAt: (target) => rows.rowAt(target),
    pageRows: () => rows.pageRows(),
    copy: (text) => {
      clipboard.copy(text);
    },
    // Waits for a started fade, else removes at once.
    close() {
      if (!fading) {
        settle();
        removePanel();
      }
      return removed;
    },
  };
}
