// Search ranking: filter and order snapshot rows for a query (C-SRCH-08 to C-SRCH-10, 03-components 4.7).

import type { EpochMs, RowRef } from '../types.ts';
import { normalize, wordStart, words } from './text.ts';

export interface Candidate {
  ref: RowRef;
  title: string;
  url: string;
  first: boolean; // pinned to the top of its tier: the source tab (C-SRCH-08); in hold, each window's current tab (C-HOLD-02)
  lastAccessed: EpochMs | null; // the browser's last active time; null after every timed row
  useRank: number | null; // global recency, 0 most recent; null = never activated
  windowRank: number; // window recency; 0 is the source window, so it also settles the current window tie
  barIndex: number; // tab bar position in its window; a recently closed row's place, most recent first
  closed: boolean; // a recently closed tab (C-SRCH-27)
}

// 0: every word starts a title word; 1: every word in the title; 2: the rest that match; null: no match.
function tier(query: readonly string[], c: Candidate): number | null {
  const title = normalize(c.title);
  const url = normalize(c.url);
  if (!query.every((w) => title.includes(w) || url.includes(w))) return null;
  if (query.every((w) => wordStart(title, w) >= 0)) return 0;
  return query.every((w) => title.includes(w)) ? 1 : 2;
}

export type Recency = Pick<Candidate, 'first' | 'lastAccessed' | 'useRank' | 'windowRank' | 'barIndex'>;

// The first row, then last active time, then most recent use, then window recency (current window first) and tab bar
// order: Recent lists in hold and search (C-HOLD-02, C-SRCH-08, C-SRCH-10).
export function byRecency(a: Recency, b: Recency): number {
  const time = (c: Recency) => c.lastAccessed ?? -Infinity;
  const use = (c: Recency) => c.useRank ?? Infinity;
  return (
    Number(b.first) - Number(a.first) ||
    time(b) - time(a) ||
    use(a) - use(b) ||
    a.windowRank - b.windowRank ||
    a.barIndex - b.barIndex
  );
}

// An empty query lists every open row in tie order (C-SRCH-08); recently closed rows join only a typed query, after
// the open rows of their tier, since they are never used and their window ranks last (C-SRCH-27).
export function rank(query: string, candidates: readonly Candidate[]): readonly RowRef[] {
  const q = words(query);
  return candidates
    .flatMap((c) => {
      const t = q.length ? tier(q, c) : c.closed ? null : 0;
      return t === null ? [] : [{ c, t }];
    })
    .sort((a, b) => a.t - b.t || byRecency(a.c, b.c))
    .map(({ c }) => c.ref);
}

// One collator in the browser's locale (03-components 4.7): case and accents ignored, NFC and NFD alike, numbers
// compared as numbers, and Thai leading vowels read after their consonant.
const TITLES = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;

// What title order compares (C-HOLD-31): the title from its first letter, so a count, emoji or mark prefix is skipped
// and combining marks stay with their letter; with no letter from its first digit; with neither the whole title. The
// host the row shows for an empty title (C-HOLD-17).
export function titleKey(title: string, host: string): string {
  if (!title) return host;
  const letter = title.search(LETTER);
  return title.slice(Math.max(0, letter < 0 ? title.search(DIGIT) : letter));
}

// items by their title key, ties in their given order: the default order (C-HOLD-31).
export const titleOrder = <T>(items: readonly T[], key: (item: T) => string): T[] =>
  items
    .map((item) => ({ item, key: key(item) }))
    .sort((a, b) => TITLES.compare(a.key, b.key))
    .map(({ item }) => item);
