import type {
  AppTheme,
  DigitalCertInfo,
  DraftManifest,
  DraftRecord,
  MenuCommand,
  OcrBox,
  OpenFileDialogOptions,
  OpenFileDialogResult,
  OpenedFile,
  PrintOptions,
  PrinterInfo,
  SaveFileDialogOptions,
  SaveFileDialogResult,
  WriteFileResult,
} from "./ipc";

// The API surface exposed on window.weavepdf by the preload script.
export interface WeavePDFApi {
  openFileDialog: (options?: OpenFileDialogOptions) => Promise<OpenFileDialogResult>;
  saveFileDialog: (options: SaveFileDialogOptions) => Promise<SaveFileDialogResult>;
  readFile: (path: string) => Promise<OpenedFile>;
  writeFile: (path: string, bytes: ArrayBuffer) => Promise<WriteFileResult>;
  showInFolder: (path: string) => Promise<void>;
  openSystemSettings: () => Promise<void>;
  getDefaultPdfApp: () => Promise<{ isDefault: boolean; currentBundleId: string | null }>;
  setAsDefaultPdfApp: () => Promise<{ ok: boolean; error?: string }>;
  printWindow: () => Promise<void>;
  /** V1.0026: publish the current list of dirty tab names to main so the
   *  close / before-quit handler can show an "unsaved changes" dialog. */
  notifyDirtyTabs: (names: string[]) => void;
  /** V1.0021: print clean PDF bytes via hidden BrowserWindow. Caller bakes
   *  pending overlays + applies n-up layout first. V1.0028 adds PrintOptions —
   *  with options provided, prints silently via the chosen printer (no
   *  macOS dialog). Without options, the legacy V1.0021 path runs (shows
   *  the macOS dialog). `documentName` is the print-job title.
   *  Returns ok:true if printed; ok:false + error for failures. */
  printPdfBytes: (
    bytes: ArrayBuffer,
    documentName?: string,
    options?: PrintOptions,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** V1.0028: list available printers for the unified Print Preview panel. */
  listPrinters: () => Promise<PrinterInfo[]>;
  getTheme: () => Promise<AppTheme>;
  onThemeUpdated: (cb: (theme: AppTheme) => void) => () => void;
  // Electron 32+ removed File.path for security; use webUtils.getPathForFile
  // via the preload to resolve dropped-file paths.
  getPathForFile: (file: File) => string;
  signature: {
    get: () => Promise<string | null>;
    set: (dataUrl: string) => Promise<void>;
    clear: () => Promise<void>;
  };
  onMenuCommand: (cb: (cmd: MenuCommand) => void) => () => void;
  onOpenFilePath: (cb: (path: string) => void) => () => void;
  window: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
  };
  ocr: {
    /** true if the Swift Vision helper is built and shipped with the app. */
    available: () => Promise<boolean>;
    /** Run Apple Vision text recognition over a PNG image; returns bounding boxes. */
    runImage: (pngBytes: ArrayBuffer) => Promise<OcrBox[]>;
  };
  qpdf: {
    /** true if qpdf is installed on this Mac (homebrew or /usr/bin). */
    available: () => Promise<boolean>;
    /** Remove password encryption from a PDF. Returns decrypted bytes. Throws with "Incorrect password" for a bad password. */
    decrypt: (bytes: ArrayBuffer, password: string) => Promise<ArrayBuffer>;
    /** Add 256-bit AES encryption. Owner password defaults to user password. */
    encrypt: (bytes: ArrayBuffer, userPassword: string, ownerPassword?: string) => Promise<ArrayBuffer>;
  };
  ghostscript: {
    /** true if Ghostscript (gs) is installed. */
    available: () => Promise<boolean>;
    /** Heavy compression via gs with a PDFSETTINGS quality preset. */
    compress: (bytes: ArrayBuffer, quality: "screen" | "ebook" | "printer" | "prepress") => Promise<ArrayBuffer>;
    /** Custom-tuned compression: precise control over downsample resolution
     *  per content type + JPEG quality. Used by the "Custom" preset in the
     *  CompressModal so the user can dial in the exact size/quality trade-off. */
    compressAdvanced: (
      bytes: ArrayBuffer,
      opts: {
        colorDpi: number; // image DPI ceiling for color images
        grayDpi: number; // image DPI ceiling for grayscale images
        monoDpi: number; // image DPI ceiling for monochrome (line art)
        jpegQuality: number; // 0..100 — drives /QFactor (lower QFactor = higher quality)
        compatibility?: "1.4" | "1.5" | "1.6" | "1.7";
      },
    ) => Promise<ArrayBuffer>;
  };
  /** Lossless re-pack via qpdf: object-stream compression + linearize. */
  qpdfCompress: (bytes: ArrayBuffer) => Promise<ArrayBuffer>;
  mutool: {
    /** true if MuPDF's mutool is installed (`brew install mupdf-tools`). */
    available: () => Promise<boolean>;
    /** mutool clean -gggz — aggressive lossless object dedup + recompression. */
    clean: (bytes: ArrayBuffer) => Promise<ArrayBuffer>;
  };
  /** Convert a .docx / .doc / .rtf file to PDF via macOS textutil + printToPDF. */
  convertDocToPdf: (bytes: ArrayBuffer, filename: string) => Promise<ArrayBuffer>;
  /** Convert plain text to a .docx file via macOS textutil. */
  convertTextToDocx: (text: string) => Promise<ArrayBuffer>;
  ai: {
    /** true if the Foundation Models Swift helper is built + shipped. */
    available: () => Promise<boolean>;
    /** Run on-device Apple Intelligence. `mode` = summarize | qa | rewrite.
     *  `extra` is the question (qa) or style (rewrite). Returns the model's
     *  response as a plain string. */
    run: (mode: "summarize" | "qa" | "rewrite", text: string, extra?: string) => Promise<string>;
  };
  digitalSig: {
    /** Generate a fresh self-signed X.509 / PKCS#12 cert. Stored only with Keychain-backed encryption. */
    genCert: (params: { name: string; email: string; org?: string; years?: number }) => Promise<DigitalCertInfo>;
    /** true if a cert has been generated and is stored. */
    hasCert: () => Promise<boolean>;
    /** Metadata (subject, expiry) for the stored cert, or null. */
    getCertInfo: () => Promise<DigitalCertInfo | null>;
    /** Delete the stored cert + metadata. */
    clearCert: () => Promise<void>;
    /** Apply a PKCS#7 signature to a PDF byte stream. Returns signed bytes. */
    signPdf: (bytes: ArrayBuffer, opts?: { reason?: string; location?: string }) => Promise<ArrayBuffer>;
  };
  /** Bless an output path whose sibling (same dir) is already blessed.
   *  Returns true on success. Used by BatchModal for derived outputs. */
  blessDerivedPath: (source: string, derived: string) => Promise<boolean>;
  drafts: {
    /** Persist a draft for the given draftKey. `currentBytes` is the
     *  applied/committed PDF state; null when only pending overlays exist. */
    save: (manifest: DraftManifest, currentBytes: ArrayBuffer | null) => Promise<void>;
    /** Load the draft for a draftKey, or null if none exists. */
    load: (draftKey: string) => Promise<DraftRecord | null>;
    /** Delete the draft slot for a draftKey. Called on save-to-original
     *  and explicit "Discard draft". */
    clear: (draftKey: string) => Promise<void>;
    /** List every saved draft (newest first). Drives the Recent Drafts modal. */
    list: () => Promise<DraftManifest[]>;
  };
  pages: {
    /** Start a native OS drag carrying a single-page PDF extracted from the
     *  given source bytes. Call from a `dragstart` handler after
     *  `e.preventDefault()` — Electron's `webContents.startDrag()` initiates
     *  its own OS drag with file payload, replacing the browser's default. */
    startDrag: (payload: {
      bytes: ArrayBuffer;
      pageNumber: number;
      fileName: string;
    }) => void;
  };
  platform: NodeJS.Platform;
}

declare global {
  interface Window {
    weavepdf: WeavePDFApi;
  }
}
