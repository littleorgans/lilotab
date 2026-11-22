// Text rules ranking shares with the match highlight, so a mark never disagrees with a match (C-SRCH-09, C-SRCH-30).

// Explicit and locale free, so results match on every machine: compatibility decompose, drop marks, lower case.
export const normalize = (s: string): string => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

export const words = (query: string): string[] => normalize(query).split(/\s+/u).filter(Boolean);

const WORD_START = /[\p{L}\p{N}]/u;

// The first occurrence of word in text that starts a word of it, else -1.
export function wordStart(text: string, word: string): number {
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) {
    if (i === 0) return i;
    // A supplementary code point occupies two UTF-16 code units (C-SRCH-10).
    const start = (text.codePointAt(i - 2) ?? 0) > 0xffff ? i - 2 : i - 1;
    if (!WORD_START.test(text.slice(start, i))) return i;
  }
  return -1;
}

// normalize, one code point at a time, with each normalized unit's source code point, so a match found in normalized
// text maps back to the characters it came from (C-SRCH-30). from and to are UTF-16 offsets into the source; a mark
// normalize drops joins the unit before it, so a mapped range never splits a character from its accent.
export interface Folded {
  text: string;
  from: readonly number[];
  to: readonly number[];
}

const PLAIN = /^[ -~]*$/; // printable ASCII folds in place

export function foldMap(s: string): Folded {
  if (PLAIN.test(s)) {
    const at = Array.from(s, (_, i) => i);
    return { text: s.toLowerCase(), from: at, to: at.map((i) => i + 1) };
  }
  let text = '';
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const point of s) {
    const end = at + point.length;
    const unit = normalize(point);
    if (unit === '') for (let k = to.length - 1; k >= 0 && to[k] === at; k--) to[k] = end;
    for (let k = 0; k < unit.length; k++) {
      from.push(at);
      to.push(end);
    }
    text += unit;
    at = end;
  }
  return { text, from, to };
}
