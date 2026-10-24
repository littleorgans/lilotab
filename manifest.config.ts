import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };
import { COMMAND_TEXT } from './src/strings.ts';
import { SWITCH_COMMAND } from './src/worker/names.ts';

// package.json is the one home of the product name: displayName for people, name for npm and the release zip.
if (pkg.name !== pkg.displayName.toLowerCase()) {
  throw new Error(`package.json name "${pkg.name}" must be displayName "${pkg.displayName}" in lower case`);
}

export default defineManifest({
  manifest_version: 3,
  name: pkg.displayName,
  version: pkg.version,
  description: pkg.description,
  minimum_chrome_version: '148', // C-PERM-04
  incognito: 'not_allowed', // C-PRIV-06
  // Exactly these, no host permissions, no content scripts: the overlay is injected at the press (C-PERM-01, C-PERM-02).
  permissions: ['storage', 'tabs', 'favicon', 'activeTab', 'scripting'],
  background: {
    service_worker: 'src/worker/index.ts',
    type: 'module',
  },
  action: {
    default_title: pkg.displayName,
  },
  // Opens in a tab from the toolbar menu and the extensions page (C-SET-13); the worker reads this path (05 4.7).
  options_ui: {
    page: 'src/pages/options/index.html',
    open_in_tab: true,
  },
  commands: {
    [SWITCH_COMMAND]: {
      suggested_key: { default: 'Ctrl+Shift+E', mac: 'Command+E' }, // C-KEY-01, C-KEY-02
      description: COMMAND_TEXT,
    },
  },
});
