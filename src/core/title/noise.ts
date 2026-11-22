// Title noise (C-HOLD-34): a leading notification count and a trailing segment that names the tab's site, found in the
// full title and host. Run in the worker; the suffix rule stays out of host bundles (C-PERF-02).

import type { Noise } from '../protocol/index.ts';
import { normalize } from '../ranking/text.ts';

const COUNT = /^\([0-9]+\) /;
const NONBLANK = /\S/u;

// The end of a leading count such as "(828) ", when a nonblank title follows it; else 0.
function countEnd(title: string): number {
  const m = COUNT.exec(title);
  return m && NONBLANK.test(title.slice(m[0].length)) ? m[0].length : 0;
}

// A compact rule in place of the Public Suffix List, which would not fit the release ZIP (C-PERF-02): the suffix is the
// last label, or the last two for a country code under a common second level or a listed private suffix. A host under
// another multi part suffix can name a wrong label, which at worst dims a trailing segment equal to it.
const RESERVED = new Set(['localhost', 'local', 'internal', 'test', 'example', 'invalid', 'arpa']);
const UNDER_COUNTRY = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'ne', 'or']);
const PRIVATE = new Set([
  'github.io',
  'gitlab.io',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'web.app',
  'workers.dev',
  'firebaseapp.com',
  'appspot.com',
  'herokuapp.com',
  'blogspot.com',
]);

// The label before the host's suffix: "bbc" for www.bbc.co.uk, "acme" for acme.github.io. null for an IP, a single
// label, an internationalized name or a reserved name.
function registrable(labels: readonly string[]): string | null {
  const top = labels.at(-1) ?? '';
  if (labels.length < 2 || /^\d+$/.test(top) || RESERVED.has(top)) return null;
  if (labels.some((l) => l === '' || l.startsWith('xn--') || l.startsWith('['))) return null;
  const pair = labels.slice(-2).join('.');
  const country = top.length === 2 && UNDER_COUNTRY.has(labels.at(-2) ?? '');
  return labels.at(PRIVATE.has(pair) || country ? -3 : -2) ?? null;
}

// Names a host goes by in titles beyond its label, each tied to exact hosts.
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  'google.com': ['Google Search'],
  'www.google.com': ['Google Search'],
  'mail.google.com': ['Gmail'],
  'docs.google.com': ['Google Docs'],
};

const SEPARATORS = [' - ', ' | ', ' / ', ' · ', ' — ', ' – ', ' :: '];

// Whole names compare ignoring case, accents and spaces: "Git Hub" names github.
const nameOf = (s: string): string => normalize(s).replace(/\s+/gu, '');

// Where the trailing site name starts: the rightmost separator, when the rest names the site and a nonblank title
// body from `from` remains before it; else null.
function siteStart(title: string, host: string, from: number): number | null {
  let at = -1;
  let after = 0;
  for (const sep of SEPARATORS) {
    const i = title.lastIndexOf(sep);
    if (i > at) [at, after] = [i, i + sep.length];
  }
  if (at < 0 || !NONBLANK.test(title.slice(from, at))) return null;
  const name = host.toLowerCase().replace(/\.$/, '');
  const names = [registrable(name.split('.')), ...(ALIASES[name] ?? [])].filter((n) => n !== null).map(nameOf);
  return names.includes(nameOf(title.slice(after))) ? at : null;
}

// The noise of a full title for its full host; never the whole nonblank title.
export function titleNoise(title: string, host: string): Noise {
  const lead = countEnd(title);
  return { lead, tail: siteStart(title, host, lead) };
}
