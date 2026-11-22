// The window strip: one cell per listed window, and the shown one selected.

import { letterOf } from '../../core/icon.ts';
import type { IconSrc, ListView } from '../../core/protocol/index.ts';
import { LIST_TEXT } from '../../strings.ts';
import { el, glyph, iconSlot, reveal, SOUND, windowName } from './paint.ts';

// A window's face: its cell's icon and letter, and its place in strip order among the cells showing the same one, 0
// when no other does. Search markers repeat it (C-SRCH-07).
export type Face = readonly [src: IconSrc | null, letter: string, nth: number];

export interface Strip {
  readonly element: HTMLElement;
  build(windows: ListView['windows']): void;
  fill(left: (w: number) => number): void; // each window's rows still listed: its count, and no cell at none
  solo(): boolean; // one listed window: no strip (C-WIN-10)
  show(w: number): void;
  icon(w: number, r: number, src: IconSrc | null): boolean; // the cell half of an icon patch; true: a face changed
  face(w: number): Face | undefined; // the same object until the faces change
}

export function createStrip(): Strip {
  const element = el('div', 'strip');
  element.setAttribute('role', 'tablist');
  element.setAttribute('aria-label', LIST_TEXT.windows);

  let cells: HTMLElement[] = [];
  let counts: HTMLElement[] = [];
  let currents: number[] = [];
  let letters: string[] = [];
  let srcs: (IconSrc | null)[] = [];
  let faces: Face[] = [];
  let sounds: boolean[] = [];
  let shown = -1;

  const number = () => {
    const keys = srcs.map((src, w) => src ?? letters[w]);
    faces = keys.map((key, w) => [
      srcs[w] ?? null,
      letters[w] ?? '',
      keys.indexOf(key) === keys.lastIndexOf(key) ? 0 : keys.slice(0, w + 1).filter((k) => k === key).length,
    ]);
  };

  return {
    element,
    // Strip icon: each window's current row (C-WIN-01), over its tab count (C-WIN-17); a speaker at its corner when
    // a tab in it was playing sound at the press (C-HOLD-25).
    build(windows) {
      currents = windows.map((w) => w.current);
      sounds = windows.map((w) => w.rows.some((r) => r.audible));
      letters = windows.map(({ rows, current }) => (rows[current] ? letterOf(rows[current]) : ''));
      srcs = windows.map((w) => w.rows[w.current]?.icon ?? null);
      number();
      counts = windows.map(() => el('span', 'count'));
      cells = windows.map((w, i) => {
        const cell = el('div', 'cell');
        cell.setAttribute('role', 'tab');
        cell.setAttribute('aria-selected', 'false');
        cell.append(iconSlot(srcs[i] ?? null, letters[i] ?? ''));
        if (counts[i]) cell.append(counts[i]);
        if (sounds[i]) cell.append(glyph('sound', SOUND));
        return cell;
      });
      element.replaceChildren(...cells);
    },
    // Counts follow the close key; a window whose rows were all closed with it leaves the strip (C-WIN-01, T-24).
    fill(left) {
      element.replaceChildren(
        ...cells.filter((cell, w) => {
          const n = left(w);
          const parts = [windowName(w), LIST_TEXT.tabCount(n)];
          if (sounds[w]) parts.push(LIST_TEXT.audible);
          cell.setAttribute('aria-label', LIST_TEXT.rowName(parts));
          counts[w]?.replaceChildren(String(n));
          return n > 0;
        }),
      );
    },
    solo: () => element.childElementCount < 2,
    // The shown window is selected (C-WIN-03, C-A11Y-01).
    show(w) {
      cells[shown]?.setAttribute('aria-selected', 'false');
      shown = w;
      const cell = cells[w];
      if (cell) {
        cell.setAttribute('aria-selected', 'true');
        reveal(element, cell, false);
      }
    },
    icon(w, r, src) {
      if (currents[w] !== r) return false;
      srcs[w] = src;
      number();
      cells[w]?.firstElementChild?.replaceWith(iconSlot(src, letters[w] ?? ''));
      return true;
    },
    face: (w) => faces[w],
  };
}
