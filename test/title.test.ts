// TB-13 title.rules (07-tests 2.1): title noise, the search runs with their marks and site name drop, and the letter
// tile. Noise rows come from the build loop's chk-suffix table, numbered as there.

import { describe, expect, it } from 'vite-plus/test';
import { letterOf, titleNoise, titleRuns, type Run } from '../src/core/index.ts';

// Runs as text: ~noise~ and *mark*.
const show = (runs: readonly Run[]) =>
  runs.map((r) => (r.kind === 'mark' ? `*${r.text}*` : r.kind === 'noise' ? `~${r.text}~` : r.text)).join('');

describe('TB-13 title.rules', () => {
  it.each<{ n: number; title: string; host: string; lead: number; tail: number | null }>([
    { n: 1, title: 'microsoft/vscode: Visual Studio Code · GitHub', host: 'github.com', lead: 0, tail: 36 },
    { n: 5, title: 'GitHub', host: 'github.com', lead: 0, tail: null },
    {
      n: 6,
      title: '(828) 8 free github repos that make money - YouTube',
      host: 'www.youtube.com',
      lead: 6,
      tail: 41,
    },
    { n: 8, title: '(826) YouTube', host: 'www.youtube.com', lead: 6, tail: null },
    { n: 11, title: '(12) Home / X', host: 'x.com', lead: 5, tail: 9 },
    { n: 13, title: 'Inbox (3) - name@x - Gmail', host: 'mail.google.com', lead: 0, tail: 18 },
    { n: 16, title: 'github lfm3 - Google Search', host: 'www.google.com', lead: 0, tail: 11 },
    { n: 17, title: 'Inbox - Gmail', host: 'accounts.google.com', lead: 0, tail: null },
    { n: 21, title: 'PROJ-42 - Fix login - Jira', host: 'acme.atlassian.net', lead: 0, tail: null },
    { n: 27, title: 'About pull requests - GitHub Docs', host: 'docs.github.com', lead: 0, tail: null },
    { n: 40, title: 'Latest news - BBC', host: 'www.bbc.co.uk', lead: 0, tail: 11 },
    { n: 41, title: 'Guide - GitHub', host: 'acme.github.io', lead: 0, tail: null },
    { n: 43, title: 'Guide - GitHub', host: 'github.com.evil.com', lead: 0, tail: null },
    { n: 44, title: 'Guide - GitHub | Preview', host: 'github.com', lead: 0, tail: null },
    { n: 46, title: '(3) - YouTube', host: 'www.youtube.com', lead: 4, tail: null },
    { n: 50, title: 'Roadmap | GitHub - GitHub', host: 'github.com', lead: 0, tail: 16 },
  ])('C-HOLD-34 noise $n: "$title" on $host', ({ title, host, lead, tail }) => {
    expect(titleNoise(title, host)).toEqual({ lead, tail });
  });

  it.each<{ name: string; query: string; title: string; site: string; shown: string; domain: string }>([
    {
      name: 'the domain explains the match, so the site name drops',
      query: 'youtube',
      title: 'Mix - Live - YouTube',
      site: 'www.youtube.com',
      shown: 'Mix - Live',
      domain: 'www.*youtube*.com',
    },
    {
      name: 'a match inside the domain explains it too',
      query: 'cart',
      title: 'Playground | Cartesia',
      site: 'play.cartesia.ai',
      shown: 'Playground',
      domain: 'play.*cart*esia.ai',
    },
    {
      name: 'a word only the site name holds keeps it, dimmed and marked',
      query: 'search',
      title: 'github lfm3 - Google Search',
      site: 'www.google.com',
      shown: 'github lfm3~ - Google ~*Search*',
      domain: 'www.google.com',
    },
    {
      name: 'one unexplained word keeps the whole site name, though another matches the domain',
      query: 'google search',
      title: 'github lfm3 - Google Search',
      site: 'www.google.com',
      shown: 'github lfm3~ - ~*Google*~ ~*Search*',
      domain: 'www.*google*.com',
    },
    {
      name: 'an alias the domain lacks keeps the site name',
      query: 'gmail',
      title: 'Inbox (3) - name@x - Gmail',
      site: 'mail.google.com',
      shown: 'Inbox (3) - name@x~ - ~*Gmail*',
      domain: 'mail.google.com',
    },
    {
      name: 'a host label explains an alias word',
      query: 'docs',
      title: 'Roadmap - Google Docs',
      site: 'docs.google.com',
      shown: 'Roadmap',
      domain: '*docs*.google.com',
    },
    {
      name: 'a word the kept title holds marks there and the site name drops',
      query: 'search',
      title: 'Search tips - Google Search',
      site: 'www.google.com',
      shown: '*Search* tips',
      domain: 'www.google.com',
    },
    {
      name: 'the count stays dimmed and a mark in it shows in full ink',
      query: '828',
      title: '(828) YouTube',
      site: 'www.youtube.com',
      shown: '~(~*828*~) ~YouTube',
      domain: 'www.youtube.com',
    },
    {
      name: 'marks map back across a surrogate pair, a dropped variation selector and a ligature',
      query: 'file',
      title: '🛠️ ﬁle notes',
      site: 'example.com',
      shown: '🛠️ *ﬁle* notes',
      domain: 'example.com',
    },
    {
      name: 'a decomposed accent stays inside the mark: café marks for cafe',
      query: 'cafe',
      title: 'Café menu',
      site: 'example.com',
      shown: '*Café* menu',
      domain: 'example.com',
    },
  ])('C-SRCH-30 C-SRCH-31 search: $name', ({ query, title, site, shown, domain }) => {
    const runs = titleRuns({ title, site, noise: titleNoise(title, site) }, query, 'search');
    expect({ shown: show(runs.title), domain: show(runs.site) }).toEqual({ shown, domain });
  });

  it.each([
    { name: 'the host after www.', site: 'www.github.com', title: 'Pull requests', letter: 'G' },
    { name: 'the title without a host', site: '', title: 'roadmap notes', letter: 'R' },
    { name: 'the title after its leading noise without a host', site: '', title: '(3) Inbox', letter: 'I' },
    { name: 'none without either', site: '', title: '', letter: '' },
  ])('C-ICON-03 letter tile: $name', ({ site, title, letter }) => {
    expect(letterOf({ site, title, noise: titleNoise(title, site) })).toBe(letter);
  });
});
