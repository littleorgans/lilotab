// The list's one notice: a line over its foot that clears itself, for copy and sort (C-SRCH-26, C-HOLD-30).

import { el } from './paint.ts';

export interface Notice {
  readonly element: HTMLElement;
  say(text: string): void; // replaces any line still shown and restarts its time
  dispose(): void;
}

const NOTICE_MS = 2_000;

export function createNotice(): Notice {
  const element = el('div', 'notice');
  element.setAttribute('role', 'status');
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    element,
    say(text) {
      element.textContent = text;
      clearTimeout(timer);
      timer = setTimeout(() => {
        element.textContent = '';
      }, NOTICE_MS);
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}
