// The shortcut parser: commands.getAll's shortcut string, in both forms, into a Binding (05-events 2.4, 4.9).

import { keyToken } from './keys.ts';
import type { Binding } from './messages.ts';

type Mods = Binding['mods'];

const NAMED: Readonly<Record<string, keyof Mods>> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  macctrl: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  command: 'meta',
  cmd: 'meta',
  search: 'meta',
};

const SYMBOLS: Readonly<Record<string, keyof Mods>> = { '⌃': 'ctrl', '⌥': 'alt', '⇧': 'shift', '⌘': 'meta' };

// Primary modifier: Cmd, else Ctrl (MacCtrl on macOS), else Alt (C-KEY-03).
export const heldOf = (m: Mods): Binding['held'] | null => (m.meta ? 'meta' : m.ctrl ? 'ctrl' : m.alt ? 'alt' : null);

// "Ctrl+Shift+E" or the macOS symbol form "⇧⌘E"; null when empty or without Cmd, Ctrl or Alt (C-KEY-11).
export function parseBinding(shortcut: string): Binding | null {
  const s = shortcut.trim();
  if (!s) return null;
  const mods: Mods = { meta: false, ctrl: false, alt: false, shift: false };
  let key: string;
  if (s.length > 1 && s.includes('+')) {
    const parts = s.split('+').map((p) => p.trim());
    key = parts.pop() ?? '';
    for (const part of parts) {
      const mod = NAMED[part.toLowerCase()];
      if (!mod) return null;
      mods[mod] = true;
    }
  } else {
    let i = 0;
    for (let mod = SYMBOLS[s.charAt(i)]; mod; mod = SYMBOLS[s.charAt(++i)]) mods[mod] = true;
    key = s.slice(i);
  }
  const held = heldOf(mods);
  return key && held ? { held, mods, key: keyToken(key) } : null;
}
