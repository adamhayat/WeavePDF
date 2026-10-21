/**
 * V1.0134: DOM wiring for ⌘C / ⌘X / ⌘V on placed elements. The decisions
 * are in element-clipboard.ts (pure, unit-tested); this file listens to the
 * document's clipboard events and talks to the stores.
 *
 * Why clipboard EVENTS and not key handlers: the Edit menu's Copy / Cut /
 * Paste are Electron roles. A role runs the browser command, and the browser
 * command dispatches exactly one `copy` / `cut` / `paste` event on the
 * focused element (the body when nothing is focused) — whether it came from
 * the menu or from the ⌘ key. Listening there means one code path, no
 * double-paste, and `paste` hands us the clipboard contents directly
 * (`clipboardData`), with no permission prompt.
 */
import { useDocumentStore } from "../stores/document";
import { useUIStore } from "../stores/ui";
import { bytesToBlob } from "../../shared/buffers";
import {
  buildClipboard,
  choosePasteSource,
  isDuplicateClipboardEvent,
  pastedSelection,
  placePastedElements,
  visibleCenterPt,
  type ElementClipboard,
} from "./element-clipboard";
import { stripIdentity, type ElementRef } from "./element-geometry";
import { resolveElementRefs, selectedElementIds } from "./group-move";

const MIN_WRAP_TEXT_WIDTH_PT = 120;
const PAGE_MARGIN = 36;
const PASTE_TEXT_SIZE = 12;

let clip: ElementClipboard | null = null;
// V1.0135: timestamps of the last copy/cut and paste we HANDLED, to swallow
// the duplicate event Electron delivers for one keystroke (see
// isDuplicateClipboardEvent).
let lastCopyHandledAt: number | null = null;
let lastPasteHandledAt: number | null = null;

/** Test hook: forget the dedupe timestamps. */
export function resetClipboardDedupe(): void {
  lastCopyHandledAt = null;
  lastPasteHandledAt = null;
}

/** Test/diagnostic hook. */
export function currentElementClipboard(): ElementClipboard | null {
  return clip;
}

function isEditableTarget(t: EventTarget | null): boolean {
  const el = t instanceof HTMLElement ? t : document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function cloneRef(r: ElementRef): ElementRef {
  if (r.kind === "image") {
    return { kind: "image", edit: { ...r.edit, bytes: r.edit.bytes.slice() } };
  }
  if (r.kind === "text") return { kind: "text", edit: { ...r.edit, whiteout: r.edit.whiteout ? { ...r.edit.whiteout } : undefined } };
  const s = r.edit;
  if (s.kind === "freehand") return { kind: "shape", edit: { ...s, points: s.points.map((p) => ({ ...p })) } };
  return { kind: "shape", edit: { ...s } };
}

function handleCopy(e: ClipboardEvent, cut: boolean): void {
  if (e.defaultPrevented) return;
  if (isEditableTarget(e.target)) return;
  if (isDuplicateClipboardEvent(lastCopyHandledAt, e.timeStamp)) {
    // The second delivery of the same ⌘C/⌘X. The first already filled the
    // clipboard (and, for a cut, removed the elements — a second cut would
    // find nothing selected, but keep it symmetrical and explicit).
    e.preventDefault();
    return;
  }
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.rangeCount > 0) return; // page text selection → native / Viewer copy
  const tab = useDocumentStore.getState().activeTab();
  if (!tab) return;
  const refs = resolveElementRefs(tab, selectedElementIds());
  if (refs.length === 0) return;
  const next = buildClipboard(refs.map(cloneRef));
  if (!next) return;
  clip = next;
  e.preventDefault();
  lastCopyHandledAt = e.timeStamp;
  const dt = e.clipboardData;
  if (next.text != null) {
    dt?.setData("text/plain", next.text);
  } else {
    dt?.clearData();
    const img = refs.find((r): r is Extract<ElementRef, { kind: "image" }> => r.kind === "image");
    if (img && img.edit.mime === "image/png" && typeof ClipboardItem !== "undefined") {
      // Chromium's async clipboard accepts PNG only. The length we record
      // is what choosePasteSource compares on the next ⌘V.
      const blob = bytesToBlob(img.edit.bytes, "image/png");
      void navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).catch(() => {
        /* not fatal: the in-app copy still pastes inside WeavePDF */
      });
    }
  }
  if (cut) {
    const store = useDocumentStore.getState();
    store.pushUndoStep(tab.id);
    for (const r of refs) {
      if (r.kind === "text") store.removePendingTextEdit(tab.id, r.edit.id);
      else if (r.kind === "image") store.removePendingImageEdit(tab.id, r.edit.id);
      else store.removePendingShapeEdit(tab.id, r.edit.id);
    }
    useUIStore.getState().clearAllPendingSelections();
  }
}

async function pageSizePt(tab: ReturnType<ReturnType<typeof useDocumentStore.getState>["activeTab"]>, page: number): Promise<{ w: number; h: number } | null> {
  if (!tab?.pdf) return null;
  try {
    const p = await tab.pdf.getPage(page);
    const vp = p.getViewport({ scale: 1 });
    return { w: vp.width, h: vp.height };
  } catch {
    return null;
  }
}

function pasteOrigin(page: number, zoom: number, pageHPt: number, pageWPt: number): { x: number; y: number } {
  const pageEl = document.querySelector<HTMLElement>(`[data-page="${page}"]`);
  const scroller = document.querySelector<HTMLElement>(".acr-scroll");
  if (!pageEl || !scroller) return { x: pageWPt / 2, y: pageHPt / 2 };
  const pr = pageEl.getBoundingClientRect();
  const sr = scroller.getBoundingClientRect();
  return visibleCenterPt(
    { left: pr.left, top: pr.top, width: pr.width, height: pr.height },
    { left: sr.left, top: sr.top, width: sr.width, height: sr.height },
    zoom,
    pageHPt,
  );
}

async function imageToPngOrJpeg(file: File): Promise<{ bytes: Uint8Array; mime: "image/png" | "image/jpeg"; w: number; h: number } | null> {
  try {
    const bmp = await createImageBitmap(file);
    const mime: "image/png" | "image/jpeg" = file.type === "image/jpeg" || file.type === "image/jpg" ? "image/jpeg" : "image/png";
    if (file.type === "image/png" || mime === "image/jpeg") {
      return { bytes: new Uint8Array(await file.arrayBuffer()), mime, w: bmp.width, h: bmp.height };
    }
    // Anything else (webp, gif, tiff, bmp) → PNG through a canvas.
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/png"));
    if (!blob) return null;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/png", w: bmp.width, h: bmp.height };
  } catch {
    return null;
  }
}

async function handlePaste(e: ClipboardEvent): Promise<void> {
  if (e.defaultPrevented) return;
  if (isEditableTarget(e.target)) return;
  if (isDuplicateClipboardEvent(lastPasteHandledAt, e.timeStamp)) {
    // The second delivery of the same ⌘V — Adam's "it printed it twice".
    e.preventDefault();
    return;
  }
  const tab = useDocumentStore.getState().activeTab();
  if (!tab?.pdf) return;
  const dt = e.clipboardData;
  if (!dt) return;
  const text = dt.getData("text/plain") ?? "";
  let imageFile: File | null = null;
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      imageFile = item.getAsFile();
      if (imageFile) break;
    }
  }
  const source = choosePasteSource(clip, { text, imageByteLength: imageFile ? imageFile.size : null });
  if (source === "none") return;
  e.preventDefault();
  lastPasteHandledAt = e.timeStamp;

  const page = tab.currentPage;
  const size = await pageSizePt(tab, page);
  if (!size) return;
  const ui = useUIStore.getState();
  const store = useDocumentStore.getState();
  const margin = ui.marginsEnabled ? PAGE_MARGIN : 0;

  if (source === "elements" && clip) {
    const placed = placePastedElements(clip, {
      targetPage: page,
      pageW: size.w,
      pageH: size.h,
      marginsEnabled: ui.marginsEnabled,
      pasteIndex: clip.pasteCount,
    });
    clip.pasteCount += 1;
    const ids: Array<{ kind: ElementRef["kind"]; id: string }> = [];
    for (const el of placed) {
      if (el.kind === "text") ids.push({ kind: "text", id: store.addPendingTextEdit(tab.id, stripIdentity(el.edit)) });
      else if (el.kind === "image") ids.push({ kind: "image", id: store.addPendingImageEdit(tab.id, { ...stripIdentity(el.edit), bytes: el.edit.bytes.slice() }) });
      else ids.push({ kind: "shape", id: store.addPendingShapeEdit(tab.id, stripIdentity(el.edit) as Parameters<typeof store.addPendingShapeEdit>[1]) });
    }
    const sel = pastedSelection(ids);
    useUIStore.getState().setGroupSelection(sel.primary, sel.group);
    return;
  }

  const origin = pasteOrigin(page, tab.zoom, size.h, size.w);

  if (source === "system-image" && imageFile) {
    const decoded = await imageToPngOrJpeg(imageFile);
    if (!decoded || decoded.w <= 0 || decoded.h <= 0) return;
    const maxW = Math.min(240, size.w * 0.5);
    const w = Math.min(maxW, decoded.w);
    const h = w * (decoded.h / decoded.w);
    const xPt = Math.max(margin, Math.min(size.w - margin - w, origin.x - w / 2));
    const yPt = Math.max(margin, Math.min(size.h - margin - h, origin.y - h / 2));
    const id = store.addPendingImageEdit(tab.id, { page, xPt, yPt, widthPt: w, heightPt: h, bytes: decoded.bytes, mime: decoded.mime });
    useUIStore.getState().setGroupSelection({ kind: "image", id }, []);
    return;
  }

  if (source === "system-text") {
    const rightBound = size.w - margin;
    const xPt = Math.max(margin, Math.min(rightBound - MIN_WRAP_TEXT_WIDTH_PT, origin.x - MIN_WRAP_TEXT_WIDTH_PT));
    const yPt = Math.max(margin + PASTE_TEXT_SIZE, Math.min(size.h - margin - PASTE_TEXT_SIZE, origin.y));
    const widthPt = Math.max(MIN_WRAP_TEXT_WIDTH_PT, rightBound - xPt);
    const id = store.addPendingTextEdit(tab.id, { page, xPt, yPt, size: PASTE_TEXT_SIZE, text: text.trim(), widthPt });
    useUIStore.getState().setGroupSelection({ kind: "text", id }, []);
  }
}

/** Install once at app mount; returns the uninstaller. */
export function installElementClipboard(): () => void {
  const onCopy = (e: ClipboardEvent) => handleCopy(e, false);
  const onCut = (e: ClipboardEvent) => handleCopy(e, true);
  const onPaste = (e: ClipboardEvent) => {
    void handlePaste(e);
  };
  document.addEventListener("copy", onCopy);
  document.addEventListener("cut", onCut);
  document.addEventListener("paste", onPaste);
  return () => {
    document.removeEventListener("copy", onCopy);
    document.removeEventListener("cut", onCut);
    document.removeEventListener("paste", onPaste);
  };
}
