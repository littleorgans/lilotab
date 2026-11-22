// Shared builders for the host side core tables (07-tests TB-10 to TB-12): key facts, bindings and a start view.

import {
  DEFAULTS,
  lookOf,
  type Binding,
  type Frame,
  type KeyFacts,
  type ListRow,
  type StartView,
} from '../src/core/index.ts';
import { codeOf } from './key-input.ts';

type Held = Binding['held'];

// A binding whose held key is `held`, with Shift when `shift` is set.
export const binding = (held: Held, key: string, shift = false): Binding => ({
  held,
  mods: { meta: held === 'meta', ctrl: held === 'ctrl', alt: held === 'alt', shift },
  key,
});

export const CMD_E = binding('meta', 'E'); // macOS default
export const CTRL_SHIFT_E = binding('ctrl', 'E', true);

// A trusted keydown with no modifiers; `key` alone also sets a matching `code` for letters and named keys.
export function keyFacts(key: string, over: Partial<KeyFacts> = {}): KeyFacts {
  return {
    type: 'keydown',
    key,
    code: codeOf(key),
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
    trusted: true,
    composing: false,
    repeat: false,
    ...over,
  };
}

export const pointer = (type: 'pointermove' | 'pointerdown', over: Partial<KeyFacts> = {}): KeyFacts =>
  keyFacts('', { type, code: '', ...over });

export const row = (title: string, over: Partial<ListRow> = {}): ListRow => ({
  title,
  site: 'example.com',
  pinned: false,
  audible: false,
  sleeping: false,
  icon: null,
  noise: { lead: 0, tail: null },
  age: null,
  dup: null,
  ...over,
});

type HoldFrame = Extract<Frame, { mode: 'hold' }>;
type SearchFrame = Extract<Frame, { mode: 'search' }>;

// A visible hold frame on the source row, in the default order.
export const holdFrame = (over: Partial<HoldFrame> = {}): HoldFrame => ({
  mode: 'hold',
  visible: true,
  open: false,
  window: 0,
  row: 0,
  gone: [],
  copy: null,
  sort: 'recent',
  order: null,
  ...over,
});

// A search frame with an empty query and no results, in the default order.
export const searchFrame = (over: Partial<SearchFrame> = {}): SearchFrame => ({
  mode: 'search',
  query: '',
  results: [],
  highlight: 0,
  copy: null,
  sort: 'recent',
  gone: [],
  ...over,
});

// One window of three rows, the source tab at row 0, the cursor on the source, Cmd+E bound.
export const startView = (over: Partial<StartView> = {}): StartView => ({
  mode: 'hold',
  binding: CMD_E,
  quickTap: 'flip',
  onRelease: 'switch',
  look: lookOf(DEFAULTS),
  view: { windows: [{ current: 0, rows: [row('Source'), row('Second'), row('Third')] }], closed: [] },
  frame: holdFrame(),
  ...over,
});
