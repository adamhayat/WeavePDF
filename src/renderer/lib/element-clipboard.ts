/**
 * V1.0134: ⌘C / ⌘X / ⌘V for placed elements (text boxes, images, shapes).
 *
 * Adam: "I can't copy the text element, command C and it won't copy and
 * paste." The Edit menu's Copy/Paste were the browser roles, which only know
 * about selected DOM text — a selected text BOX has no DOM selection, so
 * ⌘C did nothing and ⌘V had no listener at all outside the right-click
 * "Paste here".
 *
 * Model: an in-app clipboard remembers the copied elements with every
 * attribute (font, bold, width, border, rotation…). The system clipboard
 * gets the plain text (for text boxes) or the PNG (for an image) so the
 * copy also works in other apps. On paste, the SYSTEM clipboard decides
 * whether the user has copied something newer elsewhere since: if it still
 * matches what we wrote, the rich in-app copy is pasted; otherwise the
 * system content is pasted as a new element.
 *
 * Pure decisions live here (unit-tested); the DOM/event wiring is in
 * element-clipboard-actions.ts.
 */
import type { ElementRef } from "./element-geometry";
import { anchorOf, clampTranslationToPage, stripIdentity, translateElement } from "./element-geometry";

export type ElementClipboard = {
  entries: ElementRef[];
  /** What we wrote to the system clipboard as text (text boxes only). */
  text: string | null;
  /** Byte length of the PNG we wrote to the system clipboard, if any. */
  imageByteLength: number | null;
  /** How many times this clipboard has been pasted — each paste steps the
   *  offset so repeated ⌘V doesn't stack copies on one spot. */
  pasteCount: number;
};

export type SystemClipboardView = {
  text: string;
  /** Byte length of the first image on the system clipboard, null if none. */
  imageByteLength: number | null;
};

export type PasteSource = "elements" | "system-text" | "system-image" | "none";

/** V1.0135: one ⌘V (or ⌘C) in Electron on macOS can deliver the same
 *  clipboard event TWICE — the Edit menu's `role: "paste"` runs the browser
 *  paste command, and the page still receives the ⌘V keydown, which Blink
 *  turns into a second paste command. Adam pasted a text box once and got it
 *  twice (the second ran as a system-text paste, 12 pt, over his image).
 *  Two genuine pastes by a human are never this close together. */
export const CLIPBOARD_EVENT_DEDUPE_MS = 150;

export function isDuplicateClipboardEvent(lastHandledAt: number | null, now: number): boolean {
  return lastHandledAt != null && now >= lastHandledAt && now - lastHandledAt < CLIPBOARD_EVENT_DEDUPE_MS;
}

/** Offset between a copy and its source, in points (Keynote uses the same). */
export const PASTE_OFFSET_PT = 12;

export function buildClipboard(entries: ElementRef[]): ElementClipboard | null {
  if (entries.length === 0) return null;
  const texts = entries.filter((e): e is Extract<ElementRef, { kind: "text" }> => e.kind === "text").map((e) => e.edit.text);
  const firstImage = entries.find((e): e is Extract<ElementRef, { kind: "image" }> => e.kind === "image");
  return {
    entries,
    text: texts.length > 0 ? texts.join("\n") : null,
    imageByteLength: firstImage ? firstImage.edit.bytes.byteLength : null,
    pasteCount: 0,
  };
}

/**
 * Which content a ⌘V should produce. The in-app copy wins only while the
 * system clipboard still holds what that copy wrote — once the user copies
 * text or an image in another app, the system content is newer and wins.
 * Shape-only copies write nothing to the system clipboard, so they win
 * unless the system clipboard carries an image (text left over from before
 * the shape copy can't be told apart, so the shape wins there).
 */
export function choosePasteSource(clip: ElementClipboard | null, system: SystemClipboardView): PasteSource {
  const hasText = system.text.trim().length > 0;
  const hasImage = system.imageByteLength != null;
  if (clip) {
    if (clip.text != null) {
      // Trimmed: a clipboard round-trip may add or drop a trailing newline.
      if (system.text.trim() === clip.text.trim()) return "elements";
    } else if (clip.imageByteLength != null) {
      if (!hasImage || system.imageByteLength === clip.imageByteLength) return "elements";
    } else if (!hasImage) {
      return "elements";
    }
  }
  if (hasImage) return "system-image";
  if (hasText) return "system-text";
  return "none";
}

export type PastePlacement = {
  targetPage: number;
  pageW: number;
  pageH: number;
  marginsEnabled: boolean;
  /** 0 for the first paste of this clipboard, 1 for the next… */
  pasteIndex: number;
};

/** The elements a paste adds: copies of the clipboard, stepped by the
 *  paste offset when they land on the page they came from, clamped so every
 *  copy stays on the page. Identity fields are stripped — the store mints
 *  fresh ones, and the copies land on top. */
export function placePastedElements(clip: ElementClipboard, p: PastePlacement): ElementRef[] {
  const margin = p.marginsEnabled ? 36 : 0;
  const step = PASTE_OFFSET_PT * (p.pasteIndex + 1);
  return clip.entries.map((el) => {
    const samePage = el.edit.page === p.targetPage;
    const want = samePage ? { x: step, y: -step } : { x: 0, y: 0 };
    const d = clampTranslationToPage(el, want.x, want.y, p.pageW, p.pageH, margin);
    const moved = translateElement(el, d.x, d.y);
    const edit = { ...stripIdentity(moved), page: p.targetPage };
    return { kind: el.kind, edit } as ElementRef;
  });
}

/** Where a system paste lands: the middle of the part of the page that is on
 *  screen (so pasting into a long page puts the content where the user is
 *  looking), in PDF points. Falls back to the page centre when the page is
 *  entirely off screen. */
export function visibleCenterPt(
  page: { left: number; top: number; width: number; height: number },
  viewport: { left: number; top: number; width: number; height: number },
  zoom: number,
  pageHeightPt: number,
): { x: number; y: number } {
  const z = zoom > 0 ? zoom : 1;
  const l = Math.max(page.left, viewport.left);
  const t = Math.max(page.top, viewport.top);
  const r = Math.min(page.left + page.width, viewport.left + viewport.width);
  const b = Math.min(page.top + page.height, viewport.top + viewport.height);
  const cx = r > l ? (l + r) / 2 : page.left + page.width / 2;
  const cy = b > t ? (t + b) / 2 : page.top + page.height / 2;
  return { x: (cx - page.left) / z, y: pageHeightPt - (cy - page.top) / z };
}

/** The selection a paste leaves behind: every pasted element selected, the
 *  last one primary. */
export function pastedSelection(ids: Array<{ kind: ElementRef["kind"]; id: string }>): {
  primary: { kind: ElementRef["kind"]; id: string } | null;
  group: string[];
} {
  if (ids.length === 0) return { primary: null, group: [] };
  return { primary: ids[ids.length - 1], group: ids.length > 1 ? ids.map((i) => i.id) : [] };
}

export { anchorOf };
