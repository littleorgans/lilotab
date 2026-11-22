// Worker to host and options parsers: exact shapes, values inside their enums and limits, or a rejection (05-events 4).

import { hasExactly, isCount, isIndex, isOneOf, isRecord, isRowRef, isText, type Fields } from '../guards.ts';
import { SCHEMA } from '../settings/index.ts';
import type { RowRef } from '../types.ts';
import { heldOf } from './binding.ts';
import { MODIFIERS } from './keys.ts';
import {
  AGE_MAX,
  AGE_UNITS,
  PROTOCOL,
  QUERY_MAX,
  SITE_MAX,
  TITLE_MAX,
  URL_MAX,
  iconSrc,
  type Binding,
  type Frame,
  type IconPatch,
  type ListView,
  type OptionsReply,
  type OptionsRequest,
  type StartView,
  type WorkerToHost,
} from './messages.ts';

export { admit, parseHostToWorker, parsePortName } from './channel-receiver.ts';
export { portName } from './messages.ts';

// ---- worker to host (05 4.5)

function isBinding(raw: unknown): raw is Binding {
  if (!hasExactly(raw, ['held', 'mods', 'key'])) return false;
  const mods = raw['mods'];
  if (!hasExactly(mods, MODIFIERS) || !MODIFIERS.every((m) => typeof mods[m] === 'boolean')) return false;
  const held = heldOf(mods as Binding['mods']);
  return (
    held !== null &&
    raw['held'] === held &&
    typeof raw['key'] === 'string' &&
    raw['key'].length > 0 &&
    raw['key'].length <= 32
  );
}

const isLook = (raw: unknown): boolean =>
  hasExactly(raw, ['theme', 'reduceMotion', 'textSize']) &&
  isOneOf(raw['theme'], SCHEMA.theme.values) &&
  isOneOf(raw['reduceMotion'], SCHEMA.reduceMotion.values) &&
  isOneOf(raw['textSize'], SCHEMA.textSize.values);

// The count [0, lead) leaves part of the title; the site name [tail, length) follows it (C-HOLD-34).
function isNoise(raw: unknown, length: number): boolean {
  if (!hasExactly(raw, ['lead', 'tail'])) return false;
  const { lead, tail } = raw;
  if (lead !== 0 && !isIndex(lead, length)) return false;
  return tail === null || (isIndex(tail, length + 1) && tail >= lead);
}

const isAge = (raw: unknown): boolean =>
  raw === null ||
  (hasExactly(raw, ['n', 'unit']) &&
    isOneOf(raw['unit'], AGE_UNITS) &&
    isCount(raw['n'], 1) &&
    raw['n'] <= AGE_MAX[raw['unit']]);

const isRow = (raw: unknown): boolean =>
  hasExactly(raw, ['title', 'site', 'pinned', 'audible', 'sleeping', 'icon', 'noise', 'age', 'dup']) &&
  isText(raw['title'], TITLE_MAX) &&
  isText(raw['site'], SITE_MAX) &&
  typeof raw['pinned'] === 'boolean' &&
  typeof raw['audible'] === 'boolean' &&
  typeof raw['sleeping'] === 'boolean' &&
  (raw['icon'] === null || (typeof raw['icon'] === 'string' && iconSrc(raw['icon']) !== null)) &&
  isNoise(raw['noise'], raw['title'].length) &&
  isAge(raw['age']) &&
  (raw['dup'] === null || isIndex(raw['dup'], Infinity));

const isWindowView = (raw: unknown): raw is Fields & { rows: unknown[]; current: number } =>
  hasExactly(raw, ['current', 'rows']) &&
  Array.isArray(raw['rows']) &&
  raw['rows'].length > 0 &&
  isIndex(raw['current'], raw['rows'].length) &&
  raw['rows'].every(isRow);

const isListView = (raw: unknown): raw is ListView =>
  hasExactly(raw, ['windows', 'closed']) &&
  Array.isArray(raw['windows']) &&
  raw['windows'].length > 0 &&
  raw['windows'].every(isWindowView) &&
  Array.isArray(raw['closed']) &&
  raw['closed'].every(isRow);

// Rows per start view window, then the closed window's rows: the last entry (05 4.5, 4.9).
export const shapeOf = (view: ListView): readonly number[] => [
  ...view.windows.map((w) => w.rows.length),
  view.closed.length,
];

const inShape = (ref: RowRef, shape: readonly number[]) => isIndex(ref.row, shape[ref.window] ?? 0);

const isRefs = (raw: unknown, shape: readonly number[]): raw is RowRef[] =>
  Array.isArray(raw) && raw.every((r) => isRowRef(r) && inShape(r, shape));

const SORTS = [...SCHEMA.tabOrder.values, 'best', 'title'] as const;

// Every row of the shown window once (C-HOLD-29).
const isOrder = (raw: unknown, rows: number): boolean =>
  raw === null ||
  (Array.isArray(raw) && raw.length === rows && raw.every((r) => isIndex(r, rows)) && new Set(raw).size === rows);

const isCopy = (raw: unknown): boolean =>
  raw === null || (hasExactly(raw, ['title', 'url']) && isText(raw['title'], TITLE_MAX) && isText(raw['url'], URL_MAX));

// Checked against its own mode (05 4.5); which mode a host admits is host-session.ts. Only search results may name
// the closed window.
function isFrame(raw: unknown, shape: readonly number[]): raw is Frame {
  if (!isRecord(raw)) return false;
  if (!isCopy(raw['copy']) || !isOneOf(raw['sort'], SORTS)) return false;
  const open = shape.slice(0, -1);
  if (raw['mode'] === 'hold') {
    return (
      hasExactly(raw, ['mode', 'visible', 'open', 'window', 'row', 'gone', 'copy', 'sort', 'order']) &&
      typeof raw['visible'] === 'boolean' &&
      typeof raw['open'] === 'boolean' &&
      isIndex(raw['window'], open.length) &&
      isIndex(raw['row'], open[raw['window']] ?? 0) &&
      isRefs(raw['gone'], open) &&
      isOrder(raw['order'], open[raw['window']] ?? 0)
    );
  }
  const results = raw['results'];
  return (
    raw['mode'] === 'search' &&
    hasExactly(raw, ['mode', 'query', 'results', 'highlight', 'copy', 'sort', 'gone']) &&
    isText(raw['query'], QUERY_MAX) &&
    isRefs(results, shape) &&
    (results.length === 0 ? raw['highlight'] === 0 : isIndex(raw['highlight'], results.length)) &&
    isRefs(raw['gone'], open)
  );
}

function isStart(raw: unknown): raw is StartView {
  if (!hasExactly(raw, ['mode', 'binding', 'quickTap', 'onRelease', 'look', 'view', 'frame'])) return false;
  const mode = raw['mode'];
  if (!isOneOf(mode, ['hold', 'search'] as const) || !isOneOf(raw['quickTap'], SCHEMA.quickTap.values)) return false;
  if (!isOneOf(raw['onRelease'], SCHEMA.onRelease.values)) return false;
  if (!isLook(raw['look']) || !isListView(raw['view'])) return false;
  const binding = raw['binding'];
  if (binding === null ? mode !== 'search' : !isBinding(binding)) return false;
  const frame = raw['frame'];
  return isFrame(frame, shapeOf(raw['view'])) && frame.mode === mode;
}

// null without a dwell, else at most the longest hold delay (05 4.5).
const WAKE_MAX = Math.max(...SCHEMA.holdDelayMs.values);
const isWake = (raw: unknown): raw is number | null =>
  raw === null || (typeof raw === 'number' && raw >= 0 && raw <= WAKE_MAX);

const isIconPatch = (raw: unknown, shape: readonly number[]): raw is IconPatch =>
  hasExactly(raw, ['w', 'r', 'src']) &&
  isIndex(raw['w'], shape.length) &&
  isIndex(raw['r'], shape[raw['w']] ?? 0) &&
  typeof raw['src'] === 'string' &&
  iconSrc(raw['src']) !== null;

// shape is null before start: only a start parses. After it, every frame and icon must fit the start view's
// shape (05 4.5); host-session.ts decides which frames the host admits.
export function parseWorkerToHost(raw: unknown, shape: readonly number[] | null): WorkerToHost | null {
  if (!isRecord(raw)) return null;
  if (shape === null) {
    return hasExactly(raw, ['t', 'start', 'wake']) &&
      raw['t'] === 'start' &&
      isStart(raw['start']) &&
      isWake(raw['wake'])
      ? { t: 'start', start: raw['start'], wake: raw['wake'] }
      : null;
  }
  if (hasExactly(raw, ['t', 'frame']) && raw['t'] === 'frame') {
    const frame = raw['frame'];
    return isFrame(frame, shape) ? { t: 'frame', frame } : null;
  }
  if (hasExactly(raw, ['t', 'icons']) && raw['t'] === 'icons') {
    const icons = raw['icons'];
    return Array.isArray(icons) && icons.every((i) => isIconPatch(i, shape)) ? { t: 'icons', icons } : null;
  }
  return null;
}

// ---- options page (05 4.7)

export const parseOptionsRequest = (raw: unknown): OptionsRequest | null =>
  hasExactly(raw, ['v', 't']) && raw['v'] === PROTOCOL && raw['t'] === 'clear' ? { v: PROTOCOL, t: 'clear' } : null;

// Only ok true reads as cleared; anything malformed reads as not cleared at the caller (C-DATA-09).
export const parseOptionsReply = (raw: unknown): OptionsReply | null =>
  hasExactly(raw, ['v', 't', 'ok']) && raw['v'] === PROTOCOL && raw['t'] === 'cleared' && typeof raw['ok'] === 'boolean'
    ? { v: PROTOCOL, t: 'cleared', ok: raw['ok'] }
    : null;
