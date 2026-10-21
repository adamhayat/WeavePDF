import { create } from "zustand";
import { activeAfterClose, moveId } from "../lib/tab-order";
import type { DiskStamp } from "../lib/open-target";
import { pdfjsLib, type PDFDocumentProxy } from "../lib/pdfjs";
// V1.0064: read marginsEnabled to compute the effective baked widthPt for
// each Add Text overlay during commit. Cross-store import is intentional —
// commit decisions depend on the user's current toggle state.
import { useUIStore } from "./ui";
import { computeLayerMove, effectiveZ, type LayerOp } from "../lib/layers";
import { bakeLayers } from "../lib/bake-layers";
import { isNoopPatch } from "../lib/noop-patch";
import { marksAfterSave, pickStep, pushMark, pushStep, type UndoMark } from "../lib/undo-order";
// Lazy-loaded so the pdf-lib chunk (~425 KB) doesn't pull at boot. The store
// itself is created at module-load (which Vite imports eagerly), but every
// pdf-ops function is only invoked from a commit* action that runs after
// user interaction. The chunk parses on first commit, off the cold-launch
// critical path.
const loadPdfOps = () => import("../lib/pdf-ops");

type RGB = { r: number; g: number; b: number };
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
const MIN_WRAP_TEXT_WIDTH_PT = 120;

// Undo/redo snapshots hold a full copy of the document bytes. Keep at most 20
// levels (the historical cap) AND, for very large documents, drop the oldest
// snapshots once the retained bytes pass ~300 MB — otherwise a long edit
// session on a big scanned PDF can pin gigabytes of Uint8Arrays in the single
// renderer process and OOM it. The most-recent snapshot is always kept, so the
// next undo/redo step still works; deep history just degrades gracefully on
// huge files.
const MAX_HISTORY_ENTRIES = 20;
const MAX_HISTORY_BYTES = 300 * 1024 * 1024;
function capHistory(snapshots: Uint8Array[]): Uint8Array[] {
  let kept = snapshots.slice(-MAX_HISTORY_ENTRIES);
  let total = kept.reduce((n, b) => n + b.byteLength, 0);
  while (kept.length > 1 && total > MAX_HISTORY_BYTES) {
    total -= kept[0].byteLength;
    kept = kept.slice(1);
  }
  return kept;
}

/**
 * A text annotation that lives as a draggable DOM overlay until the user
 * saves/exports/prints — at which point it gets baked into the PDF bytes.
 * Positions are in PDF user-space points (bottom-left origin).
 *
 * `whiteout` is present when this edit REPLACES existing text on the page:
 * the old region gets covered in white before the new text is drawn.
 */
export type PendingTextEdit = {
  id: string;
  createdAt?: number;
  /** V1.0125: stacking order shared by the viewer and the bake — see
   *  lib/layers.ts. Defaults to `createdAt` (newest on top). */
  z?: number;
  page: number;
  xPt: number;
  yPt: number;
  size: number;
  text: string;
  whiteout?: { x: number; y: number; width: number; height: number };
  /** Optional pdf-lib StandardFont name — propagated from the Edit-Text
   * click handler when it can detect the original font family. */
  fontName?: string;
  /** V1.0057: bold / italic toggles. When committed, `matchStandardFont`
   * picks the right variant of the chosen family (e.g. Helvetica →
   * Helvetica-Bold / -Oblique / -BoldOblique). */
  bold?: boolean;
  italic?: boolean;
  /** V1.0062: if set, the text wraps at this width (points). Rendered with
   * CSS `white-space: pre-wrap` + `word-break: break-word`; committed via
   * `drawWrappedText` which does pdf-lib `widthOfTextAtSize`-based line
   * breaking. Undefined = legacy single-line behavior (used today by the
   * Edit Text replace flow so existing single-line edits stay tight). */
  widthPt?: number;
  /** V1.0069: paragraph-level alignment within the wrap width. Mirrors
   * CSS `text-align` on the live overlay and the per-line drawText
   * offset at commit. Default left. Only meaningful for `widthPt`-bearing
   * text — single-line Edit Text replacements ignore it. */
  align?: "left" | "center" | "right" | "justify";
  /** V1.0134: text colour (0..1 RGB). Undefined = black. Set by the colour
   *  control in the text bar and by Add link (link blue). Rendered on screen,
   *  baked at save, round-tripped through the WeavePDFEdits metadata. */
  color?: RGB;
  /** V1.0126: set when this box REPLACES a fillable form field's value
   *  (Edit Text / "Aa ▸" on a field). The save clears that field, otherwise
   *  every other viewer draws the field's old value ON TOP of this text
   *  (form fields always paint above page content). */
  formField?: string;
};

/**
 * A pasted or placed image that lives as a draggable/resizable overlay
 * until commit. (x, y) is the bottom-left anchor in PDF points.
 */
export type PendingImageEdit = {
  id: string;
  createdAt?: number;
  /** V1.0125: stacking order — see lib/layers.ts. */
  z?: number;
  page: number;
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg";
  /** V1.0090: per-image format options. The research agent's must-haves
   *  (rotate / flip / opacity / replace) live here. `rotation` is in
   *  degrees CCW; `opacity` is 0..1; `flipH` / `flipV` mirror around
   *  the image's center. All optional / default 0 / 1 / false so
   *  existing edits stay unchanged. Applied at both render time
   *  (CSS transform + opacity in PendingImageLayer) and bake time
   *  (`placeImage` opts in pdf-ops). */
  rotation?: number;
  opacity?: number;
  flipH?: boolean;
  flipV?: boolean;
  /** V1.0091: layer-style attributes — border and drop shadow. Both
   *  are baked at commit (placeImage) and round-tripped via the v:2
   *  metadata schema so save+reopen restores them exactly. Border
   *  width is in PDF points (0 = no border); shadow offset/blur in
   *  points; shadow opacity is 0..1. */
  border?: { widthPt: number; color: { r: number; g: number; b: number } };
  dropShadow?: {
    offsetXPt: number;
    offsetYPt: number;
    blurPt: number;
    opacity: number;
    color: { r: number; g: number; b: number };
  };
};

/**
 * Every drag-to-draw tool (shapes, highlight, whiteout, redact, freehand)
 * plus sticky-note become pending overlays that can be moved, resized, and
 * deleted before commit. Keeps the UX consistent with pasted text/images.
 *
 * All coordinates are PDF user-space (points, bottom-left origin).
 */
/** V1.0057: one entry in `pendingRedoStack`. Tagged-union over the three
 *  pending-edit kinds so redo can splice the right edit back into the
 *  matching `pending*Edits` array. */
export type PendingRedoEntry =
  | { kind: "text"; edit: PendingTextEdit }
  | { kind: "image"; edit: PendingImageEdit }
  | { kind: "shape"; edit: PendingShapeEdit };

export type PendingShapeEdit = { id: string; createdAt?: number; /** V1.0125: stacking order — see lib/layers.ts. */ z?: number; page: number } & (
  | { kind: "rect"; xPt: number; yPt: number; widthPt: number; heightPt: number; color: RGB; thickness: number }
  | { kind: "ellipse"; xPt: number; yPt: number; widthPt: number; heightPt: number; color: RGB; thickness: number }
  | { kind: "line"; fromX: number; fromY: number; toX: number; toY: number; color: RGB; thickness: number }
  | { kind: "arrow"; fromX: number; fromY: number; toX: number; toY: number; color: RGB; thickness: number }
  | { kind: "freehand"; points: Array<{ x: number; y: number }>; color: RGB; thickness: number }
  | { kind: "highlight"; xPt: number; yPt: number; widthPt: number; heightPt: number }
  | { kind: "whiteout"; xPt: number; yPt: number; widthPt: number; heightPt: number }
  | { kind: "redact"; xPt: number; yPt: number; widthPt: number; heightPt: number }
  | { kind: "sticky"; xPt: number; yPt: number; text: string }
);

export type DocumentTab = {
  id: string;
  name: string;
  path: string | null;
  // False for files opened from disk so Cmd+S routes to Save As and never
  // overwrites the user's original. True only after the user explicitly
  // chooses an output path inside WeavePDF.
  saveInPlace: boolean;
  // Stable key for autosaved draft slots. Equals `path` for tabs opened from
  // disk; for path-less tabs (combined PDFs, image/DOCX imports, restored
  // virtual drafts) it's a synthetic `weavepdf-virtual://<uuid>` URI. Always
  // present so every tab the user touches gets autosaved.
  draftKey: string;
  sizeBytes: number;
  /** V1.0133: mtime + size of the file at `path` as this tab last read or
   *  wrote it. A Finder open of that path reuses this tab only while the
   *  file still carries this stamp; otherwise the tab is stale and the file
   *  is loaded fresh. null for path-less tabs and unknown vintages. */
  disk: DiskStamp | null;
  bytes: Uint8Array | null;
  pdf: PDFDocumentProxy | null;
  numPages: number;
  currentPage: number;
  zoom: number;
  dirty: boolean;
  selectedPages: Set<number>; // 1-based
  pendingTextEdits: PendingTextEdit[];
  pendingImageEdits: PendingImageEdit[];
  pendingShapeEdits: PendingShapeEdit[];
  history: Uint8Array[]; // previous bytes, most recent last
  redoStack: Uint8Array[]; // undone bytes, most recent last
  /** V1.0057: pending overlays removed by undo go here in LIFO order so
   *  redo can restore them. Pre-V1.0057 undo just deleted pending edits
   *  with no record, making them unrecoverable — the "elements disappear
   *  and I can't get them back" bug. Cleared by a new commit/edit (same
   *  branch-invalidation rule as `redoStack`). Capped at 20. */
  pendingRedoStack: PendingRedoEntry[];
  /** V1.0070: snapshot-based undo stack for IN-PLACE pending-edit
   *  changes (size / position / bold / italic / align / text content /
   *  resize). Pre-V1.0070 these mutations were not undoable — a single
   *  ⌘Z deleted the entire edit instead of stepping back one property
   *  change. Each snapshot captures the full pending-edits state at a
   *  point in time. Capped at 30 so a long editing session doesn't bloat
   *  memory. Cleared when bytes are committed (the macro history takes
   *  over from there). */
  pendingHistory: PendingSnapshot[];
  pendingFuture: PendingSnapshot[];
  /** V1.0126: ONE undo timeline across `history` (bytes) and
   *  `pendingHistory` (elements) — see lib/undo-order.ts. */
  undoOrder: UndoMark[];
  redoOrder: UndoMark[];
  /** V1.0126: `undoOrder.length` at the last open/save, or null once that
   *  state can no longer be reached by undo/redo. Undo/redo use it to know
   *  whether the tab is back to exactly what's on disk. */
  cleanDepth: number | null;
  // Monotonic counter incremented whenever the PDF bytes change — components
  // key renders off this so stale canvas state doesn't leak across edits.
  version: number;
  /** V1.0111: true while this tab holds a PKCS#7-signed PDF whose ByteRange is
   *  still intact. Set only by the digital-sign action (via `applyEdit`'s
   *  `signed` option); cleared — with a warning toast — by any later edit,
   *  commit, undo, or redo, because re-saving through pdf-lib rewrites the xref
   *  and silently invalidates the signature. Stops a document looking signed
   *  when it no longer validates. */
  signed: boolean;
};

/** V1.0070: snapshot of all pending-edit arrays at a moment in time.
 *  Stored in `pendingHistory` (undo) / `pendingFuture` (redo). Cheap
 *  because pending edits are small structs; the heavy image bytes are
 *  shared by reference across snapshots. */
export type PendingSnapshot = {
  text: PendingTextEdit[];
  image: PendingImageEdit[];
  shape: PendingShapeEdit[];
};

type AddTabInput = {
  name: string;
  path: string | null;
  saveInPlace?: boolean;
  /** Optional pre-existing draftKey — used when restoring a virtual draft so
   *  autosave keeps writing to the same slot instead of forking. */
  draftKey?: string;
  sizeBytes: number;
  /** V1.0133: on-disk stamp of the bytes being loaded (real paths only). */
  disk?: DiskStamp | null;
  bytes: Uint8Array;
  pdf: PDFDocumentProxy;
  numPages: number;
};

type DocumentStore = {
  tabs: DocumentTab[];
  activeTabId: string | null;

  activeTab: () => DocumentTab | null;

  addTab: (init: AddTabInput) => string;
  /** Add an empty placeholder tab that renders the DropZone — like Chrome's
   *  ⌘T new-empty-tab. Bytes/pdf are null; opening a file with this tab
   *  active replaces it so the user doesn't end up with a phantom empty tab. */
  addBlankTab: () => string;
  closeTab: (id: string) => void;
  closeOtherTabs: (keepId: string) => void;
  closeTabsToRight: (id: string) => void;
  /** V1.0129: move a tab to a new position in the strip. */
  moveTab: (id: string, toIndex: number) => void;
  setActiveTab: (id: string) => void;
  setCurrentPage: (id: string, page: number) => void;
  setZoom: (id: string, zoom: number) => void;
  renameTab: (id: string, name: string) => void;

  // Selection
  selectPage: (id: string, page: number, mode: "set" | "toggle" | "range") => void;
  selectAllPages: (id: string) => void;
  clearSelection: (id: string) => void;

  // Edits
  applyEdit: (
    id: string,
    newBytes: Uint8Array,
    opts?: {
      newCurrentPage?: number;
      signed?: boolean;
      /** V1.0126: for page-ORDER operations (delete / reorder / duplicate /
       *  insert): where each old page's editable elements go. Return [] to
       *  drop them (page deleted), several pages to copy them (duplicate).
       *  Without it, elements stayed on their old page NUMBER, so deleting
       *  page 1 moved page 2's elements onto page 3's content. */
      remapPages?: (oldPage: number) => number[];
    },
  ) => Promise<void>;
  undo: (id: string) => Promise<void>;
  redo: (id: string) => Promise<void>;
  /** `savedState`: the bytes + element arrays the written file was built
   *  from. If the tab changed since (an edit during the save), it stays
   *  unsaved. */
  markClean: (
    id: string,
    pathIfSaved: string,
    savedState?: { bytes: Uint8Array | null; text: PendingTextEdit[]; image: PendingImageEdit[]; shape: PendingShapeEdit[] },
    /** V1.0133: the stamp of the file just written, so a Finder reopen of
     *  that path knows this tab shows the current file. */
    disk?: DiskStamp | null,
  ) => void;
  /** V1.0070: snapshot the current pending-edit state into the undo
   *  stack. Call at the START of any user-initiated mutation
   *  (drag start, property toggle, text content commit, alignment
   *  change). Idempotent for snapshots taken within ~250 ms — repeated
   *  rapid calls during one continuous gesture don't bloat history. */
  pushUndoStep: (id: string) => void;

  // Pending text edits (draggable overlays until committed)
  addPendingTextEdit: (id: string, edit: Omit<PendingTextEdit, "id">) => string;
  updatePendingTextEdit: (id: string, editId: string, patch: Partial<PendingTextEdit>) => void;
  removePendingTextEdit: (id: string, editId: string) => void;
  commitAllPendingTextEdits: (id: string) => Promise<void>;
  /** V1.0072: restore text overlays from a WeavePDF-saved file's
   *  metadata. Adds the supplied edits to `pendingTextEdits` WITHOUT
   *  triggering an undo snapshot or marking the tab dirty — the edits
   *  were already persisted to the file we just opened. Each edit's
   *  `whiteout` field covers its previously-baked content so the
   *  restored overlay visually replaces (not stacks on top of) it. */
  restorePendingTextEdits: (id: string, edits: Omit<PendingTextEdit, "id">[]) => void;

  // Pending image edits (draggable/resizable overlays until committed)
  addPendingImageEdit: (id: string, edit: Omit<PendingImageEdit, "id">) => string;
  updatePendingImageEdit: (id: string, editId: string, patch: Partial<PendingImageEdit>) => void;
  removePendingImageEdit: (id: string, editId: string) => void;
  commitAllPendingImageEdits: (id: string) => Promise<void>;
  restorePendingImageEdits: (id: string, edits: Omit<PendingImageEdit, "id">[]) => void;

  // Pending shape edits (rect/ellipse/line/arrow/freehand/highlight/whiteout/redact/sticky)
  // DistributiveOmit preserves the discriminated union across Omit — without
  // it, Omit<PendingShapeEdit, "id"> collapses to the common fields only.
  addPendingShapeEdit: (id: string, edit: DistributiveOmit<PendingShapeEdit, "id">) => string;
  updatePendingShapeEdit: (id: string, editId: string, patch: Partial<PendingShapeEdit>) => void;
  removePendingShapeEdit: (id: string, editId: string) => void;
  commitAllPendingShapeEdits: (id: string) => Promise<void>;
  restorePendingShapeEdits: (id: string, edits: DistributiveOmit<PendingShapeEdit, "id">[]) => void;

  /** V1.0126: flatten the editable elements permanently into the page and
   *  clear them (crop / digital signature / find-and-replace only). */
  commitAllPending: (id: string, pages?: number[]) => Promise<void>;
  /** V1.0126: the bytes Save / Export / Print should write — clean page +
   *  every editable element baked in their layer order, with the element
   *  layer tagged + described so a reopen gets them back as overlays. Does
   *  NOT modify the tab. Returns the plain bytes when nothing is pending. */
  renderOutput: (id: string, opts?: { flat?: boolean }) => Promise<Uint8Array | null>;
  /** V1.0126: call BEFORE a page-GEOMETRY operation (rotate, crop, n-up,
   *  booklet, split, fit, auto-crop). If any editable element sits on one of
   *  `pages` (default: any page), flatten them into the page first so they
   *  turn / scale / move WITH it — elements are positioned in the page's
   *  display space, which these operations redefine. Returns the bytes the
   *  operation should start from. */
  prepareGeometryEdit: (id: string, pages?: number[]) => Promise<Uint8Array | null>;

  /** V1.0125: Arrange — change an element's place in the page's stacking
   *  order (Bring to Front / Forward, Send Backward / to Back). The same
   *  order drives the viewer AND the saved file (lib/layers.ts). One undo
   *  step. No-op when the element is already at that end. */
  moveLayer: (tabId: string, editId: string, op: LayerOp) => void;

  /** V1.0057: snap a pending text or image to the page's print margins or
   *  center. Async because page width/height come from `tab.pdf.getPage(n)`.
   *  Shape alignment is deferred — shapes have many subkinds (rect, line,
   *  freehand) each with different geometry; needs a per-kind bbox helper.
   *
   *  V1.0081: `bboxOverride` lets the caller supply the element's actual
   *  rendered extent in PDF points. For wrap-mode text the stored
   *  `widthPt` is the wrap BOUNDARY, often wider than the rendered text
   *  itself — using it as the alignment box makes "center horizontally"
   *  snap to the empty-frame center, not the visible text center. The
   *  PendingTextLayer measures `wrapperRef`'s bounding box and passes
   *  the inner content bounds; we use those when provided. */
  alignPendingElement: (
    tabId: string,
    kind: "text" | "image",
    editId: string,
    alignment: PendingAlignment,
    bboxOverride?: { wPt: number; hPt: number },
  ) => Promise<void>;
};

/** V1.0057: target slot for `alignPendingElement`. "left"/"right"/"top"/
 *  "bottom" snap to a 36pt (½") margin from the named edge; "center-h" and
 *  "center-v" center the element across the page on the matching axis. */
export type PendingAlignment =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "center-h"
  | "center-v";

async function loadPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return pdfjsLib.getDocument({ data: bytes.slice() }).promise;
}

// Per-tab in-flight guard. A second edit/undo for the same tab is dropped
// while the first is still running — prevents history corruption when the
// user hammers ⌘Z or fires two fast edits that both read the same state.
const inFlight = new Set<string>();
let pendingEditSeq = 0;

/** V1.0123: wait for a tab's in-flight edit to finish. `applyEdit` and
 *  `commitAllPending` both SILENTLY return when the tab is busy, so a save
 *  landing on top of a still-running edit (a form-field commit, say) would
 *  skip the bake, write the pre-edit bytes and still toast "Saved.".
 *  Callers that must not be skipped await this first. Returns false if the
 *  edit is still running after `timeoutMs` so the caller can refuse rather
 *  than write stale bytes. */
/** V1.0123: characters the last text bake had to substitute (see
 *  `sanitizeStandardFontText`). Read-and-clear, so the SAVE can report them in
 *  its own toast — toasting from inside the bake loses the message, because
 *  the toast is single-slot and "Saved." lands moments later. */
let lastUnsupportedChars: string[] = [];

export function takeLastUnsupportedChars(): string[] {
  const out = lastUnsupportedChars;
  lastUnsupportedChars = [];
  return out;
}

export async function waitForTabIdle(id: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (inFlight.has(id)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

function nextPendingEditOrder(): number {
  pendingEditSeq += 1;
  return pendingEditSeq;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + chunk, bytes.length))),
    );
  }
  return btoa(binary);
}

function shapeForMetadata(
  edit: PendingShapeEdit,
): import("../lib/pdf-ops").WeavePdfShapeEdit {
  const { id: _id, createdAt: _createdAt, z: _z, ...rest } = edit;
  void _id;
  void _createdAt;
  void _z;
  return { ...rest, z: effectiveZ(edit) } as import("../lib/pdf-ops").WeavePdfShapeEdit;
}

/**
 * Bump the global pendingEditSeq counter so it sits ABOVE every value in the
 * argument list. Called by the draft-restore path so newly-created edits
 * after a restore get higher createdAt numbers than the restored ones —
 * keeps undo order correct.
 *
 * Without this, a fresh-process pendingEditSeq starts at 0 and a brand-new
 * edit gets createdAt=1, sorting it BEFORE every restored edit (which carry
 * createdAt values from the previous session, e.g. 15, 23, 47). ⌘Z would
 * then peel off a restored edit instead of the new one.
 */
export function rebasePendingEditSeq(...values: Array<number | undefined>): void {
  const max = values.reduce<number>((acc, v) => (typeof v === "number" && v > acc ? v : acc), 0);
  if (max > pendingEditSeq) pendingEditSeq = max;
}

function hasPendingEdits(tab: DocumentTab): boolean {
  return (
    tab.pendingTextEdits.length > 0 ||
    tab.pendingImageEdits.length > 0 ||
    tab.pendingShapeEdits.length > 0
  );
}


/** V1.0126: undoOrder + cleanDepth after recording one more step. */
function stepFields(t: DocumentTab, mark: UndoMark): { undoOrder: UndoMark[]; cleanDepth: number | null } {
  const r = pushStep(t.undoOrder, t.cleanDepth, mark);
  return { undoOrder: r.order, cleanDepth: r.cleanDepth };
}

/** V1.0126: move every editable element with its page after a page-order
 *  operation. Elements on a deleted page go; a duplicated page's elements are
 *  copied (fresh ids, on top of that page). */
function remapPendingPages(
  t: DocumentTab,
  remap: (oldPage: number) => number[],
): { text: PendingTextEdit[]; image: PendingImageEdit[]; shape: PendingShapeEdit[] } {
  const move = <T extends { id: string; page: number; z?: number; createdAt?: number }>(list: T[]): T[] =>
    list.flatMap((e) =>
      remap(e.page).map((page, i) => {
        if (i === 0) return { ...e, page };
        const seq = nextPendingEditOrder();
        return { ...e, page, id: crypto.randomUUID(), createdAt: seq, z: seq };
      }),
    );
  return { text: move(t.pendingTextEdits), image: move(t.pendingImageEdits), shape: move(t.pendingShapeEdits) };
}


/** V1.0126: bake a tab's editable elements onto its clean page bytes.
 *  `editable: true` (Save/Export/Print) also tags the baked streams and writes
 *  the element metadata so a reopen peels them back off as overlays;
 *  `editable: false` (flatten) writes plain bytes. A redaction rasterises the
 *  page, which can't be peeled back, so a document with a pending redact is
 *  always written flat — it then reopens exactly as it looks, never doubled. */
async function buildOutputBytes(
  tab: DocumentTab,
  opts: { editable: boolean; pages?: number[] },
): Promise<{ bytes: Uint8Array; editable: boolean; baked: Set<string> }> {
  const base = tab.bytes!;
  // Reset first, so a later save never reports characters from an earlier
  // print/export bake.
  lastUnsupportedChars = [];
  if (!hasPendingEdits(tab)) return { bytes: base, editable: false, baked: new Set() };
  const ops = await loadPdfOps();

  // V1.0123: characters no PDF standard font can draw are substituted at
  // bake time (they used to abort the entire save). Record them for the
  // SAVE's toast.
  lastUnsupportedChars = [
    ...new Set(
      [...tab.pendingTextEdits, ...tab.pendingShapeEdits.filter((s) => s.kind === "sticky")]
        .flatMap((e) => ops.findUnsupportedStandardFontChars((e as { text?: string }).text ?? "")),
    ),
  ];

  const { PDFDocument } = await import("pdf-lib");
  const probe = await PDFDocument.load(base, { ignoreEncryption: true });
  // V1.0126: only elements on pages that exist (an element stranded past
  // the last page used to make every save throw) and, for a partial flatten,
  // only the requested pages.
  const pageCount = probe.getPageCount();
  const keep = (e: { page: number }) =>
    e.page >= 1 && e.page <= pageCount && (!opts.pages || opts.pages.includes(e.page));
  const textEdits = tab.pendingTextEdits.filter(keep).sort((a, b) => a.page - b.page);
  const imageEdits = tab.pendingImageEdits.filter(keep).sort((a, b) => a.page - b.page);
  const shapeEdits = tab.pendingShapeEdits.filter(keep).sort((a, b) => a.page - b.page);
  const bakedIds = new Set([...textEdits, ...imageEdits, ...shapeEdits].map((e) => e.id));
  // V1.0126: blank the form fields these text boxes replace, BEFORE baking, so
  // the tag diff below is taken against the same starting page.
  const replacedFields = [...new Set(textEdits.map((e) => e.formField).filter((n): n is string => !!n))];
  const startBytes = replacedFields.length > 0
    ? await ops.setFormFields(base, replacedFields.map((name) => ({ name, kind: "text" as const, value: "" })))
    : base;
  // V1.0125: ONE draw order, shared with the viewer (lib/layers.ts).
  const baked = await bakeLayers(ops, startBytes, { text: textEdits, image: imageEdits, shape: shapeEdits }, {
    pageWidth: (page) => probe.getPage(page - 1).getWidth(),
    marginsEnabled: useUIStore.getState().marginsEnabled,
  });
  if (!opts.editable || shapeEdits.some((e) => e.kind === "redact")) {
    return { bytes: baked.bytes, editable: false, baked: bakedIds };
  }
  const tagged = await ops.tagWeaveBakes(startBytes, baked.bytes);
  if (!tagged) return { bytes: baked.bytes, editable: false, baked: bakedIds };
  const bytes = await ops.embedWeaveMetadata(tagged, {
    version: 3,
    // V1.0126: page geometry at save time. If another tool rotates, crops or
    // re-pages the file, a reopen sees the mismatch and opens it flat instead
    // of restoring elements at stale positions.
    pages: probe.getPages().map((p) => {
      const b = p.getCropBox();
      return { rotate: p.getRotation().angle, box: [b.x, b.y, b.width, b.height] };
    }),
    textEdits: textEdits.map((e) => ({
      page: e.page,
      xPt: e.xPt,
      yPt: e.yPt,
      size: e.size,
      text: e.text,
      widthPt: e.widthPt,
      bold: e.bold,
      italic: e.italic,
      align: e.align,
      fontName: e.fontName,
      color: e.color,
      // V1.0126: the cover for ORIGINAL page content only (Edit Text). The
      // old v2 schema stored the bake's own bbox here because bakes stacked.
      whiteout: e.whiteout,
      formField: e.formField,
      z: effectiveZ(e),
    })),
    imageEdits: imageEdits.map((e) => ({
      page: e.page,
      xPt: e.xPt,
      yPt: e.yPt,
      widthPt: e.widthPt,
      heightPt: e.heightPt,
      mime: e.mime,
      dataBase64: bytesToBase64(e.bytes),
      z: effectiveZ(e),
      rotation: e.rotation,
      opacity: e.opacity,
      flipH: e.flipH,
      flipV: e.flipV,
      border: e.border,
      dropShadow: e.dropShadow,
    })),
    shapeEdits: shapeEdits.map(shapeForMetadata),
  });
  return { bytes, editable: true, baked: bakedIds };
}

export const useDocumentStore = create<DocumentStore>((set, get) => ({
  tabs: [],
  activeTabId: null,

  activeTab: () => {
    const { tabs, activeTabId } = get();
    return tabs.find((t) => t.id === activeTabId) ?? null;
  },

  addTab: (init) => {
    const id = crypto.randomUUID();
    const tab: DocumentTab = {
      id,
      name: init.name,
      path: init.path,
      // V1.0041: default `saveInPlace` to `true` whenever the tab has a real
      // disk path. Pre-V1.0041 we defaulted to `false`, which routed every
      // first ⌘S into a Save-As dialog — confusing UX (user expects ⌘S to
      // overwrite the file they just opened). Decrypted files, virtual tabs
      // (combine / image-import / new), and anywhere `init.path === null`
      // still get `false` so we never silently overwrite an encrypted
      // original or a synthesised in-memory document. Critical Rule #6 is
      // upheld: the path-less case still routes to Save-As.
      saveInPlace: init.saveInPlace ?? !!init.path,
      draftKey: init.draftKey ?? init.path ?? `weavepdf-virtual://${id}`,
      sizeBytes: init.sizeBytes,
      disk: init.path ? (init.disk ?? null) : null,
      bytes: init.bytes,
      pdf: init.pdf,
      numPages: init.numPages,
      currentPage: 1,
      zoom: 1,
      dirty: false,
      signed: false,
      selectedPages: new Set(),
      pendingTextEdits: [],
      pendingImageEdits: [],
      pendingShapeEdits: [],
      history: [],
      redoStack: [],
      pendingRedoStack: [],
      pendingHistory: [],
      pendingFuture: [],
      undoOrder: [],
      redoOrder: [],
      cleanDepth: 0,
      version: 0,
    };
    // If the previously-active tab was a blank one (created via ⌘T but never
    // populated), drop it now so the new file replaces it instead of leaving
    // a phantom "New Tab" sibling. Match the Chrome ⌘T-then-pick-a-URL flow.
    set((s) => {
      const prev = s.tabs.find((t) => t.id === s.activeTabId);
      const tabs = prev && prev.bytes === null && prev.pdf === null
        ? s.tabs.filter((t) => t.id !== prev.id)
        : s.tabs;
      return { tabs: [...tabs, tab], activeTabId: id };
    });
    return id;
  },

  addBlankTab: () => {
    const id = crypto.randomUUID();
    const tab: DocumentTab = {
      id,
      name: "New Tab",
      path: null,
      saveInPlace: false,
      draftKey: `weavepdf-virtual://${id}`,
      sizeBytes: 0,
      disk: null,
      bytes: null,
      pdf: null,
      numPages: 0,
      currentPage: 1,
      zoom: 1,
      dirty: false,
      signed: false,
      selectedPages: new Set(),
      pendingTextEdits: [],
      pendingImageEdits: [],
      pendingShapeEdits: [],
      history: [],
      redoStack: [],
      pendingRedoStack: [],
      pendingHistory: [],
      pendingFuture: [],
      undoOrder: [],
      redoOrder: [],
      cleanDepth: 0,
      version: 0,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
    return id;
  },

  closeTab: (id) => {
    set((s) => {
      const tab = s.tabs.find((t) => t.id === id);
      void tab?.pdf?.destroy();
      const nextTabs = s.tabs.filter((t) => t.id !== id);
      // V1.0131: closing the active tab selects the FIRST tab (was the last).
      return { tabs: nextTabs, activeTabId: activeAfterClose(nextTabs, s.activeTabId) };
    });
  },

  closeOtherTabs: (keepId) => {
    set((s) => {
      for (const t of s.tabs) if (t.id !== keepId) void t.pdf?.destroy();
      const keep = s.tabs.find((t) => t.id === keepId);
      return { tabs: keep ? [keep] : [], activeTabId: keep?.id ?? null };
    });
  },

  closeTabsToRight: (id) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return s;
      for (let i = idx + 1; i < s.tabs.length; i++) void s.tabs[i].pdf?.destroy();
      const nextTabs = s.tabs.slice(0, idx + 1);
      return { tabs: nextTabs, activeTabId: activeAfterClose(nextTabs, s.activeTabId) };
    });
  },

  moveTab: (id, toIndex) =>
    set((s) => {
      const next = moveId(s.tabs, id, toIndex);
      return next === s.tabs ? s : { tabs: next };
    }),

  setActiveTab: (id) => set({ activeTabId: id }),

  setCurrentPage: (id, page) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, currentPage: Math.max(1, Math.min(t.numPages, page)) } : t,
      ),
    })),

  setZoom: (id, zoom) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, zoom: Math.max(0.25, Math.min(5, zoom)) } : t,
      ),
    })),

  renameTab: (id, name) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, name } : t)) })),

  selectPage: (id, page, mode) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        const next = new Set(t.selectedPages);
        if (mode === "set") {
          next.clear();
          next.add(page);
        } else if (mode === "toggle") {
          if (next.has(page)) next.delete(page);
          else next.add(page);
        } else if (mode === "range") {
          // Range from currentPage to `page`.
          const anchor = t.currentPage;
          const lo = Math.min(anchor, page);
          const hi = Math.max(anchor, page);
          for (let p = lo; p <= hi; p++) next.add(p);
        }
        return { ...t, selectedPages: next, currentPage: page };
      }),
    })),

  selectAllPages: (id) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        const next = new Set<number>();
        for (let p = 1; p <= t.numPages; p++) next.add(p);
        return { ...t, selectedPages: next };
      }),
    })),

  clearSelection: (id) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, selectedPages: new Set() } : t)),
    })),

  applyEdit: async (id, newBytes, opts) => {
    if (inFlight.has(id)) return;
    inFlight.add(id);
    try {
      const current = get().tabs.find((t) => t.id === id);
      if (!current?.bytes) return;
      const prevBytes = current.bytes;
      const newPdf = await loadPdf(newBytes);
      // Destroy the old pdf.js document to free memory — do it after the new
      // one is ready so we never leave the tab without a live pdf proxy.
      void current.pdf?.destroy();
      // V1.0111: a digital signature survives only if the signed bytes are
      // written verbatim. `opts.signed` IS the signing edit; any other edit on
      // a signed tab re-serializes the PDF and breaks the ByteRange, so warn
      // and drop the signed flag instead of letting the file look signed.
      const nowSigned = opts?.signed === true;
      if (current.signed && !nowSigned) {
        useUIStore.getState().showToast(
          "That change invalidated the document's digital signature.",
          "warn",
        );
      }
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== id) return t;
          const nextHistory = [...t.history, prevBytes];
          const remap = opts?.remapPages;
          const moved = remap ? remapPendingPages(t, remap) : null;
          return {
            ...t,
            ...(moved
              ? {
                  pendingTextEdits: moved.text,
                  pendingImageEdits: moved.image,
                  pendingShapeEdits: moved.shape,
                  pendingHistory: [
                    ...t.pendingHistory,
                    { text: t.pendingTextEdits, image: t.pendingImageEdits, shape: t.pendingShapeEdits },
                  ].slice(-30),
                  pendingFuture: [],
                }
              : {}),
            ...stepFields(t, moved ? "both" : "bytes"),
            redoOrder: [],
            bytes: newBytes,
            pdf: newPdf,
            numPages: newPdf.numPages,
            sizeBytes: newBytes.byteLength,
            currentPage: Math.min(
              opts?.newCurrentPage ?? t.currentPage,
              newPdf.numPages,
            ),
            selectedPages: new Set(),
            history: capHistory(nextHistory),
            // A new edit invalidates the redo stack — you can't "re-do" what
            // was undone once you've gone a different direction.
            redoStack: [],
            pendingRedoStack: [],
            dirty: true,
            signed: nowSigned,
            version: t.version + 1,
          };
        }),
      }));
    } catch (err) {
      // A primitive can hand back bytes pdf.js refuses to load (or text the
      // font can't encode). Surface it quietly instead of leaving the edit a
      // silent no-op; the tab stays on its last good state.
      console.error("applyEdit failed", err);
      useUIStore.getState().showToast("Couldn't apply that change.", "warn");
    } finally {
      inFlight.delete(id);
    }
  },

  pushUndoStep: (id) => {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        // Idempotent: skip if the previous snapshot is reference-equal
        // to the current state (no mutations have happened since).
        const last = t.pendingHistory[t.pendingHistory.length - 1];
        if (
          last &&
          last.text === t.pendingTextEdits &&
          last.image === t.pendingImageEdits &&
          last.shape === t.pendingShapeEdits
        ) {
          // V1.0126: no new snapshot needed, but this IS a new action — the
          // redo future must still go, or ⇧⌘Z replays a stale page change.
          return { ...t, pendingFuture: [], redoStack: [], redoOrder: [] };
        }
        const snap: PendingSnapshot = {
          text: t.pendingTextEdits,
          image: t.pendingImageEdits,
          shape: t.pendingShapeEdits,
        };
        return {
          ...t,
          pendingHistory: [...t.pendingHistory, snap].slice(-30),
          // Any new step invalidates the redo future — element AND page.
          pendingFuture: [],
          redoStack: [],
          ...stepFields(t, "pending"),
          redoOrder: [],
        };
      }),
    }));
  },

  undo: async (id) => {
    if (inFlight.has(id)) return;
    // V1.0126: undo the most RECENT step, whichever kind it was (see
    // lib/undo-order.ts). Pre-V1.0126 element changes were always undone
    // before page changes, and with no element history left ⌘Z deleted the
    // newest element outright — so after reopening a saved file, ⌘Z deleted
    // your saved elements one by one.
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    const step = pickStep(tab.undoOrder, tab.pendingHistory.length > 0, tab.history.length > 0);
    if (!step) return;
    const doPending = step.mark !== "bytes";
    const doBytes = step.mark !== "pending";
    inFlight.add(id);
    try {
      let prevBytes: Uint8Array | null = null;
      let newPdf: PDFDocumentProxy | null = null;
      if (doBytes && tab.bytes) {
        prevBytes = tab.history[tab.history.length - 1];
        newPdf = await loadPdf(prevBytes);
        void tab.pdf?.destroy();
      }
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== id) return t;
          // Skipped stale marks mean we can't vouch that this equals the
          // saved state any more.
          const skipped = t.undoOrder.length - 1 > step.rest.length;
          const cleanDepth = skipped ? null : t.cleanDepth;
          let next: DocumentTab = {
            ...t,
            undoOrder: step.rest,
            redoOrder: pushMark(t.redoOrder, step.mark),
            cleanDepth,
            dirty: step.rest.length !== cleanDepth,
          };
          if (doPending) {
            const snap = t.pendingHistory[t.pendingHistory.length - 1];
            next = {
              ...next,
              pendingTextEdits: snap.text,
              pendingImageEdits: snap.image,
              pendingShapeEdits: snap.shape,
              pendingHistory: t.pendingHistory.slice(0, -1),
              pendingFuture: [
                ...t.pendingFuture,
                { text: t.pendingTextEdits, image: t.pendingImageEdits, shape: t.pendingShapeEdits },
              ].slice(-30),
            };
          }
          if (doBytes && prevBytes && newPdf && t.bytes) {
            next = {
              ...next,
              bytes: prevBytes,
              pdf: newPdf,
              numPages: newPdf.numPages,
              sizeBytes: prevBytes.byteLength,
              currentPage: Math.min(t.currentPage, newPdf.numPages),
              selectedPages: new Set(),
              history: t.history.slice(0, -1),
              redoStack: capHistory([...t.redoStack, t.bytes]),
              // Stepping through history can't be trusted to preserve a
              // valid signature — under-claim rather than show a broken one.
              signed: false,
              version: t.version + 1,
            };
          }
          return next;
        }),
      }));
    } catch (err) {
      console.error("undo failed", err);
      useUIStore.getState().showToast("Couldn't undo that change.", "warn");
    } finally {
      inFlight.delete(id);
    }
  },

  redo: async (id) => {
    if (inFlight.has(id)) return;
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    const step = pickStep(tab.redoOrder, tab.pendingFuture.length > 0, tab.redoStack.length > 0);
    if (!step) return;
    const doPending = step.mark !== "bytes";
    const doBytes = step.mark !== "pending";
    inFlight.add(id);
    try {
      let nextBytes: Uint8Array | null = null;
      let newPdf: PDFDocumentProxy | null = null;
      if (doBytes && tab.bytes) {
        nextBytes = tab.redoStack[tab.redoStack.length - 1];
        newPdf = await loadPdf(nextBytes);
        void tab.pdf?.destroy();
      }
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== id) return t;
          const pushed = pushStep(t.undoOrder, t.cleanDepth, step.mark);
          // A redo is not a new branch — don't let pushStep invalidate the
          // save point for being "below" it; only the cap shift applies.
          const skipped = t.redoOrder.length - 1 > step.rest.length;
          const cleanDepth = skipped
            ? null
            : t.cleanDepth === null
              ? null
              : t.cleanDepth - (t.undoOrder.length + 1 - pushed.order.length);
          const undoOrder = pushed.order;
          let next: DocumentTab = {
            ...t,
            undoOrder,
            redoOrder: step.rest,
            cleanDepth,
            dirty: undoOrder.length !== cleanDepth,
          };
          if (doPending) {
            const snap = t.pendingFuture[t.pendingFuture.length - 1];
            next = {
              ...next,
              pendingTextEdits: snap.text,
              pendingImageEdits: snap.image,
              pendingShapeEdits: snap.shape,
              pendingHistory: [
                ...t.pendingHistory,
                { text: t.pendingTextEdits, image: t.pendingImageEdits, shape: t.pendingShapeEdits },
              ].slice(-30),
              pendingFuture: t.pendingFuture.slice(0, -1),
            };
          }
          if (doBytes && nextBytes && newPdf && t.bytes) {
            next = {
              ...next,
              bytes: nextBytes,
              pdf: newPdf,
              numPages: newPdf.numPages,
              sizeBytes: nextBytes.byteLength,
              currentPage: Math.min(t.currentPage, newPdf.numPages),
              selectedPages: new Set(),
              history: capHistory([...t.history, t.bytes]),
              redoStack: t.redoStack.slice(0, -1),
              signed: false,
              version: t.version + 1,
            };
          }
          return next;
        }),
      }));
    } catch (err) {
      console.error("redo failed", err);
      useUIStore.getState().showToast("Couldn't redo that change.", "warn");
    } finally {
      inFlight.delete(id);
    }
  },

  markClean: (id, pathIfSaved, savedState, disk) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        // V1.0126: anything changed WHILE the save was being written (a drag,
        // typing) isn't in the file — keep the tab unsaved.
        const changedDuringSave =
          !!savedState &&
          (savedState.bytes !== t.bytes ||
            savedState.text !== t.pendingTextEdits ||
            savedState.image !== t.pendingImageEdits ||
            savedState.shape !== t.pendingShapeEdits);
        const kept = marksAfterSave(t.undoOrder);
        return {
              ...t,
              dirty: changedDuringSave,
              path: pathIfSaved,
              // V1.0133: what is on disk at `path` now. Unknown (older write
              // results) → null, which a later Finder open treats as stale
              // and refreshes rather than trusts.
              disk: disk ?? null,
              saveInPlace: true,
              name: pathIfSaved.split("/").pop() ?? t.name,
              // Re-key autosave to the saved path so subsequent autosaves
              // overwrite the canonical slot (and the old virtual slot is
              // cleared by the persistence hook).
              draftKey: pathIfSaved,
              // Establish the just-saved bytes as the new clean baseline.
              // Otherwise undoing immediately after Save could diverge from
              // the saved file while incorrectly looking clean.
              history: [],
              redoStack: [],
              pendingRedoStack: [],
              // V1.0126: page history is gone, so only element steps taken
              // since the last page change stay undoable (marksAfterSave);
              // redo is cleared; the save point is "here".
              undoOrder: kept,
              pendingHistory: kept.length > 0 ? t.pendingHistory.slice(-kept.length) : [],
              redoOrder: [],
              pendingFuture: [],
              cleanDepth: changedDuringSave ? null : kept.length,
            };
      }),
    })),

  addPendingTextEdit: (id, edit) => {
    // V1.0070: snapshot BEFORE adding so ⌘Z restores the pre-add state.
    get().pushUndoStep(id);
    const editId = crypto.randomUUID();
    const createdAt = nextPendingEditOrder();
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              pendingTextEdits: [...t.pendingTextEdits, { id: editId, createdAt, z: createdAt, ...edit }],
              // V1.0057: any new edit invalidates the pending-redo stack
              // (you took a different branch — the un-undone overlays are
              // no longer the next step forward).
              pendingRedoStack: [],
              pendingFuture: [],
              dirty: true,
            }
          : t,
      ),
    }));
    return editId;
  },

  updatePendingTextEdit: (id, editId, patch) => {
    // V1.0126: a patch that changes nothing must not mark the tab unsaved.
    // Committing a text box you only clicked into (or that ⌘S already
    // flushed) used to set dirty=true, so closing right after a save asked
    // "Save your changes?" for changes that didn't exist.
    const cur = get().tabs.find((t) => t.id === id)?.pendingTextEdits.find((e) => e.id === editId);
    if (!cur || isNoopPatch(cur as unknown as Record<string, unknown>, patch as Record<string, unknown>)) return;
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              dirty: true,
              pendingTextEdits: t.pendingTextEdits.map((e) =>
                e.id === editId ? { ...e, ...patch } : e,
              ),
              // V1.0070: any mutation invalidates the redo future.
              pendingFuture: [],
            }
          : t,
      ),
    }));
  },

  removePendingTextEdit: (id, editId) => {
    // V1.0070: snapshot BEFORE removing so ⌘Z restores the edit.
    get().pushUndoStep(id);
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        const pendingTextEdits = t.pendingTextEdits.filter((e) => e.id !== editId);
        // V1.0126: removing an element is a change. The old "back to its
        // loaded state" guess (no history, no elements) was wrong once
        // elements are restored from the file or survive a save — deleting
        // the last one showed the tab as saved while the file still had it.
        const stillDirty = true;
        return { ...t, pendingTextEdits, pendingFuture: [], dirty: stillDirty };
      }),
    }));
  },

  restorePendingTextEdits: (id, edits) => {
    // V1.0072: bulk insert without snapshotting / dirtying. Called from
    // the file-open flow when WeavePDF metadata is found in the file.
    if (edits.length === 0) return;
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        const stamped = edits.map((e) => ({
          ...e,
          id: crypto.randomUUID(),
          createdAt: nextPendingEditOrder(),
          z: e.z,
        }));
        return {
          ...t,
          pendingTextEdits: [...t.pendingTextEdits, ...stamped],
          // Clean: these were already saved to the file we just opened.
        };
      }),
    }));
  },

  restorePendingImageEdits: (id, edits) => {
    if (edits.length === 0) return;
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        const stamped = edits.map((e) => ({
          ...e,
          id: crypto.randomUUID(),
          createdAt: nextPendingEditOrder(),
          z: e.z,
        }));
        return {
          ...t,
          pendingImageEdits: [...t.pendingImageEdits, ...stamped],
        };
      }),
    }));
  },

  commitAllPendingTextEdits: async (id) => {
    if (inFlight.has(id)) return;
    inFlight.add(id);
    try {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab?.bytes || tab.pendingTextEdits.length === 0) return;
      let bytes: Uint8Array = tab.bytes;
      const {
        whiteoutRegion,
        drawText,
        drawWrappedText,
        embedWeaveMetadata,
        findUnsupportedStandardFontChars,
      } = await loadPdfOps();
      // V1.0123: PDF standard fonts are WinAnsi — arrows, emoji and non-Latin
      // scripts can't be drawn with them. They used to abort the entire save
      // ("Couldn't save: WinAnsi cannot encode …"); now they're substituted at
      // bake time, so say so instead of silently altering the user's words.
      const unsupported = [
        ...new Set(
          tab.pendingTextEdits.flatMap((e) => findUnsupportedStandardFontChars(e.text)),
        ),
      ];
      // Don't toast here: the save that triggered this bake shows "Saved."
      // milliseconds later, and the toast is single-slot — the warning would be
      // wiped before it could be read. Hand it to the caller instead, which
      // folds it into the one toast the user actually sees.
      lastUnsupportedChars = unsupported;
      const PAGE_MARGIN = 36;
      const marginsEnabled = useUIStore.getState().marginsEnabled;
      const { PDFDocument } = await import("pdf-lib");
      const probe = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const edits = [...tab.pendingTextEdits].sort((a, b) => a.page - b.page);
      // V1.0072: collect each edit's bake region as we go so we can
      // persist round-trip metadata after all the bakes finish. The
      // baked bbox becomes the next-open's `whiteout` field so the
      // restored editable overlay covers the baked text underneath.
      const persistedEdits: import("../lib/pdf-ops").WeavePdfTextEdit[] = [];
      for (const e of edits) {
        if (e.whiteout) {
          bytes = await whiteoutRegion(bytes, e.page, e.whiteout);
        }
        const pageW = probe.getPage(e.page - 1).getWidth();
        const rightBound = marginsEnabled ? pageW - PAGE_MARGIN : pageW;
        const maxAllowed = Math.max(36, rightBound - e.xPt);
        const minWrapWidth = e.whiteout != null
          ? 36
          : Math.min(MIN_WRAP_TEXT_WIDTH_PT, maxAllowed);
        const effectiveWidth = e.whiteout != null
          ? e.widthPt ?? null
          : e.widthPt != null
            ? Math.max(minWrapWidth, Math.min(e.widthPt, maxAllowed))
            : maxAllowed;
        let baked: import("../lib/pdf-ops").BakedBBox | null = null;
        if (effectiveWidth != null) {
          const r = await drawWrappedText(bytes, e.page, {
            x: e.xPt,
            y: e.yPt,
            widthPt: effectiveWidth,
            size: e.size,
            text: e.text,
            font: e.fontName as Parameters<typeof drawText>[2]["font"],
            bold: e.bold,
            italic: e.italic,
            align: e.align,
            color: e.color,
          });
          bytes = r.bytes;
          baked = r.bbox;
        } else {
          const r = await drawText(bytes, e.page, {
            x: e.xPt,
            y: e.yPt,
            size: e.size,
            text: e.text,
            font: e.fontName as Parameters<typeof drawText>[2]["font"],
            bold: e.bold,
            italic: e.italic,
            color: e.color,
          });
          bytes = r.bytes;
          baked = r.bbox;
        }
        if (baked) {
          persistedEdits.push({
            page: e.page,
            xPt: e.xPt,
            yPt: e.yPt,
            size: e.size,
            text: e.text,
            widthPt: e.widthPt,
            bold: e.bold,
            italic: e.italic,
            align: e.align,
            fontName: e.fontName,
            color: e.color,
            whiteout: baked,
          });
        }
      }
      // V1.0072: stash the round-trip payload in the PDF Info dict. On
      // next open WeavePDF will see it and restore each edit as a pending
      // overlay (with `whiteout` covering the previously-baked content).
      if (persistedEdits.length > 0) {
        bytes = await embedWeaveMetadata(bytes, {
          version: 2,
          textEdits: persistedEdits,
          imageEdits: [],
          shapeEdits: [],
        });
      }
      const newPdf = await loadPdf(bytes);
      const prevBytes = tab.bytes;
      void tab.pdf?.destroy();
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== id) return t;
          return {
            ...t,
            bytes,
            pdf: newPdf,
            numPages: newPdf.numPages,
            sizeBytes: bytes.byteLength,
            pendingTextEdits: [],
            history: capHistory([...t.history, prevBytes]),
            redoStack: [],
            pendingRedoStack: [],
            dirty: true,
            version: t.version + 1,
          };
        }),
      }));
    } finally {
      inFlight.delete(id);
    }
  },

  addPendingImageEdit: (id, edit) => {
    get().pushUndoStep(id);
    const editId = crypto.randomUUID();
    const createdAt = nextPendingEditOrder();
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              pendingImageEdits: [...t.pendingImageEdits, { id: editId, createdAt, z: createdAt, ...edit }],
              pendingRedoStack: [],
              pendingFuture: [],
              dirty: true,
            }
          : t,
      ),
    }));
    return editId;
  },

  updatePendingImageEdit: (id, editId, patch) => {
    // V1.0126: a patch that changes nothing must not mark the tab unsaved.
    // Committing a text box you only clicked into (or that ⌘S already
    // flushed) used to set dirty=true, so closing right after a save asked
    // "Save your changes?" for changes that didn't exist.
    const cur = get().tabs.find((t) => t.id === id)?.pendingImageEdits.find((e) => e.id === editId);
    if (!cur || isNoopPatch(cur as unknown as Record<string, unknown>, patch as Record<string, unknown>)) return;
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              // Crops replace the underlying bytes; drags/resizes change
              // geometry. Either way the tab is dirty.
              dirty: true,
              pendingImageEdits: t.pendingImageEdits.map((e) =>
                e.id === editId ? { ...e, ...patch } : e,
              ),
              pendingFuture: [],
            }
          : t,
      ),
    }));
  },

  removePendingImageEdit: (id, editId) => {
    get().pushUndoStep(id);
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        const pendingImageEdits = t.pendingImageEdits.filter((e) => e.id !== editId);
        // V1.0126: removing an element is a change (see removePendingTextEdit).
        const stillDirty = true;
        return { ...t, pendingImageEdits, pendingFuture: [], dirty: stillDirty };
      }),
    }));
  },

  addPendingShapeEdit: (id, edit) => {
    get().pushUndoStep(id);
    const editId = crypto.randomUUID();
    const createdAt = nextPendingEditOrder();
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              pendingShapeEdits: [...t.pendingShapeEdits, { id: editId, createdAt, z: createdAt, ...edit } as PendingShapeEdit],
              pendingRedoStack: [],
              pendingFuture: [],
              dirty: true,
            }
          : t,
      ),
    }));
    return editId;
  },

  updatePendingShapeEdit: (id, editId, patch) => {
    // V1.0126: a patch that changes nothing must not mark the tab unsaved.
    // Committing a text box you only clicked into (or that ⌘S already
    // flushed) used to set dirty=true, so closing right after a save asked
    // "Save your changes?" for changes that didn't exist.
    const cur = get().tabs.find((t) => t.id === id)?.pendingShapeEdits.find((e) => e.id === editId);
    if (!cur || isNoopPatch(cur as unknown as Record<string, unknown>, patch as Record<string, unknown>)) return;
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              dirty: true,
              pendingShapeEdits: t.pendingShapeEdits.map((e) =>
                e.id === editId ? ({ ...e, ...patch } as PendingShapeEdit) : e,
              ),
              pendingFuture: [],
            }
          : t,
      ),
    }));
  },

  removePendingShapeEdit: (id, editId) => {
    get().pushUndoStep(id);
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        const pendingShapeEdits = t.pendingShapeEdits.filter((e) => e.id !== editId);
        // V1.0126: removing an element is a change (see removePendingTextEdit).
        const stillDirty = true;
        return { ...t, pendingShapeEdits, pendingFuture: [], dirty: stillDirty };
      }),
    }));
  },

  restorePendingShapeEdits: (id, edits) => {
    if (edits.length === 0) return;
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        const stamped = edits.map((e) => ({
          ...e,
          id: crypto.randomUUID(),
          createdAt: nextPendingEditOrder(),
          z: e.z,
        })) as PendingShapeEdit[];
        return {
          ...t,
          pendingShapeEdits: [...t.pendingShapeEdits, ...stamped],
        };
      }),
    }));
  },

  commitAllPendingShapeEdits: async (id) => {
    if (inFlight.has(id)) return;
    inFlight.add(id);
    try {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab?.bytes || tab.pendingShapeEdits.length === 0) return;
      let bytes: Uint8Array = tab.bytes;
      const {
        drawRect,
        drawCircle,
        drawLine,
        drawArrow,
        drawPath,
        drawHighlight,
        whiteoutRegion,
        redactRegion,
        drawStickyNote,
      } = await loadPdfOps();
      const edits = [...tab.pendingShapeEdits].sort((a, b) => a.page - b.page);
      for (const e of edits) {
        switch (e.kind) {
          case "rect":
            bytes = await drawRect(bytes, e.page, { x: e.xPt, y: e.yPt, width: e.widthPt, height: e.heightPt }, { color: e.color, thickness: e.thickness });
            break;
          case "ellipse":
            bytes = await drawCircle(bytes, e.page, { x: e.xPt, y: e.yPt, width: e.widthPt, height: e.heightPt }, { color: e.color, thickness: e.thickness });
            break;
          case "line":
            bytes = await drawLine(bytes, e.page, { x: e.fromX, y: e.fromY }, { x: e.toX, y: e.toY }, { color: e.color, thickness: e.thickness });
            break;
          case "arrow":
            bytes = await drawArrow(bytes, e.page, { x: e.fromX, y: e.fromY }, { x: e.toX, y: e.toY }, { color: e.color, thickness: e.thickness });
            break;
          case "freehand":
            bytes = await drawPath(bytes, e.page, e.points, { color: e.color, thickness: e.thickness });
            break;
          case "highlight":
            bytes = await drawHighlight(bytes, e.page, { x: e.xPt, y: e.yPt, width: e.widthPt, height: e.heightPt });
            break;
          case "whiteout":
            bytes = await whiteoutRegion(bytes, e.page, { x: e.xPt, y: e.yPt, width: e.widthPt, height: e.heightPt });
            break;
          case "redact":
            bytes = await redactRegion(bytes, e.page, { x: e.xPt, y: e.yPt, width: e.widthPt, height: e.heightPt });
            break;
          case "sticky":
            bytes = await drawStickyNote(bytes, e.page, { x: e.xPt, y: e.yPt }, e.text);
            break;
        }
      }
      const newPdf = await loadPdf(bytes);
      const prevBytes = tab.bytes;
      void tab.pdf?.destroy();
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== id) return t;
          return {
            ...t,
            bytes,
            pdf: newPdf,
            numPages: newPdf.numPages,
            sizeBytes: bytes.byteLength,
            pendingShapeEdits: [],
            history: capHistory([...t.history, prevBytes]),
            redoStack: [],
            pendingRedoStack: [],
            dirty: true,
            version: t.version + 1,
          };
        }),
      }));
    } finally {
      inFlight.delete(id);
    }
  },

  commitAllPendingImageEdits: async (id) => {
    if (inFlight.has(id)) return;
    inFlight.add(id);
    try {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab?.bytes || tab.pendingImageEdits.length === 0) return;
      let bytes: Uint8Array = tab.bytes;
      const { placeImage, flipImageBytes } = await loadPdfOps();
      const edits = [...tab.pendingImageEdits].sort((a, b) => a.page - b.page);
      for (const e of edits) {
        // V1.0090: apply flipH / flipV by pre-flipping the canvas pixels
        // (pdf-lib's drawImage has no sign-flip primitive). Rotation and
        // opacity go through placeImage's `opts` and bake via drawImage's
        // own rotate/opacity options.
        const imageBytes = (e.flipH || e.flipV)
          ? await flipImageBytes(e.bytes, e.mime, { flipH: e.flipH, flipV: e.flipV })
          : e.bytes;
        const imageMime: "image/png" | "image/jpeg" = (e.flipH || e.flipV) ? "image/png" : e.mime;
        bytes = await placeImage(bytes, e.page, imageBytes, imageMime, {
          x: e.xPt,
          y: e.yPt,
          width: e.widthPt,
          height: e.heightPt,
        }, {
          rotation: e.rotation,
          opacity: e.opacity,
          border: e.border,
          dropShadow: e.dropShadow,
        });
      }
      const newPdf = await loadPdf(bytes);
      const prevBytes = tab.bytes;
      void tab.pdf?.destroy();
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== id) return t;
          return {
            ...t,
            bytes,
            pdf: newPdf,
            numPages: newPdf.numPages,
            sizeBytes: bytes.byteLength,
            pendingImageEdits: [],
            history: capHistory([...t.history, prevBytes]),
            redoStack: [],
            pendingRedoStack: [],
            dirty: true,
            version: t.version + 1,
          };
        }),
      }));
    } finally {
      inFlight.delete(id);
    }
  },

  prepareGeometryEdit: async (id, pages) => {
    await waitForTabIdle(id);
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab?.bytes) return null;
    const hit = (e: { page: number }) => !pages || pages.includes(e.page);
    if (tab.pendingTextEdits.some(hit) || tab.pendingImageEdits.some(hit) || tab.pendingShapeEdits.some(hit)) {
      // Only the affected pages' elements — rotating page 5 must not make a
      // signature on page 1 permanent.
      await get().commitAllPending(id, pages);
    }
    return get().tabs.find((t) => t.id === id)?.bytes ?? null;
  },

  renderOutput: async (id, opts) => {
    // V1.0126: the bytes a Save / Export / Print writes. Built FRESH from the
    // tab's clean page bytes + its editable elements, every time, without
    // touching the tab. Pre-V1.0126 Save baked the elements INTO tab.bytes
    // and kept them as overlays too, so every later save drew them again on
    // top: deleting or moving an element left its old copy burned into the
    // page, the file grew each save (Adam's form: 406 → 922 content
    // streams), and merely opening Print Preview marked the tab unsaved.
    await waitForTabIdle(id);
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab?.bytes) return null;
    // `flat`: page extracts / merges / print — the editable-element metadata
    // describes the WHOLE document's page numbers, so it must not travel
    // into a file with different pages.
    // V1.0126 (was in the old save path): baking re-serialises the PDF, which
    // breaks a digital signature. Say so and stop claiming it's signed.
    if (tab.signed && hasPendingEdits(tab)) {
      useUIStore.getState().showToast(
        "Saving these edits invalidated the document's digital signature.",
        "warn",
      );
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, signed: false } : t)) }));
    }
    const out = await buildOutputBytes(tab, { editable: !opts?.flat });
    return out.bytes;
  },

  commitAllPending: async (id, pages) => {
    // V1.0126: FLATTEN — burn the editable elements into the page for good
    // and drop them as overlays. Only for operations that rewrite the page
    // itself (crop, digital signature, find-and-replace), where floating
    // elements would otherwise land in the wrong place or be left out.
    // Save / Export / Print use `renderOutput` instead and never flatten.
    if (inFlight.has(id)) return;
    inFlight.add(id);
    try {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab?.bytes || !hasPendingEdits(tab)) return;
      const prevBytes = tab.bytes;
      const { bytes, baked } = await buildOutputBytes(tab, { editable: false, pages });
      const newPdf = await loadPdf(bytes);
      void tab.pdf?.destroy();
      // V1.0111: baking re-serializes the PDF, which breaks a PKCS#7
      // signature's ByteRange. Warn (once) and drop the signed flag.
      if (tab.signed) {
        useUIStore.getState().showToast(
          "Saving these edits invalidated the document's digital signature.",
          "warn",
        );
      }
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== id) return t;
          return {
            ...t,
            bytes,
            pdf: newPdf,
            numPages: newPdf.numPages,
            sizeBytes: bytes.byteLength,
            pendingTextEdits: t.pendingTextEdits.filter((e) => !baked.has(e.id)),
            pendingImageEdits: t.pendingImageEdits.filter((e) => !baked.has(e.id)),
            pendingShapeEdits: t.pendingShapeEdits.filter((e) => !baked.has(e.id)),
            history: capHistory([...t.history, prevBytes]),
            redoStack: [],
            pendingRedoStack: [],
            // V1.0126: one undo step brings back the page AND the elements.
            pendingHistory: [
              ...t.pendingHistory,
              { text: t.pendingTextEdits, image: t.pendingImageEdits, shape: t.pendingShapeEdits },
            ].slice(-30),
            pendingFuture: [],
            ...stepFields(t, "both"),
            redoOrder: [],
            dirty: true,
            signed: false,
            version: t.version + 1,
          };
        }),
      }));
    } finally {
      inFlight.delete(id);
    }
  },

  // V1.0057: snap a pending text or image element to the page's print
  // margins or centerline. 36pt = ½" margin from each edge (standard
  // letterhead convention). PDF user-space is bottom-left origin, so
  // "top margin" means `yPt = pageH − h − 36` and "bottom margin" means
  // `yPt = 36`. Text width is approximated as `0.55 × fontSize × length`
  // (same heuristic SearchBar's pending-edit measurement uses pre-V1.0049);
  // close enough for Helvetica-family standard fonts at typical sizes.
  moveLayer: (tabId, editId, op) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const arrays = { text: tab.pendingTextEdits, image: tab.pendingImageEdits, shape: tab.pendingShapeEdits };
    const patches = computeLayerMove(arrays, editId, op, op === "front" ? nextPendingEditOrder() : 0);
    if (patches.size === 0) return;
    get().pushUndoStep(tabId);
    const apply = <T extends { id: string; z?: number }>(list: T[]): T[] =>
      list.some((e) => patches.has(e.id))
        ? list.map((e) => (patches.has(e.id) ? { ...e, z: patches.get(e.id) } : e))
        : list;
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              pendingTextEdits: apply(t.pendingTextEdits),
              pendingImageEdits: apply(t.pendingImageEdits),
              pendingShapeEdits: apply(t.pendingShapeEdits),
              pendingFuture: [],
              dirty: true,
            }
          : t,
      ),
    }));
  },

  alignPendingElement: async (tabId, kind, editId, alignment, bboxOverride) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab?.pdf) return;
    // V1.0070: snapshot before changing alignment so ⌘Z restores the
    // pre-align position.
    get().pushUndoStep(tabId);
    let page1: number;
    let w: number;
    let h: number;
    let x: number;
    let y: number;
    if (kind === "text") {
      const e = tab.pendingTextEdits.find((p) => p.id === editId);
      if (!e) return;
      page1 = e.page;
      // V1.0081: prefer the caller-supplied rendered bounds (= inner
      // content bbox). Wrap-mode text's stored `widthPt` is the wrap
      // BOUNDARY — often wider than the rendered glyphs, so using it as
      // the alignment box snaps to the empty-frame center instead of
      // the visible text center. Fall back to `widthPt` and a single-
      // line heuristic when no override is supplied (e.g. programmatic
      // align calls not driven by a DOM-measured context menu).
      w = bboxOverride?.wPt ?? e.widthPt ?? 0.55 * e.size * Math.max(1, e.text.length);
      h = bboxOverride?.hPt ?? e.size;
      x = e.xPt;
      y = e.yPt;
    } else {
      const e = tab.pendingImageEdits.find((p) => p.id === editId);
      if (!e) return;
      page1 = e.page;
      w = bboxOverride?.wPt ?? e.widthPt;
      h = bboxOverride?.hPt ?? e.heightPt;
      x = e.xPt;
      y = e.yPt;
    }
    const page = await tab.pdf.getPage(page1);
    const vp = page.getViewport({ scale: 1 });
    const pageW = vp.width;
    const pageH = vp.height;
    const MARGIN = 36;
    // V1.0081: y semantics differ by kind, so vertical alignment uses
    // explicit top/bottom offsets relative to the stored yPt. For TEXT,
    // yPt is the baseline of the first (topmost) line — visible top is
    // one ascent (≈ 0.85 × size) above it; visible bottom sits at
    // baseline − (h − ascent) once subsequent lines + descender are
    // accounted for. For IMAGES, yPt is the bottom-left corner — yPt is
    // already the visible bottom, and visible top is yPt + h. With
    // ascent = h and bottomOffset = 0, the image formulas collapse to
    // the pre-V1.0081 image alignment math (no regression there); for
    // text, they correctly center the visible block on the page
    // instead of placing the baseline on the centerline.
    let topOffset: number;
    let bottomOffset: number;
    if (kind === "text") {
      const sizePt =
        tab.pendingTextEdits.find((p) => p.id === editId)?.size ?? 0;
      const ascent = sizePt * 0.85;
      topOffset = ascent;
      bottomOffset = -(h - ascent);
    } else {
      topOffset = h;
      bottomOffset = 0;
    }
    switch (alignment) {
      case "left":
        x = MARGIN;
        break;
      case "right":
        x = Math.max(MARGIN, pageW - w - MARGIN);
        break;
      case "center-h":
        x = (pageW - w) / 2;
        break;
      case "top":
        y = pageH - MARGIN - topOffset;
        break;
      case "bottom":
        y = MARGIN - bottomOffset;
        break;
      case "center-v":
        y = pageH / 2 - (topOffset + bottomOffset) / 2;
        break;
    }
    if (kind === "text") {
      get().updatePendingTextEdit(tabId, editId, { xPt: x, yPt: y });
    } else {
      get().updatePendingImageEdit(tabId, editId, { xPt: x, yPt: y });
    }
  },
}));
