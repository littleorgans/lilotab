export interface ReleaseNotes {
  take(key: string | undefined): KeyboardEvent | null;
  stop(): void;
}

// Before the session listens (K-01, C-POP-07), remember the last trusted keyup of each key until a later keydown
// of that key. These listeners only observe the event.
export function noteReleases(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  alive?: () => boolean,
): ReleaseNotes {
  const released = new Map<string, KeyboardEvent>();
  const events = ['keydown', 'keyup'] as const;
  const capture = { capture: true, passive: true };
  function observe(e: KeyboardEvent): void {
    if (alive?.() === false || !e.isTrusted) return;
    if (e.type === 'keyup') released.set(e.key, e);
    else released.delete(e.key);
  }
  for (const type of events) {
    target.addEventListener(type, observe, capture);
  }
  function stop(): void {
    for (const type of events) target.removeEventListener(type, observe, capture);
    released.clear();
  }
  return {
    take(key) {
      const event = key === undefined ? null : (released.get(key) ?? null);
      stop();
      return event;
    },
    stop,
  };
}
