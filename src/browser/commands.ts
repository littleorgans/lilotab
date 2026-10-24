// The switch command's raw shortcut from commands.getAll, for the worker and the pages to parse (05-events 2.4).

import { SWITCH_COMMAND } from '../worker/names.ts';

// The browser's own string; empty when the command is unbound (C-KEY-09).
export async function readShortcut(): Promise<string> {
  const commands = await chrome.commands.getAll();
  return commands.find((c) => c.name === SWITCH_COMMAND)?.shortcut ?? '';
}
