// Copy from the list, and the notice when it could not (C-SRCH-26).

import { LIST_TEXT } from '../../strings.ts';
import type { Notice } from './notice.ts';

export interface Clipboard {
  // Copies in the trusted key handler, or says it could not when text is null or the browser refuses.
  copy(text: string | null): void;
}

// box holds the temporary textarea, inside root; notice says "Could not copy".
export function createClipboard(root: Document | ShadowRoot, box: HTMLElement | ShadowRoot, notice: Notice): Clipboard {
  // Synchronous copy with no clipboard permission (probe p-clip): a temporary textarea inside the root, so page script
  // never sees the text (C-HOLD-20); then focus and selection go back where they were, the page's own in hold.
  function copyText(text: string): boolean {
    const prior = root.activeElement ?? document.activeElement;
    const input = prior instanceof HTMLInputElement || prior instanceof HTMLTextAreaElement ? prior : null;
    const start = input?.selectionStart ?? null;
    const end = input?.selectionEnd ?? null;
    const direction = input?.selectionDirection ?? undefined;
    const area = document.createElement('textarea');
    area.style.cssText = 'position: absolute; top: -100px;';
    area.value = text;
    box.append(area);
    area.focus({ preventScroll: true });
    area.select();
    let ok = false;
    try {
      // oxlint-disable-next-line typescript/no-deprecated -- the one copy route a page's Permissions-Policy cannot block.
      ok = document.execCommand('copy');
    } catch {
      // refused: the caller says so
    }
    area.remove();
    if (prior instanceof HTMLElement) prior.focus({ preventScroll: true });
    if (input && start !== null && end !== null) input.setSelectionRange(start, end, direction);
    return ok;
  }

  return {
    copy(text) {
      if (text === null || !copyText(text)) notice.say(LIST_TEXT.notCopied);
    },
  };
}
