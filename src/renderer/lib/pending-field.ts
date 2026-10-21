// V1.0123: flush the form field the user is still typing in.
//
// AcroForm text widgets commit their value on BLUR. Saving does not blur
// anything — the macOS ⌘S menu accelerator fires straight into the app with
// the caret still in the field — so the value on screen was written to the
// widget's React state but never into the PDF. The save then wrote the OLD
// value, toasted "Saved." and marked the tab clean, while the user kept
// looking at the new one. (Reproduced: typed "UNFLUSHED-VALUE", saved, file
// on disk still held the previous value.)
//
// The focused widget registers its committer here; save/print await it first.
// V1.0126: a WeavePDF text box being edited registers here too — ⌘S used to
// save the box's OLD text while you were still typing in it.

type Flusher = () => Promise<void>;

let activeFlusher: Flusher | null = null;

/** Called by a form widget on focus (with its committer) and on blur (null). */
export function setActiveFieldFlusher(fn: Flusher | null): void {
  activeFlusher = fn;
}

/** V1.0126: unregister `fn` only if it is still the active flusher — a
 *  component cleaning up must not wipe a flusher another one registered. */
export function clearActiveFieldFlusher(fn: Flusher): void {
  if (activeFlusher === fn) activeFlusher = null;
}

/** Commit whatever the user has typed into the focused field. Safe to call
 *  when nothing is focused. Never throws — a failed flush must not take the
 *  save down with it; the save's own error handling still applies. */
export async function flushActiveFormField(): Promise<void> {
  const fn = activeFlusher;
  if (!fn) return;
  try {
    await fn();
  } catch (err) {
    console.error("flushActiveFormField", err);
  }
}
