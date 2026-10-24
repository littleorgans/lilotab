// Scheme, host and path of an address. The core sees only the ES library, so it cannot use the platform URL parser.

export interface UrlParts {
  scheme: string; // lower case, no ':'
  host: string; // lower case, no user info or port; '' when the address has no authority
  path: string;
}

const SHAPE = /^([a-z][a-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)/i;

export function urlParts(url: string): UrlParts {
  const m = SHAPE.exec(url);
  if (!m) return { scheme: '', host: '', path: '' };
  const authority = (m[2] ?? '').replace(/^.*@/, '');
  const host = authority.startsWith('[')
    ? authority.slice(0, authority.indexOf(']') + 1)
    : authority.replace(/:\d*$/, '');
  return { scheme: (m[1] ?? '').toLowerCase(), host: host.toLowerCase(), path: m[3] ?? '' };
}
