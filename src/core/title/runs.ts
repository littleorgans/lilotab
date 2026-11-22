// A row's title and domain as runs to paint (C-HOLD-34, C-SRCH-30, C-SRCH-31): noise in the quiet colour, each query
// word's mark in full ink over it, and in search the site name left out when the domain shows. Run in hosts; they
// import this file alone, never the suffix rule.

import type { HostMode, ListRow, Noise } from '../protocol/messages.ts';
import { foldMap, wordStart, words, type Folded } from '../ranking/text.ts';

export interface Run {
  text: string;
  kind: 'plain' | 'noise' | 'mark';
}
export interface Runs {
  title: readonly Run[]; // empty for a row with neither title nor host: the host shows "Untitled" (C-HOLD-17)
  site: readonly Run[]; // the domain column, empty when the row shows its host as its title (C-SRCH-21)
}

const NOISE = 1;
const MARK = 2;

// Whether the title holds word only where it reaches into the site name, so leaving that out would hide the match.
function onlyInTail(fold: Folded, word: string, tail: number): boolean {
  let found = false;
  for (let i = fold.text.indexOf(word); i >= 0; i = fold.text.indexOf(word, i + 1)) {
    if ((fold.to[i + word.length - 1] ?? 0) <= tail) return false;
    found = true;
  }
  return found;
}

// Each word's first occurrence at a word start, else its first occurrence, mapped back to source offsets.
function mark(flags: Uint8Array, fold: Folded, query: readonly string[]): void {
  for (const word of query) {
    const start = wordStart(fold.text, word);
    const i = start >= 0 ? start : fold.text.indexOf(word);
    if (i >= 0) flags.fill(MARK, fold.from[i], fold.to[i + word.length - 1]);
  }
}

function runsOf(text: string, flags: Uint8Array): Run[] {
  const runs: Run[] = [];
  for (let i = 0; i < text.length;) {
    const flag = flags[i] ?? 0;
    let end = i + 1;
    while (end < text.length && flags[end] === flag) end++;
    runs.push({ text: text.slice(i, end), kind: flag & MARK ? 'mark' : flag & NOISE ? 'noise' : 'plain' });
    i = end;
  }
  return runs;
}

const NO_NOISE: Noise = { lead: 0, tail: null };
const NO_FOLD: Folded = { text: '', from: [], to: [] };

// Hold marks nothing. In search a row that shows its domain leaves out the site name, unless a query word the title holds
// only there is missing from the domain: then it stays, dimmed and marked. Ranking and copy keep the reported title.
export function titleRuns(row: Pick<ListRow, 'title' | 'site' | 'noise'>, query: string, mode: HostMode): Runs {
  const terms = mode === 'search' ? words(query) : [];
  const site = row.title ? row.site : '';
  const { lead, tail } = row.title ? row.noise : NO_NOISE;
  // With no query word nothing is marked, so hold and an empty query skip the folds; a list opens with every row.
  const marking = terms.length > 0;
  const siteFold = marking ? foldMap(site) : NO_FOLD;
  const full = row.title || row.site;
  const fullFold = marking ? foldMap(full) : NO_FOLD;
  const drop =
    mode === 'search' &&
    site !== '' &&
    tail !== null &&
    !terms.some((w) => onlyInTail(fullFold, w, tail) && !siteFold.text.includes(w));
  const text = drop ? full.slice(0, tail) : full;
  const flags = new Uint8Array(text.length);
  flags.fill(NOISE, 0, lead);
  if (tail !== null && tail < text.length) flags.fill(NOISE, tail);
  const siteFlags = new Uint8Array(site.length);
  if (marking) {
    mark(flags, drop ? foldMap(text) : fullFold, terms);
    mark(siteFlags, siteFold, terms);
  }
  return { title: runsOf(text, flags), site: runsOf(site, siteFlags) };
}
