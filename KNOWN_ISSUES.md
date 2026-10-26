# Known issues

## The list stays open after you release the shortcut in the popup

Lilotab shows the list in the toolbar popup when Show the list is set to In a popup, and on pages where the list cannot open over the page, such as browser pages (`chrome://`), PDFs and pages where focus is inside a frame.

In the popup, Chrome can stop passing the release of the modifier (Cmd on macOS) to Lilotab. This happens if you press the shortcut (Cmd+E by default on macOS) a second time while holding, or hold the letter long enough for it to repeat. A release before the popup can receive key events can also be missed.

**What you see:** the list stays open after you let go of the modifier.

**Workaround:** press Enter or an arrow key, or tap the modifier.

Chrome has an open report of this behaviour: [Chromium issue 409585895](https://issues.chromium.org/issues/409585895) (open as of 2026-10-25).
