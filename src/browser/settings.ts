// Settings transport: the storage.local area and settings key, shared by the worker and the options page (06-data 3).
// Callers validate through the core readSettings and storeSettings.

import { SETTINGS_KEY, type StoredSettings } from '../core/index.ts';

export const loadSettings = async (): Promise<unknown> => (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];

export const saveSettings = (settings: StoredSettings): Promise<void> =>
  chrome.storage.local.set({ [SETTINGS_KEY]: settings });

// Area local, key settings only; a removed key passes undefined, which reads as absent (06 3).
export function onSettingsChanged(listener: (raw: unknown) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    const change = changes[SETTINGS_KEY];
    if (area === 'local' && change) listener(change.newValue);
  });
}
