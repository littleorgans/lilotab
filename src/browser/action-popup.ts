// Action popup ownership, shared by the worker and the popup page, so it imports nothing beyond chrome (05-events 4.3).

import type { AttemptId } from '../core/index.ts';

// Clears the tab's popup only while it still names this attempt, leaving a newer one alone (POC inPopup clear).
export async function clearOwnedPopup(tabId: number, attempt: AttemptId): Promise<void> {
  const popup = await chrome.action.getPopup({ tabId });
  if (popup.endsWith(`#${attempt}`)) await chrome.action.setPopup({ tabId, popup: '' });
}
