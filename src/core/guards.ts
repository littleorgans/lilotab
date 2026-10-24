// Shape checks shared by every parser at a boundary: protocol messages, stored settings, the session envelope.

export type Fields = Readonly<Record<string, unknown>>;

// A plain object: not null, not an array, prototype Object or null.
export function isRecord(raw: unknown): raw is Fields {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const proto: unknown = Object.getPrototypeOf(raw);
  return proto === Object.prototype || proto === null;
}

// A plain object with exactly these keys (05-events 4.6: unknown fields reject).
export function hasExactly(raw: unknown, keys: readonly string[]): raw is Fields {
  if (!isRecord(raw)) return false;
  const own = Object.keys(raw);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(raw, k));
}

export const isIndex = (v: unknown, length: number): v is number =>
  Number.isInteger(v) && (v as number) >= 0 && (v as number) < length;

export const isCount = (v: unknown, min: number): v is number => Number.isSafeInteger(v) && (v as number) >= min;

export const isOneOf = <T>(v: unknown, values: readonly T[]): v is T => values.includes(v as T);

export const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
