// Painting helpers the list view's parts share; no state of their own.

import type { IconSrc } from '../../core/protocol/index.ts';
import { sameRow, type RowRef } from '../../core/types.ts';
import { LIST_TEXT } from '../../strings.ts';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

const SVG = 'http://www.w3.org/2000/svg';

// A speaker with two waves (C-HOLD-25).
export const SOUND = [
  { fill: 'currentColor', d: 'M2 6h2.5L8 3v10L4.5 10H2z' },
  {
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.4',
    'stroke-linecap': 'round',
    d: 'M10.5 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6.5 6.5 0 0 1 0 9',
  },
];

// A row or cell glyph; the row's or cell's accessible name already says what it shows.
export function glyph(className: string, paths: readonly Record<string, string>[]): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  for (const attrs of paths) {
    const path = document.createElementNS(SVG, 'path');
    for (const [name, value] of Object.entries(attrs)) path.setAttribute(name, value);
    svg.append(path);
  }
  return svg;
}

// The 16 px icon slot of a row or a strip cell: the image, or the site's letter tile for none or one that fails to
// decode (C-ICON-03). A decoded icon shows as it is, in every theme (C-ICON-08). letter is letterOf the row.
export function iconSlot(src: IconSrc | null, letter: string): HTMLElement {
  const tile = () => {
    const span = el('span', 'icon letter');
    span.textContent = letter;
    return span;
  };
  if (src === null) return tile();
  const img = el('img', 'icon');
  img.alt = '';
  img.addEventListener(
    'error',
    () => {
      img.replaceWith(tile());
    },
    { once: true },
  );
  img.src = src;
  return img;
}

// The source window is window 0 (05-events 4.9).
export const windowName = (w: number) => (w === 0 ? LIST_TEXT.thisWindow : LIST_TEXT.window(w + 1));

export const sameRefs = (a: readonly RowRef[], b: readonly RowRef[]) =>
  a.length === b.length && a.every((r, i) => b[i] !== undefined && sameRow(r, b[i]));

export const sameOrder = (a: readonly number[] | null, b: readonly number[] | null) =>
  a === b || (a !== null && b !== null && a.length === b.length && a.every((r, i) => r === b[i]));

// Keeps child in view by scrolling its container only, never the page (C-HOLD-19), and its neighbours too while they
// exist, so an edge fade only ever covers a row or cell past the selection. Rows and cells keep whole positions.
// A new list starts at the top. Resolve reveal from there before the one scroll write.
export function reveal(box: HTMLElement, child: HTMLElement, vertical: boolean, fromTop = false): void {
  const near = (n: Element | null) => (n instanceof HTMLElement ? n : child);
  const [prev, next] = [near(child.previousElementSibling), near(child.nextElementSibling)];
  const [start, end, scroll, view] = vertical
    ? [prev.offsetTop, next.offsetTop + next.offsetHeight, fromTop ? 0 : box.scrollTop, box.clientHeight]
    : [prev.offsetLeft, next.offsetLeft + next.offsetWidth, box.scrollLeft, box.clientWidth];
  // Each edge's own padding (the list's top and bottom differ), so rows land on the row grid and the end is reached.
  const style = getComputedStyle(box);
  const [before, after] = vertical ? [parseFloat(style.paddingTop), parseFloat(style.paddingBottom)] : [0, 0];
  let to = scroll;
  if (start - before < scroll) to = start - before;
  else if (end + after > scroll + view) to = end + after - view;
  if (vertical) box.scrollTop = to;
  else box.scrollLeft = to;
}
