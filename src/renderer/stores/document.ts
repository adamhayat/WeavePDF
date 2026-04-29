import { create } from "zustand";
import { pdfjsLib, type PDFDocumentProxy } from "../lib/pdfjs";
// Lazy-loaded so the pdf-lib chunk (~425 KB) doesn't pull at boot. The store
// itself is created at module-load (which Vite imports eagerly), but every
// pdf-ops function is only invoked from a commit* action that runs after
// user interaction. The chunk parses on first commit, off the cold-launch
// critical path.
const loadPdfOps = () => import("../lib/pdf-ops");

type RGB = { r: number; g: number; b: number };
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

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
  page: number;
  xPt: number;
  yPt: number;
  size: number;
  text: string;
  whiteout?: { x: number; y: number; width: number; height: number };
  /** Optional pdf-lib StandardFont name — propagated from the Edit-Text
   * click handler when it can detect the original font family. */
  fontName?: string;
};

/**
 * A pasted or placed image that lives as a draggable/resizable overlay
 * until commit. (x, y) is the bottom-left anchor in PDF points.
 */
export type PendingImageEdit = {
  id: string;
  createdAt?: number;
  page: number;
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg";
};

/**
 * Every drag-to-draw tool (shapes, highlight, whiteout, redact, freehand)
 * plus sticky-note become pending overlays that can be moved, resized, and
 * deleted before commit. Keeps the UX consistent with pasted text/images.
 *
 * All coordinates are PDF user-space (points, bottom-left origin).
 */
export type PendingShapeEdit = { id: string; createdAt?: number; page: number } & (
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
  // Monotonic counter incremented whenever the PDF bytes change — components
  // key renders off this so stale canvas state doesn't leak across edits.
  version: number;
};

type AddTabInput = {
  name: string;
  path: string | null;
  saveInPlace?: boolean;
  /** Optional pre-existing draftKey — used when restoring a virtual draft so
   *  autosave keeps writing to the same slot instead of forking. */
  draftKey?: string;
  sizeBytes: number;
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
  setActiveTab: (id: string) => void;
  setCurrentPage: (id: string, page: number) => void;
  setZoom: (id: string, zoom: number) => void;
  renameTab: (id: string, name: string) => void;

  // Selection
  selectPage: (id: string, page: number, mode: "set" | "toggle" | "range") => void;
  selectAllPages: (id: string) => void;
  clearSelection: (id: string) => void;

  // Edits
  applyEdit: (id: string, newBytes: Uint8Array, opts?: { newCurrentPage?: number }) => Promise<void>;
  undo: (id: string) => Promise<void>;
  redo: (id: string) => Promise<void>;
  markClean: (id: string, pathIfSaved: string) => void;

  // Pending text edits (draggable overlays until committed)
  addPendingTextEdit: (id: string, edit: Omit<PendingTextEdit, "id">) => string;
  updatePendingTextEdit: (id: string, editId: string, patch: Partial<PendingTextEdit>) => void;
  removePendingTextEdit: (id: string, editId: string) => void;
  commitAllPendingTextEdits: (id: string) => Promise<void>;

  // Pending image edits (draggable/resizable overlays until committed)
  addPendingImageEdit: (id: string, edit: Omit<PendingImageEdit, "id">) => string;
  updatePendingImageEdit: (id: string, editId: string, patch: Partial<PendingImageEdit>) => void;
  removePendingImageEdit: (id: string, editId: string) => void;
  commitAllPendingImageEdits: (id: string) => Promise<void>;

  // Pending shape edits (rect/ellipse/line/arrow/freehand/highlight/whiteout/redact/sticky)
  // DistributiveOmit preserves the discriminated union across Omit — without
  // it, Omit<PendingShapeEdit, "id"> collapses to the common fields only.
  addPendingShapeEdit: (id: string, edit: DistributiveOmit<PendingShapeEdit, "id">) => string;
  updatePendingShapeEdit: (id: string, editId: string, patch: Partial<PendingShapeEdit>) => void;
  removePendingShapeEdit: (id: string, editId: string) => void;
  commitAllPendingShapeEdits: (id: string) => Promise<void>;

  // Commit text + image + shape edits together (save/export/print path).
  commitAllPending: (id: string) => Promise<void>;
};

async function loadPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return pdfjsLib.getDocument({ data: bytes.slice() }).promise;
}

// Per-tab in-flight guard. A second edit/undo for the same tab is dropped
// while the first is still running — prevents history corruption when the
// user hammers ⌘Z or fires two fast edits that both read the same state.
const inFlight = new Set<string>();
let pendingEditSeq = 0;

function nextPendingEditOrder(): number {
  pendingEditSeq += 1;
  return pendingEditSeq;
}

function hasPendingEdits(tab: DocumentTab): boolean {
  return (
    tab.pendingTextEdits.length > 0 ||
    tab.pendingImageEdits.length > 0 ||
    tab.pendingShapeEdits.length > 0
  );
}

function latestPendingEdit(tab: DocumentTab): { kind: "text" | "image" | "shape"; id: string } | null {
  const candidates: Array<{ kind: "text" | "image" | "shape"; id: string; order: number }> = [];
  tab.pendingTextEdits.forEach((e, index) =>
    candidates.push({ kind: "text", id: e.id, order: e.createdAt ?? index }),
  );
  tab.pendingImageEdits.forEach((e, index) =>
    candidates.push({ kind: "image", id: e.id, order: e.createdAt ?? index }),
  );
  tab.pendingShapeEdits.forEach((e, index) =>
    candidates.push({ kind: "shape", id: e.id, order: e.createdAt ?? index }),
  );
  candidates.sort((a, b) => b.order - a.order);
  return candidates[0] ?? null;
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
      saveInPlace: init.saveInPlace ?? false,
      draftKey: init.draftKey ?? init.path ?? `weavepdf-virtual://${id}`,
      sizeBytes: init.sizeBytes,
      bytes: init.bytes,
      pdf: init.pdf,
      numPages: init.numPages,
      currentPage: 1,
      zoom: 1,
      dirty: false,
      selectedPages: new Set(),
      pendingTextEdits: [],
      pendingImageEdits: [],
      pendingShapeEdits: [],
      history: [],
      redoStack: [],
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
      bytes: null,
      pdf: null,
      numPages: 0,
      currentPage: 1,
      zoom: 1,
      dirty: false,
      selectedPages: new Set(),
      pendingTextEdits: [],
      pendingImageEdits: [],
      pendingShapeEdits: [],
      history: [],
      redoStack: [],
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
      const nextActive =
        s.activeTabId === id
          ? (nextTabs[nextTabs.length - 1]?.id ?? null)
          : s.activeTabId;
      return { tabs: nextTabs, activeTabId: nextActive };
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
      const activeStillOpen = nextTabs.some((t) => t.id === s.activeTabId);
      return {
        tabs: nextTabs,
        activeTabId: activeStillOpen ? s.activeTabId : (nextTabs[nextTabs.length - 1]?.id ?? null),
      };
    });
  },

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
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== id) return t;
          const nextHistory = [...t.history, prevBytes];
          return {
            ...t,
            bytes: newBytes,
            pdf: newPdf,
            numPages: newPdf.numPages,
            sizeBytes: newBytes.byteLength,
            currentPage: Math.min(
              opts?.newCurrentPage ?? t.currentPage,
              newPdf.numPages,
            ),
            selectedPages: new Set(),
            history: nextHistory.slice(-20), // cap at 20 undo levels
            // A new edit invalidates the redo stack — you can't "re-do" what
            // was undone once you've gone a different direction.
            redoStack: [],
            dirty: true,
            version: t.version + 1,
          };
        }),
      }));
    } finally {
      inFlight.delete(id);
    }
  },

  undo: async (id) => {
    if (inFlight.has(id)) return;
    const pendingTab = get().tabs.find((t) => t.id === id);
    const pending = pendingTab ? latestPendingEdit(pendingTab) : null;
    if (pendingTab && pending) {
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== id) return t;
          const pendingTextEdits =
            pending.kind === "text"
              ? t.pendingTextEdits.filter((e) => e.id !== pending.id)
              : t.pendingTextEdits;
          const pendingImageEdits =
            pending.kind === "image"
              ? t.pendingImageEdits.filter((e) => e.id !== pending.id)
              : t.pendingImageEdits;
          const pendingShapeEdits =
            pending.kind === "shape"
              ? t.pendingShapeEdits.filter((e) => e.id !== pending.id)
              : t.pendingShapeEdits;
          const next = {
            ...t,
            pendingTextEdits,
            pendingImageEdits,
            pendingShapeEdits,
          };
          return {
            ...next,
            dirty: t.history.length > 0 || hasPendingEdits(next),
          };
        }),
      }));
      return;
    }
    inFlight.add(id);
    try {
      const current = get().tabs.find((t) => t.id === id);
      if (!current || current.history.length === 0 || !current.bytes) return;
      const prevBytes = current.history[current.history.length - 1];
      const undoneBytes = current.bytes;
      const newPdf = await loadPdf(prevBytes);
      void current.pdf?.destroy();
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== id) return t;
          const nextHistory = t.history.slice(0, -1);
          return {
            ...t,
            bytes: prevBytes,
            pdf: newPdf,
            numPages: newPdf.numPages,
            sizeBytes: prevBytes.byteLength,
            currentPage: Math.min(t.currentPage, newPdf.numPages),
            selectedPages: new Set(),
            history: nextHistory,
            // Push the state we just undid onto the redo stack.
            redoStack: [...t.redoStack, undoneBytes].slice(-20),
            // Still dirty only if earlier edits remain to undo.
            dirty:
              nextHistory.length > 0 ||
              t.pendingTextEdits.length > 0 ||
              t.pendingImageEdits.length > 0 ||
              t.pendingShapeEdits.length > 0,
            version: t.version + 1,
          };
        }),
      }));
    } finally {
      inFlight.delete(id);
    }
  },

  redo: async (id) => {
    if (inFlight.has(id)) return;
    inFlight.add(id);
    try {
      const current = get().tabs.find((t) => t.id === id);
      if (!current || current.redoStack.length === 0 || !current.bytes) return;
      const nextBytes = current.redoStack[current.redoStack.length - 1];
      const redoneFrom = current.bytes;
      const newPdf = await loadPdf(nextBytes);
      void current.pdf?.destroy();
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== id) return t;
          return {
            ...t,
            bytes: nextBytes,
            pdf: newPdf,
            numPages: newPdf.numPages,
            sizeBytes: nextBytes.byteLength,
            currentPage: Math.min(t.currentPage, newPdf.numPages),
            selectedPages: new Set(),
            // The state we were at goes back onto the history stack so the
            // next ⌘Z returns to it.
            history: [...t.history, redoneFrom].slice(-20),
            redoStack: t.redoStack.slice(0, -1),
            dirty: true,
            version: t.version + 1,
          };
        }),
      }));
    } finally {
      inFlight.delete(id);
    }
  },

  markClean: (id, pathIfSaved) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              dirty: false,
              path: pathIfSaved,
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
            }
          : t,
      ),
    })),

  addPendingTextEdit: (id, edit) => {
    const editId = crypto.randomUUID();
    const createdAt = nextPendingEditOrder();
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? { ...t, pendingTextEdits: [...t.pendingTextEdits, { id: editId, createdAt, ...edit }], dirty: true }
          : t,
      ),
    }));
    return editId;
  },

  updatePendingTextEdit: (id, editId, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              dirty: true,
              pendingTextEdits: t.pendingTextEdits.map((e) =>
                e.id === editId ? { ...e, ...patch } : e,
              ),
            }
          : t,
      ),
    })),

  removePendingTextEdit: (id, editId) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        const pendingTextEdits = t.pendingTextEdits.filter((e) => e.id !== editId);
        // If there are no more pending edits AND no applied history, the
        // tab is back to its loaded state — drop the dirty flag.
        const stillDirty =
          t.history.length > 0 ||
          pendingTextEdits.length > 0 ||
          t.pendingImageEdits.length > 0 ||
          t.pendingShapeEdits.length > 0;
        return { ...t, pendingTextEdits, dirty: stillDirty };
      }),
    })),

  commitAllPendingTextEdits: async (id) => {
    if (inFlight.has(id)) return;
    inFlight.add(id);
    try {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab?.bytes || tab.pendingTextEdits.length === 0) return;
      let bytes: Uint8Array = tab.bytes;
      const { whiteoutRegion, drawText } = await loadPdfOps();
      // Sort by page so we touch each page's page stream in natural order.
      const edits = [...tab.pendingTextEdits].sort((a, b) => a.page - b.page);
      for (const e of edits) {
        // Edits that replace existing text whiteout the old region first.
        if (e.whiteout) {
          bytes = await whiteoutRegion(bytes, e.page, e.whiteout);
        }
        bytes = await drawText(bytes, e.page, {
          x: e.xPt,
          y: e.yPt,
          size: e.size,
          text: e.text,
          font: e.fontName as Parameters<typeof drawText>[2]["font"],
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
            history: [...t.history, prevBytes].slice(-20),
            redoStack: [],
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
    const editId = crypto.randomUUID();
    const createdAt = nextPendingEditOrder();
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? { ...t, pendingImageEdits: [...t.pendingImageEdits, { id: editId, createdAt, ...edit }], dirty: true }
          : t,
      ),
    }));
    return editId;
  },

  updatePendingImageEdit: (id, editId, patch) =>
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
            }
          : t,
      ),
    })),

  removePendingImageEdit: (id, editId) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        const pendingImageEdits = t.pendingImageEdits.filter((e) => e.id !== editId);
        const stillDirty =
          t.history.length > 0 ||
          pendingImageEdits.length > 0 ||
          t.pendingTextEdits.length > 0 ||
          t.pendingShapeEdits.length > 0;
        return { ...t, pendingImageEdits, dirty: stillDirty };
      }),
    })),

  addPendingShapeEdit: (id, edit) => {
    const editId = crypto.randomUUID();
    const createdAt = nextPendingEditOrder();
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              pendingShapeEdits: [...t.pendingShapeEdits, { id: editId, createdAt, ...edit } as PendingShapeEdit],
              dirty: true,
            }
          : t,
      ),
    }));
    return editId;
  },

  updatePendingShapeEdit: (id, editId, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              dirty: true,
              pendingShapeEdits: t.pendingShapeEdits.map((e) =>
                e.id === editId ? ({ ...e, ...patch } as PendingShapeEdit) : e,
              ),
            }
          : t,
      ),
    })),

  removePendingShapeEdit: (id, editId) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        const pendingShapeEdits = t.pendingShapeEdits.filter((e) => e.id !== editId);
        const stillDirty =
          t.history.length > 0 ||
          pendingShapeEdits.length > 0 ||
          t.pendingTextEdits.length > 0 ||
          t.pendingImageEdits.length > 0;
        return { ...t, pendingShapeEdits, dirty: stillDirty };
      }),
    })),

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
            history: [...t.history, prevBytes].slice(-20),
            redoStack: [],
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
      const { placeImage } = await loadPdfOps();
      const edits = [...tab.pendingImageEdits].sort((a, b) => a.page - b.page);
      for (const e of edits) {
        bytes = await placeImage(bytes, e.page, e.bytes, e.mime, {
          x: e.xPt,
          y: e.yPt,
          width: e.widthPt,
          height: e.heightPt,
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
            history: [...t.history, prevBytes].slice(-20),
            redoStack: [],
            dirty: true,
            version: t.version + 1,
          };
        }),
      }));
    } finally {
      inFlight.delete(id);
    }
  },

  commitAllPending: async (id) => {
    // Sequential — each respects its own per-tab in-flight guard, so they
    // can't deadlock: the first releases before the second acquires.
    // Order matters: shapes first (backgrounds), images second, text on top
    // so whiteouts for Edit-Text don't cover our pending annotations.
    await get().commitAllPendingShapeEdits(id);
    await get().commitAllPendingImageEdits(id);
    await get().commitAllPendingTextEdits(id);
  },
}));
