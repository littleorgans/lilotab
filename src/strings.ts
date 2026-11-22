// English user facing strings shared by the manifest, hosts and pages (01-overview, C-PERF-02).

import { displayName as NAME } from '../package.json';
import type { Age, SortName } from './core/index.ts';

// The Tab order setting's value names, which the list's sort notice names too (C-SET-05, C-HOLD-30).
export const TAB_ORDER_NAMES = { recent: 'Recent', window: 'Window order' } as const;

export const PRODUCT = NAME; // package.json is the one home of the product name

// The switch command's description on the shortcuts page.
export const COMMAND_TEXT = 'Switch to the last used tab; hold for the tab list';
export const SEARCH_COMMAND_TEXT = 'Search all your tabs'; // C-KEY-12

const tabCount = (n: number) => (n === 1 ? '1 tab' : `${String(n)} tabs`);

const AGE_WORDS = { m: 'minute', h: 'hour', d: 'day', w: 'week' } as const;

// The list view, in both hosts.
export const LIST_TEXT = {
  untitled: 'Untitled', // C-HOLD-17
  noResults: 'No matching tabs', // C-SRCH-16
  search: 'Search tabs', // C-SRCH-02, the field's name
  searchIn: (n: number) => `Search ${tabCount(n)}`, // the field's placeholder: the tabs still listed
  tabs: 'Tabs', // the listbox name (C-A11Y-01)
  windows: 'Windows', // the strip's tab list name (C-A11Y-01)
  thisWindow: 'This window', // the source window (C-SRCH-07)
  window: (n: number) => `Window ${String(n)}`,
  tabCount, // a strip cell's name: "Window 3, 13 tabs" (C-WIN-17)
  pinned: 'Pinned', // C-A11Y-02
  sleeping: 'Sleeping', // a discarded tab, which reloads on switching (C-A11Y-02)
  audible: 'Playing sound', // C-HOLD-25, named right after the title (C-A11Y-02)
  rowName: (parts: readonly string[]) => parts.join(', '), // title, sound, pinned state, window; a row's copies and age (C-A11Y-02)
  notCopied: 'Could not copy', // C-SRCH-26
  closed: 'Recently closed', // a recently closed row's accessible name (C-SRCH-27)
  kept: 'Enter switches, Esc closes', // the hint line of a kept list (C-TAP-12)
  // The active order's name (C-HOLD-30); the default orders are the Tab order setting's names.
  sort: { ...TAB_ORDER_NAMES, best: 'Best match', title: 'Title' } satisfies Record<SortName, string>,
  sorted: (name: string) => `Sorted by ${name}`, // the notice on a sort toggle
  copies: (n: number) => `${String(n)}x`, // the duplicate mark (C-HOLD-33)
  copiesName: (n: number) => `${String(n)} copies`,
  // 4m, 3h, 6d, 3w, and 4w+ at the cap (C-HOLD-32)
  age: ({ n, unit }: Age, capped: boolean) => `${String(n)}${unit}${capped ? '+' : ''}`,
  ageName: ({ n, unit }: Age, capped: boolean) =>
    `${capped ? 'over ' : ''}${String(n)} ${AGE_WORDS[unit]}${n === 1 ? '' : 's'} ago`,
} as const;
