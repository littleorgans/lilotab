// The icon slot's rule, run in hosts (C-ICON-03): the letter tile's letter.

import type { ListRow } from './protocol/index.ts';

const ALNUM = /[\p{L}\p{N}]/u;

// The first letter or digit of the host after "www.", else of the title after its leading noise (C-HOLD-34), upper
// cased; '' for neither. Reuse the row's noise so its worker rules stay out of host bundles (C-PERF-02).
export function letterOf({ site, title, noise }: Pick<ListRow, 'site' | 'title' | 'noise'>): string {
  const m = ALNUM.exec(site.replace(/^www\./, '')) ?? ALNUM.exec(title.slice(noise.lead));
  return m ? (Array.from(m[0].toUpperCase())[0] ?? '') : '';
}
