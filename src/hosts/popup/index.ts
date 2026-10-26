// Popup host: the toolbar popup page, the fallback where the page cannot host the overlay, and toolbar search
// (03-components 3.3, 05-events 4.3, C-POP). After start it runs the same session as the overlay.

import { clearOwnedPopup } from '../../browser/action-popup.ts';
import { portName } from '../../core/protocol/index.ts';
import { PRODUCT } from '../../strings.ts';
import { createListSurface } from '../list-view/index.ts';
import { noteReleases } from '../session/early.ts';
import { runSession } from '../session/index.ts';
import { createProbe } from './probe.ts';

const attempt = location.hash.slice(1); // the worker refuses a port whose name does not match this page's hash
// Measurement builds only, tested inline so release builds drop it (src/browser/timing.ts); before the session, so its
// listeners run first.
const probe = import.meta.env.MODE === 'timing' ? createProbe(attempt) : null;
const released = noteReleases(window); // a release before the session listens still counts (C-POP-07)
document.title = PRODUCT;

// Clears this tab's popup while it still names this attempt, so a worker stop between setPopup and its clear never
// leaves the icon opening a stale popup (05 4.3, E-7d). Idempotent; the worker clears it too.
async function clearOwnPopup(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) await clearOwnedPopup(tab.id, attempt);
}
clearOwnPopup().catch(() => undefined);

runSession(chrome.runtime.connect({ name: portName(attempt) }), {
  alive: () => true, // an extension page closes with its extension
  dispose: () => undefined,
  decline: () => null, // a popup never declines (05 4.6)
  mount() {
    const surface = createListSurface(document, 'popup');
    return {
      surface,
      owns: () => true, // the whole page is the list
      // Keys reach the popup only once it has focus; the list then takes it, the field in search (05 3.3).
      async focused() {
        probe?.focusing();
        if (!document.hasFocus()) {
          await new Promise((resolve) => {
            window.addEventListener('focus', resolve, { once: true });
          });
        }
        surface.focus();
        probe?.focused();
        return null;
      },
      released,
      latch: () => {
        surface.latch();
      },
      unlatch: () => {
        surface.unlatch();
        surface.focus(); // the list, as at start in hold
      },
      // No close fade: Chrome removes the window at window.close() (03 4.12).
      hide: () => {
        surface.hide(false);
      },
      remove: () => {
        void surface.close();
      },
    };
  },
  // the worker's disconnect is the close (05 4.4, C-POP-04)
  closed: () => {
    probe?.closed();
    window.close();
  },
  ...(probe && { sensed: probe.sensed }),
});
