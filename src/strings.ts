// English user facing strings: the product's one catalogue, so locales can follow (01-overview). Pure data, read by
// the manifest, the hosts and the pages. One export per surface: bundles drop unused exports, never unused properties,
// so the overlay carries no settings text (C-PERF-02).

import { displayName as NAME } from '../package.json';
import type { SettingField, Settings } from './core/index.ts';

// Label, value names and optional unit per stored setting, typed against the core SCHEMA so a missing name fails the
// build (C-SET).
export const SETTING_TEXT: {
  readonly [K in SettingField]: { label: string; values: Readonly<Record<`${Settings[K]}`, string>>; unit?: string };
} = {
  quickTap: { label: 'Quick tap', values: { flip: 'Flip to last tab', list: 'Open tab list' } },
  quickScope: { label: 'Quick tap switches within', values: { window: 'This window', all: 'All windows' } },
  holdDelayMs: { label: 'Hold delay', values: { 0: '0', 50: '50', 100: '100', 200: '200' }, unit: 'ms' },
  tabOrder: { label: 'Tab order', values: { recent: 'Recent', window: 'Window order' } },
  listSurface: { label: 'List surface', values: { overlay: 'Overlay', popup: 'Popup' } },
  theme: { label: 'Theme', values: { dark: 'Dark', light: 'Light', system: 'Match system' } },
  textSize: { label: 'Text size', values: { default: 'Default', large: 'Large' } },
  reduceMotion: { label: 'Reduce motion', values: { system: 'Match system', always: 'Always', never: 'Never' } },
};

// Held key names, as the contract writes them (C-KEY-03).
export const KEY_NAMES = { meta: 'Cmd', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' } as const;

export const PRODUCT = NAME; // package.json is the one home of the product name

// The switch command's description on the shortcuts page.
export const COMMAND_TEXT = 'Switch to the last used tab; hold for the tab list';

// The list view, in both hosts.
export const LIST_TEXT = {
  untitled: 'Untitled', // C-HOLD-17
  noResults: 'No matching tabs', // C-SRCH-16
  search: 'Search tabs', // C-SRCH-02, the field's name and placeholder
  tabs: 'Tabs', // the listbox name (C-A11Y-01)
  windows: 'Windows', // the strip's tab list name (C-A11Y-01)
  thisWindow: 'This window', // the source window (C-SRCH-07)
  window: (n: number) => `Window ${String(n)}`,
  pinned: 'Pinned', // C-A11Y-02
  audible: 'Playing sound', // C-HOLD-25, named right after the title (C-A11Y-02)
  rowName: (parts: readonly string[]) => parts.join(', '), // title, sound, pinned state, window (C-A11Y-02)
} as const;

// The shortcut row, on the settings page and the welcome tab.
export const SHORTCUT_TEXT = {
  label: 'Shortcut',
  none: 'No shortcut set', // C-KEY-09
  noModifier: 'This shortcut needs Cmd, Ctrl or Alt', // C-KEY-11
  change: 'Change shortcut', // C-SET-01, C-SET-17
  where: 'set on chrome://extensions/shortcuts',
} as const;

export const OPTIONS_TEXT = {
  title: `${NAME} settings`,
  sections: { switching: 'Switching', appearance: 'Appearance', history: 'History' }, // the labels above the cards
  newer: `These settings were saved by a newer version of ${NAME}. Update ${NAME} to change them.`, // C-DATA-10
  saveFailed: 'Could not save the setting. Try again.', // C-SET-18
  history: 'Recent tab history', // C-SET-10
  historyKept: `Kept until the browser closes or ${NAME} updates.`, // C-SET-10 (06 5.3)
  clear: 'Clear now',
  clearing: 'Clearing', // 06 5.3
  cleared: 'Recent tab history cleared.', // C-DATA-09
  notCleared: 'Recent tab history was not cleared. Try again.', // C-DATA-09
  defaults: 'Defaults', // the Restore defaults row label
  restore: 'Restore defaults', // C-SET-11
  restoreScope: 'Restore switching and appearance settings.',
  flipOnly: 'The two settings below apply to Flip to last tab only.', // shown when Quick tap is Open tab list
} as const;

export const WELCOME_TEXT = {
  title: `Welcome to ${NAME}`,
  tap: (shortcut: string) => `Press ${shortcut} to switch to your last used tab.`,
  hold: (held: string, shortcut: string) =>
    `Keep holding ${held} to see your tabs. Press ${shortcut} again or use the arrow keys to move, then release to switch.`,
  toolbar: `Click the ${NAME} toolbar icon to search all your tabs.`, // C-POP-09
  settings: 'Settings',
} as const;
