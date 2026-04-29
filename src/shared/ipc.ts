// Shared IPC channel names + type contracts between main and renderer.

export const IpcChannel = {
  OpenFileDialog: "dialog:open-file",
  SaveFileDialog: "dialog:save-file",
  ReadFile: "fs:read-file",
  WriteFile: "fs:write-file",
  ShowInFolder: "shell:show-in-folder",
  OpenSystemSettings: "shell:open-system-settings",
  GetDefaultPdfApp: "app:get-default-pdf-app",
  SetAsDefaultPdfApp: "app:set-as-default-pdf-app",
  PrintWindow: "window:print",
  GetAppTheme: "app:get-theme",
  ThemeUpdated: "app:theme-updated",
  WindowMinimize: "window:minimize",
  WindowMaximize: "window:maximize",
  WindowClose: "window:close",
  SignatureGet: "signature:get",
  SignatureSet: "signature:set",
  SignatureClear: "signature:clear",
  MenuCommand: "menu:command",
  OpenFilePath: "app:open-file-path",
  OcrRunImage: "ocr:run-image",
  OcrAvailable: "ocr:available",
  QpdfDecrypt: "qpdf:decrypt",
  QpdfAvailable: "qpdf:available",
  QpdfEncrypt: "qpdf:encrypt",
  ConvertDocToPdf: "convert:doc-to-pdf",
  ConvertTextToDocx: "convert:text-to-docx",
  GhostscriptCompress: "gs:compress",
  GhostscriptCompressAdvanced: "gs:compress-advanced",
  GhostscriptAvailable: "gs:available",
  /** Lossless re-pack: qpdf --object-streams=generate --stream-data=compress
   *  --linearize. Cheap, non-destructive — usually shaves 5-15% with no
   *  visible quality change. */
  QpdfCompress: "qpdf:compress",
  /** mutool clean -gggz: aggressive lossless object dedup + stream
   *  recompression from MuPDF. Often beats qpdf on text-heavy PDFs. */
  MutoolAvailable: "mutool:available",
  MutoolClean: "mutool:clean",
  SigGenCert: "sig:gen-cert",
  SigHasCert: "sig:has-cert",
  SigGetCertInfo: "sig:get-cert-info",
  SigClearCert: "sig:clear-cert",
  SigSignPdf: "sig:sign-pdf",
  AiAvailable: "ai:available",
  AiRun: "ai:run",
  /**
   * Test-only: adds a path to the main-side allowlist so the renderer can
   * readFile/writeFile it without going through a dialog. Handler is only
   * registered when VITE_E2E=1 at build time, so production builds don't
   * expose a way to bypass path validation.
   */
  TestBlessPath: "test:bless-path",
  /**
   * Bless a drag-drop path. Side-effect of preload's `getPathForFile` — the
   * renderer only ever receives a path from that API when the File object
   * came from a genuine drag-drop (synthetic File objects return undefined),
   * so an attacker can't widen the allowlist even with preload access.
   */
  BlessDropPath: "fs:bless-drop-path",
  /**
   * Bless an output path derived from an already-blessed input. Used by
   * BatchModal which writes `input.pdf` → `input-processed.pdf` next to
   * originals: since the user explicitly picked `input.pdf` via the file
   * dialog, its sibling in the same dir is an acceptable write target.
   */
  BlessDerivedPath: "fs:bless-derived-path",
  /**
   * Per-PDF draft persistence — autosaves the current edited bytes + every
   * uncommitted pending overlay so the user can resume after closing the tab
   * (or the whole app) without losing unsaved work. Drafts live under
   * userData/drafts/<sha256(sourcePath)>/ as { manifest.json, current.pdf }.
   */
  DraftsSave: "drafts:save",
  DraftsLoad: "drafts:load",
  DraftsClear: "drafts:clear",
  DraftsList: "drafts:list",
} as const;

/**
 * Manifest for a draft. Pending image bytes are inlined as base64 so the
 * manifest is self-contained — fine for the typical small-screenshot case;
 * if drafts grow huge we can swap to side-files in the same slot.
 *
 * `draftKey` is the autosave slot key — equals `sourcePath` for tabs opened
 * from disk, or an `weavepdf-virtual://<uuid>` URI for in-memory tabs (combined
 * PDFs, image/DOCX imports). Virtual drafts have `sourcePath: null` and are
 * resumed via the Recent Drafts picker, not by reopening a disk file.
 */
export type DraftManifest = {
  draftKey: string;
  sourcePath: string | null;
  originalName: string;
  savedAt: string; // ISO-8601
  /** Original-file size at the time the tab was opened (for staleness checks). */
  sourceSizeBytes: number;
  /** True if the saved current.pdf differs from the original (committed history > 0). */
  hasAppliedChanges: boolean;
  /** Serialized pending overlays. Image `bytes` are base64-encoded strings. */
  pendingTextEdits: unknown[];
  pendingImageEdits: unknown[];
  pendingShapeEdits: unknown[];
  /** UI state worth restoring (page, zoom). */
  currentPage: number;
  zoom: number;
};

export type DraftRecord = {
  manifest: DraftManifest;
  /** Null when nothing was committed yet — caller should load the original bytes. */
  currentBytes: ArrayBuffer | null;
};

export type DigitalCertInfo = {
  name: string;
  email: string;
  org?: string;
  createdAt: string;
  expiresAt: string;
};

export type OcrBox = {
  text: string;
  /** normalised 0..1, bottom-left origin (matches Apple Vision boundingBox) */
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
};

export type MenuCommand =
  | "open"
  | "save"
  | "saveAs"
  | "export"
  | "print"
  | "search"
  | "toggleSidebar"
  | "addText"
  | "signature"
  | "highlight"
  | "whiteout"
  | "shapeRect"
  | "shapeCircle"
  | "shapeLine"
  | "shapeArrow"
  | "draw"
  | "compress"
  | "watermark"
  | "metadata"
  | "extractPages"
  | "rotateLeft"
  | "rotateRight"
  | "rotate180"
  | "deletePages"
  | "selectAllPages"
  | "undo"
  | "redo"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "nextPage"
  | "prevPage"
  | "palette"
  | "keyboardShortcuts"
  | "showWelcome"
  | "showWelcomeFinder"
  | "newTab";

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];

export type AppTheme = "light" | "dark";

export type OpenedFile = {
  path: string;
  name: string;
  sizeBytes: number;
  // File bytes as a transferable ArrayBuffer. pdf.js consumes Uint8Array.
  data: ArrayBuffer;
};

export type OpenFileDialogOptions = {
  title?: string;
  filters?: { name: string; extensions: string[] }[];
  multi?: boolean;
};

export type OpenFileDialogResult =
  | { canceled: true }
  | { canceled: false; files: OpenedFile[] };

export type SaveFileDialogOptions = {
  title?: string;
  suggestedName: string;
  // file extensions without the leading dot
  extensions: string[];
};

export type SaveFileDialogResult =
  | { canceled: true }
  | { canceled: false; path: string };

export type WriteFileResult = { ok: true } | { ok: false; error: string };
