// TB-11 protocol.parse (07-tests 2.1; 05-events 4): every boundary message parses to its exact shape within its
// limits, or is rejected.

import { describe, expect, it } from 'vite-plus/test';
import {
  ICON_MAX,
  SITE_MAX,
  TITLE_MAX,
  admit,
  iconSrc,
  listView,
  parseBinding,
  parseHostToWorker,
  parseOptionsReply,
  parsePortName,
  parseWorkerToHost,
  portName,
  type Snapshot,
} from '../src/core/index.ts';
import { CTRL_SHIFT_E, binding, row, startView } from './host-fixtures.ts';

const ATTEMPT = 'boot1:1:1';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const SHAPE = startView().view.windows.map((w) => w.rows.length);

describe('TB-11 protocol.parse', () => {
  it.each([
    { name: 'C-SEC-02: ready with an unknown field', raw: { t: 'ready', from: 'page' } },
    { name: 'C-SEC-02: input with an unknown field', raw: { t: 'input', input: { kind: 'enter', row: 0 } } },
    { name: 'K-04: step with a delta other than 1 or -1', raw: { t: 'input', input: { kind: 'step', delta: 2 } } },
  ])('rejects a host message: $name', ({ raw }) => {
    expect(parseHostToWorker(raw)).toBeNull();
  });

  it('K-05 C-KEY-05: parses a step input with delta -1', () => {
    expect(parseHostToWorker({ t: 'input', input: { kind: 'step', delta: -1 } })).toEqual({
      t: 'input',
      input: { kind: 'step', delta: -1 },
    });
  });

  it('C-SEC-02: input before ready is a violation', () => {
    expect(admit('popup', 'opening', { t: 'input', input: { kind: 'enter' } })).toBe('violation');
  });

  it.each([
    { name: 'this protocol version is accepted', port: portName(ATTEMPT), expected: ATTEMPT },
    { name: 'another protocol version is refused', port: `2|${ATTEMPT}`, expected: null },
  ])('C-SEC-02: port name, $name', ({ port, expected }) => {
    expect(parsePortName(port)).toBe(expected);
  });

  it.each([
    { shortcut: 'Ctrl+Shift+E', expected: CTRL_SHIFT_E },
    { shortcut: '⇧⌘E', expected: binding('meta', 'E', true) },
    { shortcut: 'Alt+Q', expected: binding('alt', 'Q') },
    { shortcut: 'F5', expected: null },
  ])('C-KEY-03 C-KEY-11: shortcut "$shortcut" parses to its held key, or is refused', ({ shortcut, expected }) => {
    expect(parseBinding(shortcut)).toEqual(expected);
  });

  // The options page reads only a parsed ok true as cleared.
  it.each([
    { name: 'ok true parses', raw: { v: 1, t: 'cleared', ok: true }, expected: { v: 1, t: 'cleared', ok: true } },
    { name: 'ok missing is refused', raw: { v: 1, t: 'cleared' }, expected: null },
    { name: "ok 'false' is refused", raw: { v: 1, t: 'cleared', ok: 'false' }, expected: null },
  ])('C-DATA-09: clear reply, $name', ({ raw, expected }) => {
    expect(parseOptionsReply(raw)).toEqual(expected);
  });

  it.each([
    { name: 'a PNG is used', raw: PNG, expected: PNG },
    { name: 'a JPEG is a placeholder', raw: 'data:image/jpeg;base64,/9j/4AAQ', expected: null },
    {
      name: 'a PNG over the icon limit is a placeholder',
      raw: PNG.padEnd(ICON_MAX + 1, 'A'),
      expected: null,
    },
  ])('C-ICON-03: icon, $name', ({ raw, expected }) => {
    expect(iconSrc(raw)).toBe(expected);
  });

  it('C-HOLD-01 C-HOLD-17: a real tab with an oversized title and host still passes the host parser', () => {
    const snapRow = {
      tabId: 1,
      title: 't'.repeat(TITLE_MAX + 1),
      url: `https://${'h'.repeat(SITE_MAX)}.example.com/`,
      pinned: false,
      audible: true,
      useRank: 0,
      barIndex: 0,
      iconKey: 'k',
    };
    const snapshot: Snapshot = {
      source: { tabId: 1, windowId: 1 },
      windows: [{ windowId: 1, current: 0, rows: [snapRow] }],
      quick: null,
      initial: { window: 0, row: 0 },
      stack: null,
    };
    const start = startView({ view: listView(snapshot) });
    expect(parseWorkerToHost({ t: 'start', start }, null)).toEqual({ t: 'start', start });
  });

  // Planned rows (build spec 5 item 8): C-HOLD-25 audible, C-SET-19 quickTap, C-TAP-10 open.
  it.each([
    { name: "C-SET-19: quickTap 'list'", start: startView({ quickTap: 'list' }) },
    {
      name: 'C-HOLD-25: an audible row',
      start: startView({ view: { windows: [{ current: 0, rows: [row('A', { audible: true })] }] } }),
    },
    {
      name: 'C-TAP-10: an open hold frame',
      start: startView({ frame: { mode: 'hold', visible: true, open: true, window: 0, row: 0 } }),
    },
  ])('a start view with $name parses', ({ start }) => {
    expect(parseWorkerToHost({ t: 'start', start }, null)).toEqual({ t: 'start', start });
  });

  const { audible: _audible, ...rowWithoutAudible } = row('A');
  const { quickTap: _quickTap, ...startWithoutQuickTap } = startView();
  const holdFrameWithoutOpen = { mode: 'hold', visible: true, window: 0, row: 0 };
  const searchFrame = { mode: 'search', query: '', results: [], highlight: 0 };

  it.each([
    {
      name: 'C-HOLD-25: a row without audible',
      start: { ...startView(), view: { windows: [{ current: 0, rows: [rowWithoutAudible] }] } },
    },
    {
      name: 'C-HOLD-25: audible of the wrong type',
      start: { ...startView(), view: { windows: [{ current: 0, rows: [{ ...row('A'), audible: 'yes' }] }] } },
    },
    { name: 'C-SET-19: no quickTap', start: startWithoutQuickTap },
    { name: "C-SET-19: unknown quickTap 'tap'", start: { ...startView(), quickTap: 'tap' } },
    { name: 'C-TAP-10: a hold frame without open', start: { ...startView(), frame: holdFrameWithoutOpen } },
    {
      name: 'C-TAP-10: open of the wrong type',
      start: { ...startView(), frame: { ...holdFrameWithoutOpen, open: 1 } },
    },
    { name: 'C-TAP-10: open on the start envelope', start: { ...startView(), open: false } },
  ])('rejects a start view: $name', ({ start }) => {
    expect(parseWorkerToHost({ t: 'start', start }, null)).toBeNull();
  });

  it.each([
    { name: 'C-TAP-10: a hold frame without open', frame: holdFrameWithoutOpen },
    {
      name: 'C-HOLD-06: a hold cursor past the last row (05-events 4.5)',
      frame: { ...holdFrameWithoutOpen, open: false, row: SHAPE[0] },
    },
    { name: 'C-TAP-10: open on a search frame', frame: { ...searchFrame, open: false } },
    {
      name: 'C-SET-19: quickTap on a frame',
      frame: { ...holdFrameWithoutOpen, open: false, quickTap: 'flip' },
    },
  ])('rejects a frame: $name', ({ frame }) => {
    expect(parseWorkerToHost({ t: 'frame', frame }, SHAPE)).toBeNull();
  });
});
