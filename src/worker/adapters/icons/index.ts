// Favicon cache reads, bounded in memory, sent to hosts as icon patches (03-components 3.2, C-ICON).

import { iconSrc, type IconPatch, type IconSource, type IconSrc } from '../../../core/index.ts';

const LIMIT = 200; // C-ICON-06
const SIZE = 32; // for 16 px display (C-ICON-05)
const NO_ICON_PAGE = 'about:blank'; // _favicon answers a page it has no icon for with this page's globe

// A tab's icon key: its icon address and page, so a changed icon is a new key (C-ICON-07). null: no icon (C-ICON-03).
export const iconKeyOf = (tab: chrome.tabs.Tab): string | null =>
  tab.favIconUrl && tab.url ? `${tab.favIconUrl}\n${tab.url}` : null;

const pageOf = (key: string): string => key.slice(key.indexOf('\n') + 1);

// The browser's own favicon cache through the favicon permission; contacts no site (C-ICON-01).
async function readFavicon(pageUrl: string): Promise<IconSrc | null> {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', String(SIZE));
  const response = await fetch(url);
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = ''; // in chunks: spreading a large icon would pass the argument limit
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return iconSrc(`data:image/png;base64,${btoa(binary)}`); // _favicon sends PNG without a content type
}

// Only valid IconSrc values enter the cache; misses are read again next time. Least recently used leaves first.
export function createIcons(read: (pageUrl: string) => Promise<IconSrc | null> = readFavicon): IconSource {
  const cache = new Map<string, IconSrc>();
  let globe: Promise<IconSrc | null> | null = null;

  const hit = (key: string | null): IconSrc | null => {
    const src = key === null ? undefined : cache.get(key);
    if (key === null || src === undefined) return null;
    // refresh its place
    cache.delete(key);
    cache.set(key, src);
    return src;
  };

  async function load(key: string | null): Promise<IconSrc | null> {
    if (key === null) return null;
    const cached = hit(key);
    if (cached) return cached;
    globe ??= read(NO_ICON_PAGE).catch(() => null);
    const [src, none] = await Promise.all([read(pageOf(key)).catch(() => null), globe]);
    if (src === null || src === none) return null;
    cache.set(key, src);
    if (cache.size > LIMIT) cache.delete(cache.keys().next().value ?? key);
    return src;
  }

  return { cached: (keys) => keys.map(hit), load: (keys) => Promise.all(keys.map(load)) };
}

// Text first, icons after (C-ICON-04): cached icons in one patch at once, the rest in one patch once read.
// A patch never carries null and is sent only when it holds an icon (05-events 4.5).
export function deliverIcons(
  source: IconSource,
  keys: readonly (readonly (string | null)[])[],
  send: (icons: IconPatch[]) => void,
): void {
  const at = keys.flatMap((row, w) => row.map((_, r) => ({ w, r })));
  const flat = keys.flat();
  const patch = (srcs: readonly (string | null)[]): IconPatch[] =>
    at.flatMap(({ w, r }, i) => {
      const src = srcs[i];
      return src ? [{ w, r, src }] : [];
    });
  const first = source.cached(flat);
  const now = patch(first);
  if (now.length) send(now);
  void source
    .load(flat.map((key, i) => (first[i] ? null : key)))
    .then((srcs) => {
      const late = patch(srcs);
      if (late.length) send(late);
    })
    .catch(() => undefined);
}
