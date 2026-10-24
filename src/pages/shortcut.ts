// The shortcut row both pages show: the bound shortcut or "No shortcut set" on one line with where to set it, plus
// "needs Cmd, Ctrl or Alt" when it lacks one, and "Change shortcut" (C-SET-01, C-KEY-09, C-KEY-10, C-KEY-11). Read
// again whenever the page becomes visible (05 3.3).

import { readShortcut } from '../browser/commands.ts';
import { MODIFIERS, keyText, parseBinding, type Binding } from '../core/index.ts';
import { KEY_NAMES, SHORTCUT_TEXT } from '../strings.ts';
import { el, row } from './dom.ts';

const SHORTCUTS_PAGE = 'chrome://extensions/shortcuts'; // C-SET-17: a page cannot link it, tabs.create can open it

export type Shortcut =
  | { kind: 'bound'; text: string; held: string }
  | { kind: 'none' }
  | { kind: 'noModifier'; text: string }; // the browser's own string, which parseBinding refuses

// Contract form, primary modifier first: "Cmd+E", "Ctrl+Shift+E", "Alt+Q" (C-KEY-01 to C-KEY-03).
function bindingText(b: Binding): string {
  const mods = MODIFIERS.filter((m) => b.mods[m]).map((m) => KEY_NAMES[m]);
  return [...mods, keyText(b.key)].join('+');
}

async function readState(): Promise<Shortcut> {
  const shortcut = (await readShortcut()).trim();
  if (!shortcut) return { kind: 'none' };
  const binding = parseBinding(shortcut);
  if (!binding) return { kind: 'noModifier', text: shortcut };
  return { kind: 'bound', text: bindingText(binding), held: KEY_NAMES[binding.held] };
}

// Mounts the block and keeps it current; onRead lets a page add copy for the state it shows.
export function shortcutBlock(onRead: (s: Shortcut) => void = () => undefined): HTMLElement {
  const value = el('span');
  const problem = el('p', { class: 'problem' });
  const change = el('button', { type: 'button' }, [SHORTCUT_TEXT.change]);
  change.addEventListener('click', () => {
    void chrome.tabs.create({ url: SHORTCUTS_PAGE });
  });

  async function refresh(): Promise<void> {
    // A failed read happens only while the browser shuts down; the block keeps what it showed.
    const s = await readState().catch(() => null);
    if (!s) return;
    value.replaceChildren(s.kind === 'none' ? SHORTCUT_TEXT.none : el('kbd', {}, [s.text]), ' · ');
    value.hidden = false;
    problem.textContent = s.kind === 'noModifier' ? SHORTCUT_TEXT.noModifier : '';
    problem.hidden = s.kind !== 'noModifier';
    onRead(s);
  }
  value.hidden = problem.hidden = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh();
  });
  void refresh();

  return row(SHORTCUT_TEXT.label, [el('p', { class: 'hint' }, [value, SHORTCUT_TEXT.where]), problem], change);
}
