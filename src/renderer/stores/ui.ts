import { create } from "zustand";
import type { AppTheme } from "../../shared/ipc";
import type { MenuItem as ContextMenuItem } from "../components/ContextMenu/ContextMenu";

// Per-match rectangle in PDF point space (Y=0 at bottom of page). Computed
// once when the search query changes; consumed by SearchHighlightLayer to
// paint the yellow/orange highlights on top of each rendered page.
export type SearchMatch = {
  globalIndex: number;
  pageNumber: number;
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
  // Extra CSS-pixel offset applied at render time, independent of zoom.
  // Used for matches inside pending text edits, whose rendered HTML
  // wrapper has `px-0.5` (2 CSS pixels) horizontal padding — without
  // this offset the highlight rect sits 2 px left of the visible text.
  extraLeftCssPx?: number;
};

type UIStore = {
  theme: AppTheme;
  sidebarOpen: boolean;
  searchOpen: boolean;
  searchQuery: string;
  // V1.0047: highlights for the current ⌘F query. Driven by SearchBar; read
  // by SearchHighlightLayer mounted under each PageCanvas.
  searchMatches: SearchMatch[];
  searchCursor: number;
  paletteOpen: boolean;
  compressOpen: boolean;
  signatureOpen: boolean;
  metadataOpen: boolean;
  watermarkOpen: boolean;
  extractOpen: boolean;
  headerFooterOpen: boolean;
  cropOpen: boolean;
  formFillOpen: boolean;
  batchOpen: boolean;
  ocrOpen: boolean;
  aiOpen: boolean;
  digitalSignOpen: boolean;
  recentDraftsOpen: boolean;
  pageLayoutOpen: boolean;
  printPreviewOpen: boolean;
  shortcutHelpOpen: boolean;
  welcomeOpen: boolean;
  welcomeInitialStep: 0 | 1;
  stickyPrompt: { page: number; xPt: number; yPt: number } | null;
  textPrompt: { page: number; x: number; y: number; widthPt: number } | null;
  /** V1.0062: when true, new text overlays are sized to fit inside a 36pt
   *  print margin on every edge. Toggled by the Margins button in the
   *  toolstrip. Off = new text can extend all the way to the page edge. */
  marginsEnabled: boolean;
  pendingImage: { bytes: Uint8Array; mime: "image/png" | "image/jpeg" } | null;
  // Shared colour + stroke settings for shape/highlight/draw tools.
  annotationColor: { r: number; g: number; b: number };
  strokeWidth: number;
  // Most-recently-used colours (max 6) — shown in ColorPopover as a quick
  // re-pick strip. Capped to the most recent unique entries.
  recentColors: Array<{ r: number; g: number; b: number }>;
  sidebarTab: "pages" | "outline" | "revisions";
  // Page layout in the viewer:
  //   single — vertical scroll, one page wide (default)
  //   spread — two pages side-by-side, no cover offset
  //   cover-spread — first page solo, then 2-3, 4-5, … (book-style)
  viewMode: "single" | "spread" | "cover-spread";
  // Last-set scale for the measurement tool: how many real-world units one
  // PDF point represents, plus the unit label ("ft", "m", "in", …). Null
  // means the user hasn't calibrated yet — we'll prompt on first use.
  measureScale: { unitsPerPoint: number; unit: string } | null;
  // Pending link draft — when the user drags a "Link" rectangle, we stash
  // it here and surface a popover so they can pick URL or page target.
  pendingLink: {
    page: number;
    rect: { x: number; y: number; width: number; height: number };
    screenX: number;
    screenY: number;
    suggestedUrl?: string;
  } | null;
  // id of the currently selected pending image (for keyboard nudge/delete).
  selectedPendingImageId: string | null;
  // id of the currently selected pending text edit (for keyboard nudge/delete).
  selectedPendingTextId: string | null;
  // id of the currently selected pending shape (rect/ellipse/line/arrow/etc.)
  selectedPendingShapeId: string | null;
  // id of a pending text edit that should immediately enter edit mode — set
  // by the Edit-Existing-Text click handler so the user can start typing right
  // away instead of having to double-click the duplicate.
  editingPendingTextId: string | null;
  // Active right-click menu — one global instance rendered at the App level.
  contextMenu: { x: number; y: number; items: ContextMenuItem[] } | null;
  /** V1.0087: draggable Crop tool state. Replaces the V1.0028
   *  CropModal (numeric TLBR inputs). When `tool === "crop"`, the
   *  CropOverlay component reads this rectangle and renders the scrim
   *  + handles on the active page; the floating CropActionBar reads
   *  it for the dimension readout. Coords are PDF points, bottom-left
   *  origin, scoped to a single source page (the page the user was
   *  viewing on tool entry) — Apply still produces uniform TLBR
   *  margins across every page via `cropPages`. Cleared on Apply or
   *  Cancel; persists across page-scroll within crop mode. */
  cropDraft: {
    pageNumber: number;
    pageWPt: number;
    pageHPt: number;
    xPt: number;
    yPt: number;
    wPt: number;
    hPt: number;
  } | null;
  /** V1.0077: short-lived informational banner anchored to the bottom of
   *  the viewer. Used to confirm round-trip metadata restoration so the
   *  user can SEE whether a reopened file's editable overlays came back.
   *  Auto-dismisses after a few seconds — the App-level component owns
   *  the timer. */
  toast: { id: number; message: string; tone: "info" | "warn" } | null;
  // Active annotation / edit tool — null means plain viewer.
  tool:
    | "none"
    | "highlight"
    | "text"
    | "editText"
    | "whiteout"
    | "signature"
    | "rect"
    | "circle"
    | "line"
    | "arrow"
    | "draw"
    | "image"
    | "sticky"
    | "crop"
    | "redact"
    | "link"
    | "measure";
  setTheme: (theme: AppTheme) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  openSearch: () => void;
  closeSearch: () => void;
  setSearchQuery: (q: string) => void;
  setSearchResults: (matches: SearchMatch[], cursor: number) => void;
  setSearchCursor: (cursor: number) => void;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  openCompress: () => void;
  closeCompress: () => void;
  openSignature: () => void;
  closeSignature: () => void;
  openMetadata: () => void;
  closeMetadata: () => void;
  openWatermark: () => void;
  closeWatermark: () => void;
  openExtract: () => void;
  closeExtract: () => void;
  openImagePicker: () => Promise<void>;
  openHeaderFooter: () => void;
  closeHeaderFooter: () => void;
  openCrop: () => void;
  closeCrop: () => void;
  openFormFill: () => void;
  closeFormFill: () => void;
  openBatch: () => void;
  closeBatch: () => void;
  openOcr: () => void;
  closeOcr: () => void;
  openDigitalSign: () => void;
  closeDigitalSign: () => void;
  openRecentDrafts: () => void;
  closeRecentDrafts: () => void;
  openPageLayout: () => void;
  closePageLayout: () => void;
  openPrintPreview: () => void;
  closePrintPreview: () => void;
  openShortcutHelp: () => void;
  closeShortcutHelp: () => void;
  openWelcome: (initialStep?: 0 | 1) => void;
  closeWelcome: () => void;
  openAi: () => void;
  closeAi: () => void;
  setTool: (tool: UIStore["tool"]) => void;
  setTextPrompt: (p: { page: number; x: number; y: number; widthPt: number } | null) => void;
  /** V1.0062: toggle whether new text overlays default to fit-inside-print-margins. */
  toggleMargins: () => void;
  setStickyPrompt: (p: { page: number; xPt: number; yPt: number } | null) => void;
  setAnnotationColor: (c: { r: number; g: number; b: number }) => void;
  setStrokeWidth: (w: number) => void;
  setSidebarTab: (tab: UIStore["sidebarTab"]) => void;
  setViewMode: (mode: UIStore["viewMode"]) => void;
  setMeasureScale: (s: UIStore["measureScale"]) => void;
  setPendingLink: (p: UIStore["pendingLink"]) => void;
  setSelectedPendingImage: (id: string | null) => void;
  setSelectedPendingText: (id: string | null) => void;
  setSelectedPendingShape: (id: string | null) => void;
  /**
   * Drop selection from every pending-edit kind in one call. Used by the
   * Viewer's background-click handler so clicking off a placed image/text/
   * shape removes its selection chrome (resize handles, X delete badge,
   * font-size +/-, etc.) — same affordance as Figma/Keynote.
   */
  clearAllPendingSelections: () => void;
  setEditingPendingText: (id: string | null) => void;
  openContextMenu: (x: number, y: number, items: ContextMenuItem[]) => void;
  closeContextMenu: () => void;
  showToast: (message: string, tone?: "info" | "warn") => void;
  dismissToast: () => void;
  setCropDraft: (d: UIStore["cropDraft"]) => void;
};

export const useUIStore = create<UIStore>((set) => ({
  theme: "light",
  sidebarOpen: true,
  searchOpen: false,
  searchQuery: "",
  searchMatches: [],
  searchCursor: 0,
  paletteOpen: false,
  compressOpen: false,
  signatureOpen: false,
  metadataOpen: false,
  watermarkOpen: false,
  extractOpen: false,
  headerFooterOpen: false,
  cropOpen: false,
  formFillOpen: false,
  batchOpen: false,
  ocrOpen: false,
  aiOpen: false,
  digitalSignOpen: false,
  recentDraftsOpen: false,
  pageLayoutOpen: false,
  printPreviewOpen: false,
  shortcutHelpOpen: false,
  welcomeOpen: false,
  welcomeInitialStep: 0,
  stickyPrompt: null,
  textPrompt: null,
  marginsEnabled: true,
  pendingImage: null,
  annotationColor: { r: 0.05, g: 0.05, b: 0.1 },
  strokeWidth: 1.5,
  recentColors: [],
  sidebarTab: "pages",
  viewMode: "single",
  measureScale: null,
  pendingLink: null,
  selectedPendingImageId: null,
  selectedPendingTextId: null,
  selectedPendingShapeId: null,
  editingPendingTextId: null,
  contextMenu: null,
  toast: null,
  cropDraft: null,
  tool: "none",
  setTheme: (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    set({ theme });
  },
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  openSearch: () => set({ searchOpen: true }),
  closeSearch: () =>
    set({ searchOpen: false, searchQuery: "", searchMatches: [], searchCursor: 0 }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  setSearchResults: (matches, cursor) => set({ searchMatches: matches, searchCursor: cursor }),
  setSearchCursor: (cursor) => set({ searchCursor: cursor }),
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  openCompress: () => set({ compressOpen: true }),
  closeCompress: () => set({ compressOpen: false }),
  openSignature: () => set({ signatureOpen: true }),
  closeSignature: () => set({ signatureOpen: false }),
  openMetadata: () => set({ metadataOpen: true }),
  closeMetadata: () => set({ metadataOpen: false }),
  openWatermark: () => set({ watermarkOpen: true }),
  closeWatermark: () => set({ watermarkOpen: false }),
  openExtract: () => set({ extractOpen: true }),
  closeExtract: () => set({ extractOpen: false }),
  openImagePicker: async () => {
    const result = await window.weavepdf.openFileDialog({
      title: "Place an image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
      multi: false,
    });
    if (result.canceled || result.files.length === 0) return;
    const file = result.files[0];
    const bytes = new Uint8Array(file.data);
    const isPng = file.name.toLowerCase().endsWith(".png");
    set({
      pendingImage: { bytes, mime: isPng ? "image/png" : "image/jpeg" },
      tool: "image",
    });
  },
  openHeaderFooter: () => set({ headerFooterOpen: true }),
  closeHeaderFooter: () => set({ headerFooterOpen: false }),
  // V1.0087: Crop is now a draggable tool mode, not a modal. The
  // `openCrop` action remains so the palette / menu / hotkey ("C")
  // wiring is unchanged — it now ENTERS crop tool mode and resets the
  // draft (forces a fresh auto-detect seed on the active page).
  // `closeCrop` exits crop tool mode if active. `cropOpen` stays false
  // forever — the old modal is gone.
  openCrop: () => set({ tool: "crop", cropDraft: null }),
  closeCrop: () =>
    set((s) =>
      s.tool === "crop" ? { tool: "none", cropDraft: null } : { cropDraft: null },
    ),
  openFormFill: () => set({ formFillOpen: true }),
  closeFormFill: () => set({ formFillOpen: false }),
  openBatch: () => set({ batchOpen: true }),
  closeBatch: () => set({ batchOpen: false }),
  openOcr: () => set({ ocrOpen: true }),
  closeOcr: () => set({ ocrOpen: false }),
  openDigitalSign: () => set({ digitalSignOpen: true }),
  closeDigitalSign: () => set({ digitalSignOpen: false }),
  openRecentDrafts: () => set({ recentDraftsOpen: true }),
  closeRecentDrafts: () => set({ recentDraftsOpen: false }),
  openPageLayout: () => set({ pageLayoutOpen: true }),
  closePageLayout: () => set({ pageLayoutOpen: false }),
  openPrintPreview: () => set({ printPreviewOpen: true }),
  closePrintPreview: () => set({ printPreviewOpen: false }),
  openShortcutHelp: () => set({ shortcutHelpOpen: true }),
  closeShortcutHelp: () => set({ shortcutHelpOpen: false }),
  openWelcome: (initialStep = 0) => set({ welcomeOpen: true, welcomeInitialStep: initialStep }),
  closeWelcome: () => set({ welcomeOpen: false }),
  openAi: () => set({ aiOpen: true }),
  closeAi: () => set({ aiOpen: false }),
  setTool: (tool) => set({ tool }),
  setTextPrompt: (p) => set({ textPrompt: p }),
  toggleMargins: () => set((s) => ({ marginsEnabled: !s.marginsEnabled })),
  setStickyPrompt: (p) => set({ stickyPrompt: p }),
  setAnnotationColor: (c) =>
    set((s) => {
      // Drop any earlier identical entry (within 1% per channel) so the list
      // stays unique by the user's perceptual sense of "the same colour".
      const eq = (a: typeof c, b: typeof c) =>
        Math.abs(a.r - b.r) < 0.01 && Math.abs(a.g - b.g) < 0.01 && Math.abs(a.b - b.b) < 0.01;
      const filtered = s.recentColors.filter((p) => !eq(p, c));
      return { annotationColor: c, recentColors: [c, ...filtered].slice(0, 6) };
    }),
  setStrokeWidth: (w) => set({ strokeWidth: Math.max(0.5, Math.min(12, w)) }),
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setMeasureScale: (s) => set({ measureScale: s }),
  setPendingLink: (p) => set({ pendingLink: p }),
  setSelectedPendingImage: (id) => set({ selectedPendingImageId: id }),
  setSelectedPendingText: (id) => set({ selectedPendingTextId: id }),
  setSelectedPendingShape: (id) => set({ selectedPendingShapeId: id }),
  clearAllPendingSelections: () =>
    set({
      selectedPendingImageId: null,
      selectedPendingTextId: null,
      selectedPendingShapeId: null,
      editingPendingTextId: null,
    }),
  setEditingPendingText: (id) => set({ editingPendingTextId: id }),
  openContextMenu: (x, y, items) => set({ contextMenu: { x, y, items } }),
  closeContextMenu: () => set({ contextMenu: null }),
  showToast: (message, tone = "info") =>
    set({ toast: { id: Date.now() + Math.random(), message, tone } }),
  dismissToast: () => set({ toast: null }),
  setCropDraft: (d) => set({ cropDraft: d }),
}));
