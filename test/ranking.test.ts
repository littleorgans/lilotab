// TB-06 ranking.rank (07-tests 2.1): search results for a query over the rows frozen at the press.

import { describe, expect, it } from 'vite-plus/test';
import {
  DEFAULTS,
  TITLE_MAX,
  buildSnapshot,
  candidates,
  rank,
  sameRow,
  titleKey,
  titleOrder,
  type Candidate,
} from '../src/core/index.ts';
import { history, live, tab, win } from './data-fixtures.ts';

// A candidate by title; it sits in the current window, at its row's index in the tab bar, unless the row says otherwise.
type Row = { title: string } & Partial<Omit<Candidate, 'ref' | 'title'>>;

function titles(query: string, rows: readonly Row[]) {
  const all = rows.map((r, i): Candidate => {
    const windowRank = r.windowRank ?? 0;
    const barIndex = r.barIndex ?? i;
    const url = `https://${r.title.toLowerCase().replaceAll(/\W+/gu, '')}.example/`;
    return {
      url,
      first: false,
      lastAccessed: null,
      useRank: null,
      closed: false,
      ...r,
      windowRank,
      barIndex,
      ref: { window: windowRank, row: barIndex },
    };
  });
  return rank(query, all).map((ref) => all.find((c) => sameRow(c.ref, ref))?.title);
}

describe('TB-06 ranking.rank', () => {
  it.each<{ name: string; query: string; rows: Row[]; expected: string[] }>([
    {
      name: 'C-SRCH-08 C-SRCH-06 empty query: source tab, then by last active time, then by use, then untimed by window recency and tab bar order',
      query: '',
      rows: [
        { title: 'Used, untimed', useRank: 2, windowRank: 1, barIndex: 2 },
        { title: 'Older', lastAccessed: 1000, useRank: 1, windowRank: 1, barIndex: 0 },
        { title: 'Source', first: true, lastAccessed: 500, useRank: 3, windowRank: 0, barIndex: 0 },
        { title: 'Latest', lastAccessed: 3000, windowRank: 1, barIndex: 1 },
        { title: 'Same time, more recently used', lastAccessed: 1000, useRank: 0, windowRank: 0, barIndex: 2 },
        { title: 'Here, later in bar', windowRank: 0, barIndex: 4 },
        { title: 'Here, early in bar', windowRank: 0, barIndex: 3 },
      ],
      expected: [
        'Source',
        'Latest',
        'Same time, more recently used',
        'Older',
        'Used, untimed',
        'Here, early in bar',
        'Here, later in bar',
      ],
    },
    {
      name: 'C-SRCH-09 case and accents are ignored',
      query: 'CAFE',
      rows: [{ title: 'Café menu' }, { title: 'Tea room' }],
      expected: ['Café menu'],
    },
    {
      name: 'C-SRCH-09 every word must match',
      query: 'project plan',
      rows: [{ title: 'Project plan' }, { title: 'Project notes' }],
      expected: ['Project plan'],
    },
    {
      name: 'C-SRCH-09 a match in the address counts',
      query: 'mail',
      rows: [{ title: 'Inbox', url: 'https://mail.example.com/' }, { title: 'Calendar' }],
      expected: ['Inbox'],
    },
    {
      name: 'C-SRCH-10 a word start in the title beats a match inside the title, whatever the recency',
      query: 'book',
      rows: [
        { title: 'Notebook', useRank: 0 },
        { title: 'Book club', useRank: 5 },
      ],
      expected: ['Book club', 'Notebook'],
    },
    {
      name: 'C-SRCH-10 a match after a supplementary letter is inside the title word',
      query: '𐐩',
      rows: [
        { title: '𐐨𐐩', useRank: 0 },
        { title: '𐐩 notes', useRank: 1 },
        { title: '📝𐐩', useRank: 2 },
      ],
      expected: ['𐐩 notes', '📝𐐩', '𐐨𐐩'],
    },
    {
      name: 'C-SRCH-10 a match inside the title beats an address only match, whatever the recency',
      query: 'docs',
      rows: [
        { title: 'Home', url: 'https://docs.example.com/', useRank: 0 },
        { title: 'Webdocs', useRank: 5 },
      ],
      expected: ['Webdocs', 'Home'],
    },
    {
      name: 'C-SRCH-10 a tie goes to the source tab, then the last active tab, whatever the use order',
      query: 'mail',
      rows: [
        { title: 'Mail', lastAccessed: 1000, useRank: 0 },
        { title: 'Mail too', lastAccessed: 2000, useRank: 3 },
        { title: 'Mail here', first: true, lastAccessed: 500, useRank: 4 },
      ],
      expected: ['Mail here', 'Mail too', 'Mail'],
    },
    {
      name: 'C-SRCH-10 a tie in time goes to the most recent tab',
      query: 'mail',
      rows: [
        { title: 'Mail', lastAccessed: 1000, useRank: 3 },
        { title: 'Mail too', lastAccessed: 1000, useRank: 1 },
      ],
      expected: ['Mail too', 'Mail'],
    },
    {
      name: 'C-SRCH-10 a tie between never used tabs goes to the current window',
      query: 'mail',
      rows: [
        { title: 'Mail there', windowRank: 1 },
        { title: 'Mail here', windowRank: 0, barIndex: 4 },
      ],
      expected: ['Mail here', 'Mail there'],
    },
    {
      name: 'C-SRCH-27 recently closed rows follow the open rows of their tier, most recently closed first',
      query: 'mail',
      rows: [
        { title: 'Mail closed later', closed: true, windowRank: 2, barIndex: 1 },
        { title: 'Webmail', useRank: 0 },
        { title: 'Mail closed', closed: true, windowRank: 2, barIndex: 0 },
        { title: 'Mail never used', windowRank: 1 },
        { title: 'Mail', useRank: 3 },
      ],
      expected: ['Mail', 'Mail never used', 'Mail closed', 'Mail closed later', 'Webmail'],
    },
    {
      name: 'C-SRCH-27 an empty query lists no recently closed rows',
      query: '',
      rows: [{ title: 'Open' }, { title: 'Closed', closed: true, windowRank: 1, barIndex: 0 }],
      expected: ['Open'],
    },
  ])('$name', ({ query, rows, expected }) => {
    expect(titles(query, rows)).toEqual(expected);
  });

  it('C-SRCH-19 search reads the full title frozen at the press, beyond the cut hosts show', () => {
    const facts = live(win(1, 1, 1, tab(2, { title: `${'x'.repeat(TITLE_MAX)} needle` })));
    const s = buildSnapshot(history(facts), facts, DEFAULTS, { tabId: 1, windowId: 1 }, [], 0);
    const rows = s ? candidates(s) : [];
    expect(rank('needle', rows).map((ref) => s?.windows[ref.window]?.rows[ref.row]?.tabId)).toEqual([2]);
  });

  // Titles in their default order in, title order out; hosts example.com.
  it.each([
    { name: 'ignores the leading count', titles: ['(828) Zebra', 'Apple'], expected: ['Apple', '(828) Zebra'] },
    {
      name: 'folds case and accents',
      titles: ['zebra', 'Écrin', 'Banana', 'apple'],
      expected: ['apple', 'Banana', 'Écrin', 'zebra'],
    },
    {
      name: 'compares numbers as numbers',
      titles: ['Tab 10', 'Tab 9', 'Tab 2'],
      expected: ['Tab 2', 'Tab 9', 'Tab 10'],
    },
    {
      name: 'keeps ties in the default order',
      titles: ['beta', 'Alpha', 'BETA', 'alpha'],
      expected: ['Alpha', 'alpha', 'beta', 'BETA'],
    },
  ])('C-HOLD-31 title order $name', ({ titles, expected }) => {
    expect(titleOrder(titles, (t) => titleKey(t, 'example.com'))).toEqual(expected);
  });
});
