# How Lilotab works

Lilotab is a condensed view of everything you've got open, grouped by window, so you can see it all in one place.

- **Tap** the shortcut to switch to your last used tab.
- **Hold** the modifier to see the tabs of one window, most recent first, starting with the window your last used tab is in. Press the shortcut letter again to step back through your tabs across windows, most recently used first. Up and Down move within the shown window. With the default **On release** setting, release to switch. With **Keep list open**, moving the selection keeps the list open after release. Use Enter or click a row to switch, or press Esc to close.
- **Windows:** with more than one window open, a strip of window icons sits above the list. Left and Right step through the windows.
- **Search:** press F while holding to search tabs across every window. Press the modifier and F again to drop the query and go back to the window list. The **On release** setting applies when you return to the list.
- **Sort:** press S while holding to sort the list by title, and again to go back. In search, Cmd+S (Ctrl+S on Windows and Linux) sorts too.
- **Close:** press Ctrl+Cmd+W (Ctrl+Alt+W on Windows and Linux) to close the highlighted tab. The list stays open and the highlight moves to the next row. It does nothing on the tab you started from.
- **Toolbar:** click the toolbar icon to search all your tabs.

## Settings

Quick tap (toggle to your last tab or open the list), quick tap scope, hold delay, tab order, where the list shows, what happens on release, recently closed tabs in search, a tab count badge, theme, text size and reduce motion, plus clearing history and restoring defaults.

## Where it runs

Requires desktop Chrome 148 or later. Lilotab does not run in private windows.

The list opens over the page, above dialogs and fullscreen content. On pages that cannot host it, such as browser pages or PDFs, and when the address bar has focus, it opens in the toolbar popup.

A welcome tab shows your shortcut on first install.

Vivaldi is out of the browser test matrix for now: it rejects `chrome.action.openPopup` (Vivaldi bug VB-120122), so the toolbar popup does not open there.

## Speed

Under one frame at 100 tabs, measured with Lilotab already awake. With 100 tabs open, the list opened in a median of 10.7 to 12.7 ms across three runs, where a 60 Hz screen gives each frame 16.7 ms.

This was measured on 2026-11-22 in headless Chrome on one Mac, on a development build. Later builds were not measured again, and no run was made with more than 100 real tabs. When Chrome has put Lilotab to sleep, the first press takes longer.

## Build from source

You need Node 24.22.1 and just 1.59, as pinned in `mise.toml`.

1. Clone this repository, then run `just install` and `just build`. The build writes the extension to `dist/`.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose `dist/`.

Keep the folder: Chrome runs Lilotab from it.

`just build-timing` creates a measurement build in `dist-timing/` with the gesture timing log on the options page; load it unpacked from that folder and never ship it. `just build` stays a release build in `dist/`.

## Contributing

We are not accepting pull requests. Report a problem or ask for a feature in [GitHub issues](https://github.com/littleorgans/lilotab/issues). For known problems and workarounds, see [Known issues](KNOWN_ISSUES.md).

## Price and licence

Lilotab is free, with no account, trial or paid tier.

Source available under PolyForm Perimeter 1.0.1 ([LICENSE](LICENSE)). Providing a competing product, including a free rebranded store copy, is not permitted. See [TRADEMARKS.md](TRADEMARKS.md).
