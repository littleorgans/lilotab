// A held key release a host page received before its session listens (C-POP-07, C-HOLD-28, 04-state-machine 5): from
// the popup page's first script or the overlay's frame take, the last trusted keyup of each key until a later keydown
// of that key. Its listeners only read: they never prevent, stop or move focus.
export function noteReleases(target: Pick<Window, 'addEventListener'>): (key: string) => Event | null {
  const released = new Map<string, Event>();
  const stop = new AbortController();
  for (const type of ['keydown', 'keyup'] as const) {
    target.addEventListener(
      type,
      (e) => {
        if (!e.isTrusted) return;
        if (type === 'keyup') released.set(e.key, e);
        else released.delete(e.key);
      },
      { capture: true, signal: stop.signal },
    );
  }
  // Read once, when the session listens or declines; from then on it hears each key itself.
  return (key) => {
    stop.abort();
    return released.get(key) ?? null;
  };
}
