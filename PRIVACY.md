# Privacy

- **What it reads.** To list, search and switch tabs, Lilotab reads the titles and addresses of open tabs, along with tab and window IDs, tab state and last use times.
- **On your device.** Lilotab makes no network requests and sends no user data off your device. It has no account, sync or telemetry. It reads tab icons from Chrome's local favicon cache.
- **No standing site access.** Lilotab asks for no host permissions and declares no automatic content scripts. It can put the tab menu on the current page only when you use a Lilotab shortcut there.
- **Permissions:** `storage`, `tabs`, `favicon`, `activeTab` and `scripting`. Lilotab asks for the optional `sessions` permission only when you turn on recently closed tabs in search. It asks Chrome to remove the permission when you turn the setting off.
- **What it stores.** Chrome's local extension storage holds your settings and the IDs of tabs Lilotab keeps awake for quick switching. Session storage holds tab and window IDs and the order you used them in. It clears when Chrome closes or Lilotab is disabled, reloaded or updated. Lilotab saves no tab titles, addresses, icons or timestamps in extension storage.
- **Recently closed tabs in search.** Off by default. When on, Lilotab can ask Chrome for up to 25 recently closed entries from this device when you use a shortcut or click its toolbar button. It uses the tab entries, including their titles, addresses and closing times, and saves no copy.
- **Clipboard.** Lilotab copies the selected tab's address, or its title and address, to the clipboard only when you press the copy key.
- **Chrome Web Store disclosure.** In the store's privacy section, Lilotab declares Web history because it reads tab titles and addresses on your device. That data stays on your device.

Lilotab's use of information received from Chrome APIs adheres to the [Chrome Web Store User Data Policy, including the Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use).
