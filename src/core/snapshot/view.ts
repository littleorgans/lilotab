// What hosts may read of a snapshot: the list view, the copy text and the icon keys (03-components 4.6).

import {
  AGE_MAX,
  SITE_MAX,
  TITLE_MAX,
  URL_MAX,
  fitText,
  type Age,
  type CopyText,
  type ListRow,
  type ListView,
  type Noise,
} from '../protocol/index.ts';
import { titleNoise } from '../title/noise.ts';
import type { EpochMs, RowRef } from '../types.ts';
import { urlParts } from '../url.ts';
import { rowOf, type SnapRow, type SnapWindow, type Snapshot } from './index.ts';

const UNIT_MS = [
  ['w', 604_800_000],
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['m', 60_000],
] as const;

// The time since time at the press's wall stamp, floored once in the largest unit it reaches, weeks held at AGE_MAX;
// null under a minute, in the future or with no time (C-HOLD-32).
export function ageOf(wall: EpochMs, time: EpochMs | null): Age | null {
  const ms = time === null ? NaN : wall - time;
  for (const [unit, size] of UNIT_MS)
    if (ms >= size) return { n: Math.min(Math.floor(ms / size), AGE_MAX[unit]), unit };
  return null;
}

// Open rows sharing an address less its fragment, across windows: one group number per row, numbered in list order;
// null for a row alone or an empty address. Recently closed rows never count (C-HOLD-33).
function duplicates(windows: readonly SnapWindow[]): (number | null)[][] {
  const keyOf = (url: string) => url.split('#', 1)[0] ?? '';
  const count = new Map<string, number>();
  for (const w of windows) for (const { url } of w.rows) count.set(keyOf(url), (count.get(keyOf(url)) ?? 0) + 1);
  const groups = new Map<string, number>();
  return windows.map((w) =>
    w.rows.map(({ url }) => {
      const key = keyOf(url);
      if (!key || (count.get(key) ?? 0) < 2) return null;
      if (!groups.has(key)) groups.set(key, groups.size);
      return groups.get(key) ?? null;
    }),
  );
}

// The full title's noise on its display cut: the site name only when the title was not cut, the count only when a
// nonblank body follows it in the cut (C-HOLD-34).
const cutNoise = ({ lead, tail }: Noise, full: string, shown: string): Noise => ({
  lead: /\S/u.test(shown.slice(lead)) ? lead : 0,
  tail: shown.length === full.length ? tail : null,
});

type Shown = Pick<SnapRow, 'title' | 'url' | 'pinned' | 'audible' | 'sleeping'>;

function listRow(row: Shown, age: Age | null, dup: number | null): ListRow {
  const title = fitText(row.title, TITLE_MAX);
  const { host } = urlParts(row.url);
  return {
    title,
    site: fitText(host, SITE_MAX),
    pinned: row.pinned,
    audible: row.audible,
    sleeping: row.sleeping,
    icon: null,
    noise: cutNoise(titleNoise(row.title, host), row.title, title),
    age,
    dup,
  };
}

// The one snapshot to host projection: display text cut to the protocol limits, icons later as patches (C-ICON-04);
// ages, duplicate groups and noise fixed for the whole list. Only the source tab shows no age (C-HOLD-32).
export function listView(s: Snapshot): ListView {
  const dups = duplicates(s.windows);
  return {
    windows: s.windows.map((w, window) => ({
      current: w.current,
      rows: w.rows.map((row, i) =>
        listRow(row, row.tabId === s.source.tabId ? null : ageOf(s.wall, row.lastAccessed), dups[window]?.[i] ?? null),
      ),
    })),
    closed: s.closed.map((tab) =>
      listRow({ ...tab, pinned: false, audible: false, sleeping: false }, ageOf(s.wall, tab.closedAt), null),
    ),
  };
}

// The row's text for the host's copy keys, open or closed, its title cut as listView cuts it; null past URL_MAX
// (C-SRCH-26).
export function copyText(s: Snapshot, ref: RowRef): CopyText | null {
  const row = rowOf(s, ref)?.row;
  return row && row.url.length <= URL_MAX ? { title: fitText(row.title, TITLE_MAX), url: row.url } : null;
}

// Recently closed rows follow the listed windows, as the closed window (03 4.6).
export const iconKeys = (s: Snapshot): (string | null)[][] => [
  ...s.windows.map((w) => w.rows.map((row) => row.iconKey)),
  s.closed.map((tab) => tab.iconKey),
];
