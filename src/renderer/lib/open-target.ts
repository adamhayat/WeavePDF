// V1.0133: what a Finder / Dock / "Open With" open should do when the file is
// ALREADY open in a tab.
//
// Adam (2026-10-20): "when you updated a PDF, save it as the exact same
// filename, and reopen it in Weave, it opens the last version. You have to
// close again, then reopen again, and then it shows the correct updated PDF."
//
// Since V1.0027 the open path switched to any tab whose `path` matched and
// never read the file — so a tab holding an OLDER version of that path (the
// original still open after a Save As over it from another tab, a restored
// draft, a tab opened before the file was replaced on disk) was shown as if
// it were the file. The file's own identity settles it: every tab remembers
// the mtime + size of the bytes it loaded or wrote (`disk`), and a tab is
// only reused while that stamp still matches what is on disk now.

export type DiskStamp = { mtimeMs: number; sizeBytes: number };

export type OpenCandidate = {
  id: string;
  path: string | null;
  dirty: boolean;
  disk: DiskStamp | null;
};

export type OpenTarget =
  /** A tab already shows exactly this file: just bring it forward. */
  | { action: "activate"; tabId: string }
  /** The tab's copy is out of date and it holds nothing unsaved: close it
   *  and load the file fresh in its place. */
  | { action: "replace"; tabId: string }
  /** No tab shows this file (or the only ones that do carry unsaved work
   *  and must be kept): load the file in a new tab. */
  | { action: "open"; keptDirtyTabIds: string[] };

export function sameDisk(a: DiskStamp | null, b: DiskStamp | null): boolean {
  return !!a && !!b && a.mtimeMs === b.mtimeMs && a.sizeBytes === b.sizeBytes;
}

export function resolveOpenTarget(
  tabs: readonly OpenCandidate[],
  path: string,
  onDisk: DiskStamp,
): OpenTarget {
  const matching = tabs.filter((t) => t.path === path);
  // Prefer a tab that provably shows the current file — whichever position
  // it sits in (the newest save may live in a later tab than the original).
  const current = matching.find((t) => sameDisk(t.disk, onDisk));
  if (current) return { action: "activate", tabId: current.id };
  // Every match is stale (or of unknown vintage — tabs that never recorded a
  // stamp are treated as stale, never trusted). A clean one costs nothing to
  // refresh; a dirty one holds work and stays.
  const stale = matching.find((t) => !t.dirty);
  if (stale) return { action: "replace", tabId: stale.id };
  return { action: "open", keptDirtyTabIds: matching.map((t) => t.id) };
}
