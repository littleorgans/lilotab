// Names the manifest, the build config and the worker share. Pure, so the Node configs can import it.

// The switch command id, kept from the POC: renaming it drops every user's binding (05-events 3.1).
export const SWITCH_COMMAND = 'flip-tab';

// Extension pages by their build output path. The popup is set per tab, so the manifest never names it (05 4.3).
export const POPUP_PAGE = 'src/hosts/popup/index.html';
export const WELCOME_PAGE = 'src/pages/welcome/index.html'; // opened once on install (C-KEY-10)
