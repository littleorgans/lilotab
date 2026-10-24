// Settings edit rules for the options page: what the controls show, which write to issue and where a rejected save
// returns (06-data 4.6, C-SET-18). The page holds the edit value, performs write and read, and reports results.
// Not re-exported from settings/index.ts: this file imports it, so the cycle could reach DEFAULTS before it exists.

import {
  DEFAULTS,
  readSettings,
  storeSettings,
  writable,
  type SettingField,
  type Settings,
  type SettingsSource,
  type StoredSettings,
} from './index.ts';

export interface SettingsEdit {
  stored: Settings; // the last stored read; a rejected save returns here (C-SET-18)
  source: SettingsSource | null; // null until the first read: controls stay disabled
  shown: Settings; // what the controls show: stored, with this page's latest edit applied
  latest: number; // id of the latest write this page issued
  status: 'none' | 'saveFailed';
}

export const IDLE_EDIT: SettingsEdit = { stored: DEFAULTS, source: null, shown: DEFAULTS, latest: 0, status: 'none' };

export type EditInput =
  | { kind: 'read'; raw: unknown } // first load, readback, or a storage change
  | { kind: 'edit'; patch: Partial<Settings> } // one control, or DEFAULTS for Restore defaults (C-SET-11)
  | { kind: 'failed'; write: number }; // that write rejected

export type EditEffect = { kind: 'write'; write: number; stored: StoredSettings } | { kind: 'read' };

export interface EditStep {
  edit: SettingsEdit;
  effects: readonly EditEffect[];
}

// No write before the first read, and none over newer data (C-DATA-06, C-DATA-10).
export const canEdit = (e: SettingsEdit): boolean => e.source !== null && writable(e.source);

// Settings that only Flip to last tab reads: Open tab list leaves them inactive, keeping their values (C-SET-19).
export const FLIP_ONLY: readonly SettingField[] = ['quickScope', 'holdDelayMs'];
export const inactive = (s: Settings, f: SettingField): boolean => s.quickTap === 'list' && FLIP_ONLY.includes(f);

// One row per input. Every write is the complete edited object, so a later write supersedes an older one (06 4.6);
// a success is not an input: the storage change that follows carries the stored result.
export function editStep(e: SettingsEdit, input: EditInput): EditStep {
  const same: EditStep = { edit: e, effects: [] };
  switch (input.kind) {
    case 'read': {
      // Every stored read replaces the controls in arrival order: last save wins across pages (06 4.3, 4.6).
      const { settings, source } = readSettings(input.raw);
      return { edit: { ...e, stored: settings, source, shown: settings }, effects: [] };
    }
    case 'edit': {
      if (!canEdit(e)) return same;
      const shown = { ...e.shown, ...input.patch };
      const latest = e.latest + 1;
      return {
        edit: { ...e, shown, latest, status: 'none' },
        effects: [{ kind: 'write', write: latest, stored: storeSettings(shown) }],
      };
    }
    case 'failed':
      // Product decision: a superseded failure shows no message, since the later write carried its value. To always
      // show it, return { ...same, edit: { ...e, status: 'saveFailed' } } here instead.
      if (input.write !== e.latest) return same;
      // The latest write rejected: back to the last stored read, say so, read storage again, never retry (C-SET-18).
      return { edit: { ...e, shown: e.stored, status: 'saveFailed' }, effects: [{ kind: 'read' }] };
  }
}
