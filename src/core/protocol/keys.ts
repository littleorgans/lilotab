// Chrome's key tokens that are not a letter or digit, in every form the extension meets them (05-events 2.4, 4.9).
// Letters and digits stand for themselves in every form.

// Modifiers in contract display order, primary first (C-KEY-01 to C-KEY-03).
export const MODIFIERS = ['meta', 'ctrl', 'alt', 'shift'] as const;

interface NamedKey {
  key: string; // KeyboardEvent key
  code: string; // KeyboardEvent code
  symbol?: string; // macOS symbol form in a commands.getAll shortcut
  text?: string; // contract display form, when it is not the token (C-KEY-01)
}

export const NAMED_KEYS: Readonly<Record<string, NamedKey>> = {
  Comma: { key: ',', code: 'Comma', symbol: ',', text: ',' },
  Period: { key: '.', code: 'Period', symbol: '.', text: '.' },
  Space: { key: ' ', code: 'Space', symbol: ' ' },
  Home: { key: 'Home', code: 'Home', symbol: '↖' },
  End: { key: 'End', code: 'End', symbol: '↘' },
  PageUp: { key: 'PageUp', code: 'PageUp', symbol: '⇞' },
  PageDown: { key: 'PageDown', code: 'PageDown', symbol: '⇟' },
  Insert: { key: 'Insert', code: 'Insert' },
  Delete: { key: 'Delete', code: 'Delete', symbol: '⌦' },
  Up: { key: 'ArrowUp', code: 'ArrowUp', symbol: '↑' },
  Down: { key: 'ArrowDown', code: 'ArrowDown', symbol: '↓' },
  Left: { key: 'ArrowLeft', code: 'ArrowLeft', symbol: '←' },
  Right: { key: 'ArrowRight', code: 'ArrowRight', symbol: '→' },
};

const SYMBOL_TOKENS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(NAMED_KEYS).flatMap(([token, k]) => (k.symbol === undefined ? [] : [[k.symbol, token]])),
);

// A shortcut's key part, in either form, as Chrome's key token.
export const keyToken = (key: string): string => SYMBOL_TOKENS[key] ?? (key.length === 1 ? key.toUpperCase() : key);

// A key token in the contract display form: "," for Comma, "." for Period, otherwise the token itself.
export const keyText = (token: string): string => NAMED_KEYS[token]?.text ?? token;
