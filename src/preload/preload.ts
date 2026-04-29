import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  IpcChannel,
  type AppTheme,
  type DigitalCertInfo,
  type MenuCommand,
  type OcrBox,
  type OpenFileDialogOptions,
  type OpenFileDialogResult,
  type OpenedFile,
  type SaveFileDialogOptions,
  type SaveFileDialogResult,
  type WriteFileResult,
} from "../shared/ipc";
import type { WeavePDFApi } from "../shared/api";

const api: WeavePDFApi = {
  openFileDialog: (options?: OpenFileDialogOptions) =>
    ipcRenderer.invoke(IpcChannel.OpenFileDialog, options) as Promise<OpenFileDialogResult>,
  saveFileDialog: (options: SaveFileDialogOptions) =>
    ipcRenderer.invoke(IpcChannel.SaveFileDialog, options) as Promise<SaveFileDialogResult>,
  readFile: (path) =>
    ipcRenderer.invoke(IpcChannel.ReadFile, path) as Promise<OpenedFile>,
  writeFile: (path, bytes) =>
    ipcRenderer.invoke(IpcChannel.WriteFile, path, bytes) as Promise<WriteFileResult>,
  showInFolder: (path) =>
    ipcRenderer.invoke(IpcChannel.ShowInFolder, path) as Promise<void>,
  openSystemSettings: () =>
    ipcRenderer.invoke(IpcChannel.OpenSystemSettings) as Promise<void>,
  getDefaultPdfApp: () =>
    ipcRenderer.invoke(IpcChannel.GetDefaultPdfApp) as Promise<{
      isDefault: boolean;
      currentBundleId: string | null;
    }>,
  setAsDefaultPdfApp: () =>
    ipcRenderer.invoke(IpcChannel.SetAsDefaultPdfApp) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  printWindow: () => ipcRenderer.invoke(IpcChannel.PrintWindow) as Promise<void>,
  printPdfBytes: (bytes, documentName) =>
    ipcRenderer.invoke(IpcChannel.PrintPdfBytes, bytes, documentName) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  getTheme: () => ipcRenderer.invoke(IpcChannel.GetAppTheme) as Promise<AppTheme>,
  onThemeUpdated: (cb) => {
    const listener = (_e: unknown, theme: AppTheme) => cb(theme);
    ipcRenderer.on(IpcChannel.ThemeUpdated, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannel.ThemeUpdated, listener);
    };
  },
  getPathForFile: (file) => {
    const p = webUtils.getPathForFile(file);
    // webUtils only returns a path for File objects that came from a real
    // OS drag-drop; synthetic JS-constructed File objects get `undefined`.
    // So this bless can't be used to widen the allowlist — only real drops
    // reach it, and real drops are legitimate user intent.
    if (p) ipcRenderer.sendSync(IpcChannel.BlessDropPath, p);
    return p;
  },
  signature: {
    get: () => ipcRenderer.invoke(IpcChannel.SignatureGet) as Promise<string | null>,
    set: (dataUrl: string) =>
      ipcRenderer.invoke(IpcChannel.SignatureSet, dataUrl) as Promise<void>,
    clear: () => ipcRenderer.invoke(IpcChannel.SignatureClear) as Promise<void>,
  },
  onMenuCommand: (cb) => {
    const listener = (_e: unknown, cmd: MenuCommand) => cb(cmd);
    ipcRenderer.on(IpcChannel.MenuCommand, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannel.MenuCommand, listener);
    };
  },
  onOpenFilePath: (cb) => {
    const listener = (_e: unknown, path: string) => cb(path);
    ipcRenderer.on(IpcChannel.OpenFilePath, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannel.OpenFilePath, listener);
    };
  },
  window: {
    minimize: () => ipcRenderer.send(IpcChannel.WindowMinimize),
    maximize: () => ipcRenderer.send(IpcChannel.WindowMaximize),
    close: () => ipcRenderer.send(IpcChannel.WindowClose),
  },
  ocr: {
    available: () => ipcRenderer.invoke(IpcChannel.OcrAvailable) as Promise<boolean>,
    runImage: (pngBytes: ArrayBuffer) =>
      ipcRenderer.invoke(IpcChannel.OcrRunImage, pngBytes) as Promise<OcrBox[]>,
  },
  qpdf: {
    available: () => ipcRenderer.invoke(IpcChannel.QpdfAvailable) as Promise<boolean>,
    decrypt: (bytes: ArrayBuffer, password: string) =>
      ipcRenderer.invoke(IpcChannel.QpdfDecrypt, bytes, password) as Promise<ArrayBuffer>,
    encrypt: (bytes: ArrayBuffer, userPassword: string, ownerPassword?: string) =>
      ipcRenderer.invoke(IpcChannel.QpdfEncrypt, bytes, userPassword, ownerPassword) as Promise<ArrayBuffer>,
  },
  ghostscript: {
    available: () => ipcRenderer.invoke(IpcChannel.GhostscriptAvailable) as Promise<boolean>,
    compress: (bytes: ArrayBuffer, quality: "screen" | "ebook" | "printer" | "prepress") =>
      ipcRenderer.invoke(IpcChannel.GhostscriptCompress, bytes, quality) as Promise<ArrayBuffer>,
    compressAdvanced: (bytes, opts) =>
      ipcRenderer.invoke(IpcChannel.GhostscriptCompressAdvanced, bytes, opts) as Promise<ArrayBuffer>,
  },
  qpdfCompress: (bytes: ArrayBuffer) =>
    ipcRenderer.invoke(IpcChannel.QpdfCompress, bytes) as Promise<ArrayBuffer>,
  mutool: {
    available: () => ipcRenderer.invoke(IpcChannel.MutoolAvailable) as Promise<boolean>,
    clean: (bytes: ArrayBuffer) =>
      ipcRenderer.invoke(IpcChannel.MutoolClean, bytes) as Promise<ArrayBuffer>,
  },
  convertDocToPdf: (bytes: ArrayBuffer, filename: string) =>
    ipcRenderer.invoke(IpcChannel.ConvertDocToPdf, bytes, filename) as Promise<ArrayBuffer>,
  convertTextToDocx: (text: string) =>
    ipcRenderer.invoke(IpcChannel.ConvertTextToDocx, text) as Promise<ArrayBuffer>,
  digitalSig: {
    genCert: (params: { name: string; email: string; org?: string; years?: number }) =>
      ipcRenderer.invoke(IpcChannel.SigGenCert, params) as Promise<DigitalCertInfo>,
    hasCert: () => ipcRenderer.invoke(IpcChannel.SigHasCert) as Promise<boolean>,
    getCertInfo: () => ipcRenderer.invoke(IpcChannel.SigGetCertInfo) as Promise<DigitalCertInfo | null>,
    clearCert: () => ipcRenderer.invoke(IpcChannel.SigClearCert) as Promise<void>,
    signPdf: (bytes: ArrayBuffer, opts?: { reason?: string; location?: string }) =>
      ipcRenderer.invoke(IpcChannel.SigSignPdf, bytes, opts ?? {}) as Promise<ArrayBuffer>,
  },
  ai: {
    available: () => ipcRenderer.invoke(IpcChannel.AiAvailable) as Promise<boolean>,
    run: (mode: "summarize" | "qa" | "rewrite", text: string, extra?: string) =>
      ipcRenderer.invoke(IpcChannel.AiRun, mode, text, extra) as Promise<string>,
  },
  blessDerivedPath: (source: string, derived: string) =>
    ipcRenderer.invoke(IpcChannel.BlessDerivedPath, source, derived) as Promise<boolean>,
  drafts: {
    save: (manifest: import("../shared/ipc").DraftManifest, currentBytes: ArrayBuffer | null) =>
      ipcRenderer.invoke(IpcChannel.DraftsSave, manifest, currentBytes) as Promise<void>,
    load: (draftKey: string) =>
      ipcRenderer.invoke(IpcChannel.DraftsLoad, draftKey) as Promise<import("../shared/ipc").DraftRecord | null>,
    clear: (draftKey: string) =>
      ipcRenderer.invoke(IpcChannel.DraftsClear, draftKey) as Promise<void>,
    list: () =>
      ipcRenderer.invoke(IpcChannel.DraftsList) as Promise<import("../shared/ipc").DraftManifest[]>,
  },
  platform: process.platform,
};

// Test-only bless helper. Gated on the same VITE_E2E flag that enables the
// test hook in the renderer. In a production build the `if` is dead code —
// Vite replaces `import.meta.env.VITE_E2E` at build time, so a production
// bundle contains literally `if ("" === "1") { ... }`.
const exposed = api as unknown as Record<string, unknown>;
if (import.meta.env.VITE_E2E === "1") {
  exposed.__testBless = (p: string) => ipcRenderer.invoke(IpcChannel.TestBlessPath, p);
}

contextBridge.exposeInMainWorld("weavepdf", exposed);
