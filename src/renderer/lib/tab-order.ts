// V1.0129: tab order.
// Adam (2026-10-13): "I should be able to move tabs around, also why when I
// open all it doesn't just auto open them in the right order?"
//
// Opening several files from Finder fires one open-file event per file, and
// each was read + loaded concurrently, so tabs appeared in whatever order the
// loads FINISHED (random for files of different sizes). Now the paths that
// arrive together are collected, sorted the way Finder lists them by name
// (natural order: "2" before "10"), and opened one after another.

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Natural, case-insensitive file-name comparison (Finder's Name order). */
export function compareFileNames(a: string, b: string): number {
  return collator.compare(baseName(a), baseName(b)) || collator.compare(a, b);
}

/** Finder's "Name" order: natural, case-insensitive, by file name. */
export function sortPathsForOpen(paths: readonly string[]): string[] {
  return [...paths].sort(compareFileNames);
}

/** Move the item `id` to position `toIndex` (clamped). Returns the SAME
 *  array when nothing moves, so callers can skip a store update. */
export function moveId<T extends { id: string }>(items: T[], id: string, toIndex: number): T[] {
  const from = items.findIndex((t) => t.id === id);
  if (from < 0) return items;
  const to = Math.max(0, Math.min(items.length - 1, toIndex));
  if (to === from) return items;
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Collects paths that arrive close together and hands them over as one
 *  sorted batch once no new path has arrived for `quietMs`. Batches are
 *  processed strictly one after another (a batch arriving while the previous
 *  one is still opening waits its turn), and within a batch `open` is awaited
 *  per path, so tab order = sorted order. */
export function createOpenBatcher(
  open: (path: string) => Promise<void>,
  quietMs = 250,
  // V1.0130: WRAPPERS, never `{ set: setTimeout }`. Calling the browser's
  // setTimeout as a method of another object throws "Illegal invocation" in
  // Chromium (Node allows it, so the V1.0129 unit tests passed) — every
  // Finder open threw inside the IPC listener and NOTHING opened.
  timers: {
    set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clear: (t: ReturnType<typeof setTimeout>) => void;
  } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (t) => clearTimeout(t),
  },
) {
  let buffer: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const flush = () => {
    timer = null;
    const batch = sortPathsForOpen(Array.from(new Set(buffer)));
    buffer = [];
    chain = chain.then(async () => {
      for (const p of batch) {
        try {
          await open(p);
        } catch {
          // `open` reports its own errors; one bad file must not stop the rest.
        }
      }
    });
  };

  return {
    push(path: string) {
      buffer.push(path);
      if (timer) timers.clear(timer);
      timer = timers.set(flush, quietMs);
    },
    /** Resolves once everything pushed so far has been opened (tests). */
    async idle() {
      if (timer) {
        timers.clear(timer);
        flush();
      }
      await chain;
    },
    dispose() {
      if (timer) timers.clear(timer);
      timer = null;
      buffer = [];
    },
  };
}

/** V1.0131: which tab becomes active after tabs close. Adam: "when closing a
 *  tab … the last tab is auto selected, we should revert back to the first
 *  tab not last." If the active tab survives it stays active; otherwise the
 *  FIRST remaining tab; null when none remain. */
export function activeAfterClose(
  remaining: readonly { id: string }[],
  activeId: string | null,
): string | null {
  if (activeId && remaining.some((t) => t.id === activeId)) return activeId;
  return remaining[0]?.id ?? null;
}
