// Popup host: the toolbar popup page, the fallback where the page cannot host the overlay, and toolbar search
// (03-components 3.3, 05-events 4.3, C-POP). After start it runs the same session as the overlay.

import { clearOwnedPopup } from '../../browser/action-popup.ts';
import { portName } from '../../core/protocol/index.ts';
import { PRODUCT } from '../../strings.ts';
import { createListSurface, type ListSurface } from '../list-view/index.ts';
import { runSession } from '../session/index.ts';

const attempt = location.hash.slice(1); // the worker refuses a port whose name does not match this page's hash
document.title = PRODUCT;

// Clears this tab's popup while it still names this attempt, so a worker stop between setPopup and its clear never
// leaves the icon opening a stale popup (05 4.3, E-7d). Idempotent; the worker clears it too.
async function clearOwnPopup(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) await clearOwnedPopup(tab.id, attempt);
}
clearOwnPopup().catch(() => undefined);

let surface: ListSurface | null = null;

runSession(chrome.runtime.connect({ name: portName(attempt) }), {
  alive: () => true, // an extension page closes with its extension
  dispose: () => undefined,
  decline: () => null, // a popup never declines (05 4.6)
  mount() {
    surface = createListSurface(document, 'popup');
    const mounted = surface;
    return {
      surface: mounted,
      owns: () => true, // the whole page is the list
      latch: () => {
        mounted.latch();
      },
      unlatch: () => {
        mounted.unlatch();
        mounted.focus(); // the list, as at start in hold
      },
      // No close fade: Chrome removes the window at window.close() (03 4.12).
      hide: () => {
        mounted.hide(false);
      },
      remove: () => {
        void mounted.close();
      },
    };
  },
  // Keys reach the popup only once it has focus; the list then takes it, the field in search (05 3.3).
  async focused() {
    if (!document.hasFocus()) {
      await new Promise((resolve) => {
        window.addEventListener('focus', resolve, { once: true });
      });
    }
    surface?.focus();
  },
  // the worker's disconnect is the close (05 4.4, C-POP-04)
  closed: () => {
    window.close();
  },
});
