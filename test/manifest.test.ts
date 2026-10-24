import { expect, test } from 'vite-plus/test';
import manifest from '../manifest.config.ts';
import pkg from '../package.json' with { type: 'json' };
import { SWITCH_COMMAND } from '../src/worker/names.ts';

const resolved =
  typeof manifest === 'function' ? await manifest({ command: 'build', mode: 'production' }) : await manifest;

// AC-30 package.manifest: the release manifest as the build reads it. The popup title is checked live in Chrome
// (AC-30-popup-title in test/chrome/package.mjs).
test.each<[string, (m: typeof resolved) => unknown, unknown]>([
  [
    'C-PERM-01: exactly the five permissions',
    (m) => m.permissions,
    ['storage', 'tabs', 'favicon', 'activeTab', 'scripting'],
  ],
  ['C-PERM-01: no host permissions', (m) => [m.host_permissions, m.optional_host_permissions], [undefined, undefined]],
  ['C-PERM-02: no content scripts', (m) => m.content_scripts, undefined],
  ['C-PRIV-06: private windows not allowed', (m) => m.incognito, 'not_allowed'],
  ['C-PERM-04: minimum Chrome 148', (m) => m.minimum_chrome_version, '148'],
  [
    'C-KEY-01, C-KEY-02: the switch command is Cmd+E on macOS and Ctrl+Shift+E elsewhere',
    (m) => m.commands?.[SWITCH_COMMAND]?.suggested_key,
    { default: 'Ctrl+Shift+E', mac: 'Command+E' },
  ],
  [
    'KB-12: the toolbar title is the product name',
    // The test project has no chrome types, so the action is compared as JSON.
    (m) => [m.name, JSON.stringify(m.action)],
    [pkg.displayName, JSON.stringify({ default_title: pkg.displayName })],
  ],
])('%s', (_, field, expected) => {
  expect(field(resolved)).toEqual(expected);
});
