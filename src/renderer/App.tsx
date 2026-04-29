import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTheme } from "./hooks/useTheme";
import { rebasePendingEditSeq, useDocumentStore } from "./stores/document";
import { useUIStore } from "./stores/ui";
import { pdfjsLib, initPdfWorker } from "./lib/pdfjs";
// pdf-ops is lazy-loaded at use sites so the pdf-lib chunk (~425 KB) doesn't
// pull at boot. Each helper is awaited in its callback.
const loadPdfOps = () => import("./lib/pdf-ops");
// Components rendered on the critical-path of cold launch — kept as static
// imports so they're in the initial bundle and parse during the first paint.
import { Titlebar } from "./components/Titlebar/Titlebar";
import { Toolstrip } from "./components/Toolstrip/Toolstrip";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { Viewer } from "./components/Viewer/Viewer";
import { DropZone } from "./components/DropZone/DropZone";
import { SearchBar } from "./components/Search/SearchBar";
import { CommandPalette, type PaletteAction } from "./components/CommandPalette/CommandPalette";
import { ContextMenu } from "./components/ContextMenu/ContextMenu";
import { LinkPopover } from "./components/LinkPopover/LinkPopover";
import { DefaultPdfBanner } from "./components/DefaultPdfBanner/DefaultPdfBanner";

// Modal components — rendered conditionally based on `*Open` state in the ui
// store. None of them are visible at boot, so we lazy-load each so its bundle
// isn't parsed during the cold-launch critical path. Each lazy import is
// wrapped in <Suspense fallback={null}> at render time. The fallback is null
// because the modal is closed (open=false) during the wait — there's nothing
// to substitute. First open of each modal pays a one-shot ~10-30 ms parse
// cost on a warm worker; the cold-launch saving is far larger.
const CompressModal = lazy(() =>
  import("./components/CompressModal/CompressModal").then((m) => ({ default: m.CompressModal })),
);
const SignatureModal = lazy(() =>
  import("./components/SignatureModal/SignatureModal").then((m) => ({ default: m.SignatureModal })),
);
const MetadataModal = lazy(() =>
  import("./components/MetadataModal/MetadataModal").then((m) => ({ default: m.MetadataModal })),
);
const WatermarkModal = lazy(() =>
  import("./components/WatermarkModal/WatermarkModal").then((m) => ({ default: m.WatermarkModal })),
);
const ExtractModal = lazy(() =>
  import("./components/ExtractModal/ExtractModal").then((m) => ({ default: m.ExtractModal })),
);
const CropModal = lazy(() =>
  import("./components/CropModal/CropModal").then((m) => ({ default: m.CropModal })),
);
const HeaderFooterModal = lazy(() =>
  import("./components/HeaderFooterModal/HeaderFooterModal").then((m) => ({
    default: m.HeaderFooterModal,
  })),
);
const FormFillModal = lazy(() =>
  import("./components/FormFillModal/FormFillModal").then((m) => ({ default: m.FormFillModal })),
);
const BatchModal = lazy(() =>
  import("./components/BatchModal/BatchModal").then((m) => ({ default: m.BatchModal })),
);
const OcrModal = lazy(() =>
  import("./components/OcrModal/OcrModal").then((m) => ({ default: m.OcrModal })),
);
const AiModal = lazy(() =>
  import("./components/AiModal/AiModal").then((m) => ({ default: m.AiModal })),
);
const DigitalSignModal = lazy(() =>
  import("./components/DigitalSignModal/DigitalSignModal").then((m) => ({
    default: m.DigitalSignModal,
  })),
);
const PasswordModal = lazy(() =>
  import("./components/PasswordModal/PasswordModal").then((m) => ({ default: m.PasswordModal })),
);
const RecentDraftsModal = lazy(() =>
  import("./components/RecentDraftsModal/RecentDraftsModal").then((m) => ({
    default: m.RecentDraftsModal,
  })),
);
const RestoreDraftModal = lazy(() =>
  import("./components/RestoreDraftModal/RestoreDraftModal").then((m) => ({
    default: m.RestoreDraftModal,
  })),
);
const PageLayoutModal = lazy(() =>
  import("./components/PageLayoutModal/PageLayoutModal").then((m) => ({
    default: m.PageLayoutModal,
  })),
);
const PromptModal = lazy(() =>
  import("./components/PromptModal/PromptModal").then((m) => ({ default: m.PromptModal })),
);
const ShortcutHelpModal = lazy(() =>
  import("./components/ShortcutHelpModal/ShortcutHelpModal").then((m) => ({
    default: m.ShortcutHelpModal,
  })),
);
const WelcomeModal = lazy(() =>
  import("./components/WelcomeModal/WelcomeModal").then((m) => ({ default: m.WelcomeModal })),
);
import { useDraftPersistence } from "./hooks/useDraftPersistence";
import { bytesToBlob, u8ToAb } from "../shared/buffers";
import type {
  DraftManifest,
  DraftRecord,
} from "../shared/ipc";
import type {
  PendingImageEdit,
  PendingShapeEdit,
  PendingTextEdit,
} from "./stores/document";

type LoadedPayload = {
  name: string;
  path: string | null;
  sizeBytes: number;
  bytes: Uint8Array;
};

function isPasswordError(err: unknown): boolean {
  if (!err) return false;
  const name = (err as { name?: string }).name ?? "";
  const msg = (err as { message?: string }).message ?? "";
  return name === "PasswordException" || /password/i.test(msg);
}

function tabHasPendingEdits(tab: {
  pendingTextEdits: unknown[];
  pendingImageEdits: unknown[];
  pendingShapeEdits: unknown[];
}): boolean {
  return (
    tab.pendingTextEdits.length > 0 ||
    tab.pendingImageEdits.length > 0 ||
    tab.pendingShapeEdits.length > 0
  );
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  const el =
    target instanceof HTMLElement
      ? target
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

// localStorage key that tracks whether the user has dismissed the first-launch
// onboarding modal. Set on close (any path), checked on App mount.
const WELCOME_FLAG = "weavepdf-welcomed";

export function App() {
  useTheme();

  const tabs = useDocumentStore((s) => s.tabs);
  const addTab = useDocumentStore((s) => s.addTab);
  const addBlankTab = useDocumentStore((s) => s.addBlankTab);
  const activeTab = useDocumentStore((s) => s.activeTab());
  const setCurrentPage = useDocumentStore((s) => s.setCurrentPage);
  const setZoom = useDocumentStore((s) => s.setZoom);
  const applyEdit = useDocumentStore((s) => s.applyEdit);
  const undo = useDocumentStore((s) => s.undo);
  const selectAllPages = useDocumentStore((s) => s.selectAllPages);
  const clearSelection = useDocumentStore((s) => s.clearSelection);
  const markClean = useDocumentStore((s) => s.markClean);
  const commitAllPending = useDocumentStore((s) => s.commitAllPending);
  const addPendingTextEdit = useDocumentStore((s) => s.addPendingTextEdit);
  const addPendingImageEdit = useDocumentStore((s) => s.addPendingImageEdit);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const openSearch = useUIStore((s) => s.openSearch);
  const closeSearch = useUIStore((s) => s.closeSearch);
  const searchOpen = useUIStore((s) => s.searchOpen);
  const paletteOpen = useUIStore((s) => s.paletteOpen);
  const openPalette = useUIStore((s) => s.openPalette);
  const closePalette = useUIStore((s) => s.closePalette);
  const compressOpen = useUIStore((s) => s.compressOpen);
  const openCompress = useUIStore((s) => s.openCompress);
  const closeCompress = useUIStore((s) => s.closeCompress);
  const signatureOpen = useUIStore((s) => s.signatureOpen);
  const openSignature = useUIStore((s) => s.openSignature);
  const closeSignature = useUIStore((s) => s.closeSignature);
  const metadataOpen = useUIStore((s) => s.metadataOpen);
  const openMetadata = useUIStore((s) => s.openMetadata);
  const closeMetadata = useUIStore((s) => s.closeMetadata);
  const watermarkOpen = useUIStore((s) => s.watermarkOpen);
  const openWatermark = useUIStore((s) => s.openWatermark);
  const closeWatermark = useUIStore((s) => s.closeWatermark);
  const extractOpen = useUIStore((s) => s.extractOpen);
  const openExtract = useUIStore((s) => s.openExtract);
  const closeExtract = useUIStore((s) => s.closeExtract);
  const cropOpen = useUIStore((s) => s.cropOpen);
  const openCrop = useUIStore((s) => s.openCrop);
  const closeCrop = useUIStore((s) => s.closeCrop);
  const headerFooterOpen = useUIStore((s) => s.headerFooterOpen);
  const openHeaderFooter = useUIStore((s) => s.openHeaderFooter);
  const closeHeaderFooter = useUIStore((s) => s.closeHeaderFooter);
  const formFillOpen = useUIStore((s) => s.formFillOpen);
  const openFormFill = useUIStore((s) => s.openFormFill);
  const closeFormFill = useUIStore((s) => s.closeFormFill);
  const batchOpen = useUIStore((s) => s.batchOpen);
  const openBatch = useUIStore((s) => s.openBatch);
  const closeBatch = useUIStore((s) => s.closeBatch);
  const ocrOpen = useUIStore((s) => s.ocrOpen);
  const openOcr = useUIStore((s) => s.openOcr);
  const closeOcr = useUIStore((s) => s.closeOcr);
  const digitalSignOpen = useUIStore((s) => s.digitalSignOpen);
  const openDigitalSign = useUIStore((s) => s.openDigitalSign);
  const closeDigitalSign = useUIStore((s) => s.closeDigitalSign);
  const aiOpen = useUIStore((s) => s.aiOpen);
  const openAi = useUIStore((s) => s.openAi);
  const closeAi = useUIStore((s) => s.closeAi);
  const recentDraftsOpen = useUIStore((s) => s.recentDraftsOpen);
  const openRecentDrafts = useUIStore((s) => s.openRecentDrafts);
  const closeRecentDrafts = useUIStore((s) => s.closeRecentDrafts);
  const pageLayoutOpen = useUIStore((s) => s.pageLayoutOpen);
  const openPageLayout = useUIStore((s) => s.openPageLayout);
  const closePageLayout = useUIStore((s) => s.closePageLayout);
  const shortcutHelpOpen = useUIStore((s) => s.shortcutHelpOpen);
  const openShortcutHelp = useUIStore((s) => s.openShortcutHelp);
  const closeShortcutHelp = useUIStore((s) => s.closeShortcutHelp);
  const welcomeOpen = useUIStore((s) => s.welcomeOpen);
  const welcomeInitialStep = useUIStore((s) => s.welcomeInitialStep);
  const openWelcome = useUIStore((s) => s.openWelcome);
  const closeWelcome = useUIStore((s) => s.closeWelcome);
  const contextMenuOpen = useUIStore((s) => !!s.contextMenu);
  const openImagePicker = useUIStore((s) => s.openImagePicker);
  const setTool = useUIStore((s) => s.setTool);
  const setViewMode = useUIStore((s) => s.setViewMode);
  const setMeasureScale = useUIStore((s) => s.setMeasureScale);
  const [measurePromptOpen, setMeasurePromptOpen] = useState(false);

  // Quick calibration prompt for the measurement tool. Asks the user how
  // long a known reference is, then sets unitsPerPoint so future drags read
  // as real-world distance. The tool defaults to raw points if uncalibrated.
  const calibrateMeasure = useCallback(() => {
    setMeasurePromptOpen(true);
  }, []);

  const applyMeasureCalibration = useCallback((known: string) => {
    const m = known.match(/^([\d.]+)\s*([a-zA-Z]+)$/);
    if (!m) return;
    const value = parseFloat(m[1]);
    const unit = m[2];
    setMeasureScale({ unitsPerPoint: value / 72, unit });
  }, [setMeasureScale]);

  useEffect(() => {
    initPdfWorker();
  }, []);

  // Onboarding: auto-open the WelcomeModal on first launch. The flag persists
  // in localStorage so subsequent launches go straight to the empty state.
  // Re-opening the welcome any time later is wired through the Help menu and
  // the Command Palette ("Show welcome…"); both call openWelcome() directly.
  //
  // Defer past first paint so the modal mount + render doesn't compete for
  // cold-launch resources. The modal appearing ~150 ms after window paint is
  // imperceptible to the user; freeing that work during boot is measurable.
  useEffect(() => {
    if (localStorage.getItem(WELCOME_FLAG)) return;
    type IdleWin = Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const w = window as IdleWin;
    let idleId: number | undefined;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    if (typeof w.requestIdleCallback === "function") {
      idleId = w.requestIdleCallback(() => openWelcome(), { timeout: 1000 });
    } else {
      timerId = setTimeout(() => openWelcome(), 150);
    }
    return () => {
      if (idleId !== undefined && typeof w.cancelIdleCallback === "function") {
        w.cancelIdleCallback(idleId);
      }
      if (timerId !== undefined) clearTimeout(timerId);
    };
  }, [openWelcome]);

  const handleCloseWelcome = useCallback(() => {
    try {
      localStorage.setItem(WELCOME_FLAG, "1");
    } catch {
      // Storage might be denied in private mode or quota-exceeded; the
      // welcome will simply re-show next launch. Not worth alerting about.
    }
    closeWelcome();
  }, [closeWelcome]);

  // Autosave every dirty tab to disk so the user can resume after closing
  // the tab or quitting the app.
  useDraftPersistence();

  // When loadAsTab finds an autosaved draft for a path being opened, it
  // surfaces here so the user can choose Restore / Open original / Cancel.
  // The promise resolver lets the caller wait for the user's pick.
  const [restorePrompt, setRestorePrompt] = useState<{
    manifest: DraftManifest;
    record: DraftRecord;
    resolve: (choice: "restore" | "discard" | "cancel") => void;
  } | null>(null);

  // Password-prompt state. When `loadAsTab` hits an encrypted PDF it stashes
  // the original bytes + filename + a pair of resolver callbacks here; the
  // PasswordModal consumes them, calls qpdf.decrypt, and returns the plaintext
  // bytes. We then load those bytes normally.
  const [passwordPrompt, setPasswordPrompt] = useState<{
    bytes: Uint8Array;
    name: string;
    resolve: (bytes: Uint8Array | null) => void;
  } | null>(null);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  // Rehydrate a tab from a draft record. `payload` is the freshly-read disk
  // bytes (only used as a fallback when the draft has no committed PDF
  // bytes — i.e. the user only had pending overlays). For pure virtual
  // drafts (no source path) callers pass payload=null.
  const openTabFromDraft = useCallback(
    async (record: DraftRecord, payload: LoadedPayload | null) => {
      const m = record.manifest;
      // Pick which bytes to seed: the committed-current.pdf when present,
      // otherwise fall back to the disk bytes that were just opened.
      const seedAb = record.currentBytes ?? (payload ? u8ToAb(payload.bytes) : null);
      if (!seedAb) {
        alert(
          `Couldn't restore ${m.originalName}: the draft has no bytes and no source file is available.`,
        );
        return;
      }
      const bytes = new Uint8Array(seedAb);
      let pdf;
      try {
        pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      } catch (err) {
        alert(`Couldn't restore ${m.originalName}: ${(err as Error).message ?? err}`);
        return;
      }

      const tabId = addTab({
        name: m.originalName,
        path: m.sourcePath,
        // Reuse the same draftKey so the autosave hook keeps writing to
        // the same slot instead of forking on UUID change.
        draftKey: m.draftKey,
        sizeBytes: bytes.byteLength,
        bytes,
        pdf,
        numPages: pdf.numPages,
      });

      // V1.0020: rebase the per-process pending-edit sequence above every
      // restored createdAt BEFORE re-adding them, so brand-new edits made
      // in this session sort AFTER the restored ones for undo. Without
      // this, ⌘Z would peel off a restored sticky/shape instead of the
      // most recent freshly-drawn one (the new one starts at seq=1, the
      // restored ones carry seq=15..47 from the previous session).
      const allCreatedAt: Array<number | undefined> = [
        ...m.pendingTextEdits.map((t) => (t as PendingTextEdit).createdAt),
        ...m.pendingImageEdits.map((i) => (i as PendingImageEdit).createdAt),
        ...m.pendingShapeEdits.map((s) => (s as PendingShapeEdit).createdAt),
      ];
      rebasePendingEditSeq(...allCreatedAt);

      // Replay pending overlays so the user sees exactly what they left.
      const store = useDocumentStore.getState();
      for (const t of m.pendingTextEdits as PendingTextEdit[]) {
        const { id: _id, ...rest } = t;
        void _id;
        store.addPendingTextEdit(tabId, rest);
      }
      for (const raw of m.pendingImageEdits as Array<
        Omit<PendingImageEdit, "bytes"> & { bytes: string | Uint8Array }
      >) {
        const { id: _id, bytes: rawBytes, ...rest } = raw;
        void _id;
        const decoded =
          typeof rawBytes === "string"
            ? base64ToUint8Array(rawBytes)
            : new Uint8Array(rawBytes);
        store.addPendingImageEdit(tabId, { ...rest, bytes: decoded });
      }
      for (const s of m.pendingShapeEdits as PendingShapeEdit[]) {
        const { id: _id, ...rest } = s;
        void _id;
        store.addPendingShapeEdit(tabId, rest);
      }

      // Restore page + zoom last so it isn't clobbered by the addTab default.
      store.setCurrentPage(tabId, m.currentPage);
      store.setZoom(tabId, m.zoom);
    },
    [addTab],
  );

  const loadAsTab = useCallback(
    async (payload: LoadedPayload) => {
      // If we have a real path and an autosaved draft sits in the user's
      // draft slot, prompt before opening — they may want to resume.
      if (payload.path) {
        const existing = await window.weavepdf.drafts.load(payload.path);
        if (existing) {
          const choice = await new Promise<"restore" | "discard" | "cancel">(
            (resolve) => {
              setRestorePrompt({ manifest: existing.manifest, record: existing, resolve });
            },
          );
          if (choice === "cancel") return;
          if (choice === "restore") {
            await openTabFromDraft(existing, payload);
            return;
          }
          // Discard fall-through: clear the slot, then continue to a clean open.
          await window.weavepdf.drafts.clear(payload.path);
        }
      }

      let bytes = payload.bytes;
      // V1.0020: explicit flag instead of `bytes === payload.bytes` identity
      // check below. The identity comparison silently flipped to `false` if
      // anyone added a defensive `bytes = bytes.slice()` above this line —
      // and that would have routed the next ⌘S over the encrypted original
      // with the unencrypted copy (Critical Rule #6 violation).
      let wasDecrypted = false;
      let pdf;
      try {
        pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      } catch (err) {
        if (!isPasswordError(err)) throw err;
        // Encrypted — prompt for password and decrypt via qpdf.
        const qpdfOk = await window.weavepdf.qpdf.available();
        if (!qpdfOk) {
          alert(
            `${payload.name} is password-protected. Install qpdf first:\n\n  brew install qpdf\n\nThen reopen the file.`,
          );
          return;
        }
        const decrypted = await new Promise<Uint8Array | null>((resolve) => {
          setPasswordError(null);
          setPasswordPrompt({ bytes, name: payload.name, resolve });
        });
        if (!decrypted) return; // user canceled
        bytes = decrypted;
        wasDecrypted = true;
        pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      }
      addTab({
        name: payload.name,
        // Decrypted files drop the original path so ⌘S routes to Save-As —
        // prevents overwriting the encrypted original with an unencrypted copy.
        path: wasDecrypted ? null : payload.path,
        sizeBytes: bytes.byteLength,
        bytes,
        pdf,
        numPages: pdf.numPages,
      });
    },
    [addTab, openTabFromDraft],
  );

  const handleRestoreFromList = useCallback(
    async (m: DraftManifest) => {
      const record = await window.weavepdf.drafts.load(m.draftKey);
      if (!record) {
        alert(`Couldn't load draft for ${m.originalName}.`);
        return;
      }
      // For path-keyed drafts, also read the disk bytes as a fallback so
      // pending-only drafts (no committed bytes) can still be restored.
      let payload: LoadedPayload | null = null;
      if (m.sourcePath) {
        try {
          const file = await window.weavepdf.readFile(m.sourcePath);
          payload = {
            name: file.name,
            path: file.path,
            sizeBytes: file.sizeBytes,
            bytes: new Uint8Array(file.data),
          };
        } catch {
          // Disk file may have moved/been deleted — restore from currentBytes only.
          payload = null;
        }
      }
      await openTabFromDraft(record, payload);
    },
    [openTabFromDraft],
  );

  const openFile = useCallback(async () => {
    const result = await window.weavepdf.openFileDialog({
      filters: [
        { name: "PDF, Images, Docs", extensions: ["pdf", "png", "jpg", "jpeg", "heic", "heif", "docx", "doc", "rtf"] },
        { name: "PDF", extensions: ["pdf"] },
        { name: "Images", extensions: ["png", "jpg", "jpeg", "heic", "heif"] },
        { name: "Word / RTF", extensions: ["docx", "doc", "rtf"] },
      ],
      multi: true,
    });
    if (result.canceled) return;
    for (const file of result.files) {
      const bytes = new Uint8Array(file.data);
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      try {
        if (ext === "pdf") {
          await loadAsTab({
            name: file.name,
            path: file.path,
            sizeBytes: file.sizeBytes,
            bytes,
          });
        } else if (DOC_EXTS.includes(ext as (typeof DOC_EXTS)[number])) {
          const pdfBytes = await convertDocBytesToPdf(bytes, file.name);
          await loadAsTab({
            name: file.name.replace(/\.[^.]+$/, ".pdf"),
            path: null,
            sizeBytes: pdfBytes.byteLength,
            bytes: pdfBytes,
          });
        } else if (["png", "jpg", "jpeg", "heic", "heif"].includes(ext)) {
          const pdfBytes = await convertImageBytesToPdf(bytes, ext);
          await loadAsTab({
            name: file.name.replace(/\.[^.]+$/, ".pdf"),
            path: null,
            sizeBytes: pdfBytes.byteLength,
            bytes: pdfBytes,
          });
        } else {
          alert(`Unsupported file type: ${file.name}`);
        }
      } catch (err) {
        alert(`Couldn't open ${file.name}: ${(err as Error).message ?? err}`);
      }
    }
  }, [loadAsTab]);

  const saveCurrent = useCallback(
    async (forceSaveAs: boolean) => {
      if (!activeTab?.bytes) return;
      // Bake any floating text edits into the PDF before writing to disk.
      await commitAllPending(activeTab.id);
      const refreshed = useDocumentStore.getState().tabs.find((t) => t.id === activeTab.id);
      if (!refreshed?.bytes) return;
      let targetPath = refreshed.path;
      const mustPrompt = forceSaveAs || !targetPath || !refreshed.saveInPlace;
      if (mustPrompt) {
        const suggested = refreshed.name.replace(/\.[^.]+$/, "") + ".pdf";
        const result = await window.weavepdf.saveFileDialog({
          title: forceSaveAs ? "Save As" : "Save",
          suggestedName: suggested,
          extensions: ["pdf"],
        });
        if (result.canceled) return;
        targetPath = result.path;
      }
      if (!targetPath) return;
      const result = await window.weavepdf.writeFile(targetPath, toArrayBuffer(refreshed.bytes));
      if (result.ok) {
        markClean(refreshed.id, targetPath);
      } else {
        alert(`Save failed: ${result.error}`);
      }
    },
    [activeTab, markClean, commitAllPending],
  );

  const exportCombined = useCallback(async () => {
    if (tabs.length === 0) return;
    // Export should match save/print output, so commit any floating overlays
    // before merging tabs together.
    for (const t of tabs) {
      if (tabHasPendingEdits(t)) {
        await commitAllPending(t.id);
      }
    }
    const freshTabs = useDocumentStore.getState().tabs;
    const sources = freshTabs.filter((t) => t.bytes).map((t) => t.bytes!);
    if (sources.length === 0) return;
    const { mergePdfs } = await loadPdfOps();
    const merged = sources.length === 1 ? sources[0] : await mergePdfs(sources);
    const result = await window.weavepdf.saveFileDialog({
      title: "Export Combined PDF",
      suggestedName: freshTabs.length === 1 ? freshTabs[0].name : "Combined.pdf",
      extensions: ["pdf"],
    });
    if (result.canceled) return;
    const write = await window.weavepdf.writeFile(result.path, toArrayBuffer(merged));
    if (!write.ok) {
      alert(`Export failed: ${write.error}`);
    }
  }, [tabs, commitAllPending]);

  const printCurrent = useCallback(async () => {
    const at = useDocumentStore.getState().activeTab();
    if (!at) return;
    try {
      if (tabHasPendingEdits(at)) await commitAllPending(at.id);
      await window.weavepdf.printWindow();
    } catch (err) {
      alert(`Print failed: ${(err as Error).message ?? err}`);
    }
  }, [commitAllPending]);

  const deleteSelected = useCallback(async () => {
    if (!activeTab?.bytes || activeTab.selectedPages.size === 0) return;
    if (activeTab.selectedPages.size === activeTab.numPages) {
      const confirmed = window.confirm(
        `You can't delete every page. Close this document instead?\n\n(${activeTab.name})`,
      );
      if (confirmed) {
        useDocumentStore.getState().closeTab(activeTab.id);
      }
      return;
    }
    const pages = Array.from(activeTab.selectedPages).sort((a, b) => a - b);
    const { deletePages } = await loadPdfOps();
    const newBytes = await deletePages(activeTab.bytes, pages);
    await applyEdit(activeTab.id, newBytes);
  }, [activeTab, applyEdit]);

  const [encryptPrompt, setEncryptPrompt] = useState<{ name: string } | null>(null);
  const [encryptBusy, setEncryptBusy] = useState(false);
  const [encryptError, setEncryptError] = useState<string | null>(null);

  const encryptPdf = useCallback(async () => {
    if (!activeTab?.bytes) return;
    const qpdfOk = await window.weavepdf.qpdf.available();
    if (!qpdfOk) {
      alert("Install qpdf first:\n\n  brew install qpdf");
      return;
    }
    setEncryptError(null);
    setEncryptPrompt({ name: activeTab.name });
  }, [activeTab]);

  const runEncrypt = async (password: string) => {
    if (!activeTab?.bytes) return;
    setEncryptBusy(true);
    setEncryptError(null);
    try {
      await commitAllPending(activeTab.id);
      const fresh = useDocumentStore.getState().tabs.find((t) => t.id === activeTab.id);
      if (!fresh?.bytes) return;
      const result = await window.weavepdf.saveFileDialog({
        title: "Save encrypted PDF",
        suggestedName: fresh.name.replace(/\.pdf$/i, "") + "-encrypted.pdf",
        extensions: ["pdf"],
      });
      if (result.canceled) {
        setEncryptPrompt(null);
        return;
      }
      const encrypted = await window.weavepdf.qpdf.encrypt(u8ToAb(fresh.bytes), password);
      const w = await window.weavepdf.writeFile(result.path, encrypted);
      if (!w.ok) {
        setEncryptError(w.error);
        return;
      }
      setEncryptPrompt(null);
    } catch (err) {
      setEncryptError((err as Error).message ?? String(err));
    } finally {
      setEncryptBusy(false);
    }
  };

  const exportDocx = useCallback(async () => {
    if (!activeTab?.bytes) return;
    await commitAllPending(activeTab.id);
    const fresh = useDocumentStore.getState().tabs.find((t) => t.id === activeTab.id);
    if (!fresh?.bytes) return;
    const result = await window.weavepdf.saveFileDialog({
      title: "Export as Word document",
      suggestedName: fresh.name.replace(/\.[^.]+$/, "") + ".docx",
      extensions: ["docx"],
    });
    if (result.canceled) return;
    try {
      const { pdfToMarkdown } = await loadPdfOps();
      const md = await pdfToMarkdown(fresh.bytes);
      // Strip markdown scaffolding — `##` / `###` become plain text. textutil
      // will paragraph-break on blank lines already, which is enough for an
      // editable Word doc out of pdf.js's text stream.
      const plain = md
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const docxAb = await window.weavepdf.convertTextToDocx(plain);
      const w = await window.weavepdf.writeFile(result.path, docxAb);
      if (!w.ok) alert(`Save failed: ${w.error}`);
    } catch (err) {
      alert(`Word export failed: ${(err as Error).message ?? err}`);
    }
  }, [activeTab, commitAllPending]);

  const exportMarkdown = useCallback(async () => {
    if (!activeTab?.bytes) return;
    await commitAllPending(activeTab.id);
    const fresh = useDocumentStore.getState().tabs.find((t) => t.id === activeTab.id);
    if (!fresh?.bytes) return;
    const result = await window.weavepdf.saveFileDialog({
      title: "Export as Markdown",
      suggestedName: fresh.name.replace(/\.[^.]+$/, "") + ".md",
      extensions: ["md"],
    });
    if (result.canceled) return;
    try {
      const { pdfToMarkdown } = await loadPdfOps();
      const md = await pdfToMarkdown(fresh.bytes);
      const ab = u8ToAb(new TextEncoder().encode(md));
      const w = await window.weavepdf.writeFile(result.path, ab);
      if (!w.ok) alert(`Markdown export failed: ${w.error}`);
    } catch (err) {
      alert(`Markdown export failed: ${(err as Error).message ?? err}`);
    }
  }, [activeTab, commitAllPending]);

  const rotateSelected = useCallback(
    async (delta: 90 | -90 | 180) => {
      if (!activeTab?.bytes) return;
      const targets =
        activeTab.selectedPages.size > 0
          ? Array.from(activeTab.selectedPages)
          : [activeTab.currentPage];
      const { rotatePages } = await loadPdfOps();
      const newBytes = await rotatePages(activeTab.bytes, targets, delta);
      await applyEdit(activeTab.id, newBytes);
    },
    [activeTab, applyEdit],
  );

  const featureShortcutBlocked =
    searchOpen ||
    paletteOpen ||
    compressOpen ||
    signatureOpen ||
    metadataOpen ||
    watermarkOpen ||
    extractOpen ||
    cropOpen ||
    headerFooterOpen ||
    formFillOpen ||
    batchOpen ||
    ocrOpen ||
    digitalSignOpen ||
    aiOpen ||
    recentDraftsOpen ||
    pageLayoutOpen ||
    shortcutHelpOpen ||
    welcomeOpen ||
    contextMenuOpen ||
    measurePromptOpen ||
    !!restorePrompt ||
    !!passwordPrompt ||
    !!encryptPrompt;

  const canRunFeatureShortcut = useCallback(
    (e: KeyboardEvent, needsTab = true) => {
      if (isEditableShortcutTarget(e.target)) return false;
      if (featureShortcutBlocked) return false;
      if (needsTab && !useDocumentStore.getState().activeTab()) return false;
      return true;
    },
    [featureShortcutBlocked],
  );

  const toggleShortcutTool = useCallback(
    (next: Parameters<typeof setTool>[0]) => {
      const current = useUIStore.getState().tool;
      setTool(current === next ? "none" : next);
    },
    [setTool],
  );

  useHotkeys("mod+k", (e) => {
    e.preventDefault();
    openPalette();
  });
  useHotkeys("mod+/", (e) => {
    if (isEditableShortcutTarget(e.target)) return;
    e.preventDefault();
    closePalette();
    openShortcutHelp();
  }, undefined, [closePalette, openShortcutHelp]);
  useHotkeys("mod+o", (e) => {
    e.preventDefault();
    void openFile();
  });
  useHotkeys("mod+s", (e) => {
    e.preventDefault();
    void saveCurrent(false);
  });
  useHotkeys("mod+shift+s", (e) => {
    e.preventDefault();
    void saveCurrent(true);
  });
  useHotkeys("mod+e", (e) => {
    e.preventDefault();
    void exportCombined();
  });
  useHotkeys("mod+p", (e) => {
    e.preventDefault();
    void printCurrent();
  });
  useHotkeys("t,e,s,i,n,h,w,x,r,o,l,a,d,k,m,c", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!canRunFeatureShortcut(e)) return;
    e.preventDefault();
    switch (e.key.toLowerCase()) {
      case "t": toggleShortcutTool("text"); break;
      case "e": toggleShortcutTool("editText"); break;
      case "s": openSignature(); break;
      case "i": void openImagePicker(); break;
      case "n": toggleShortcutTool("sticky"); break;
      case "h": toggleShortcutTool("highlight"); break;
      case "w": toggleShortcutTool("whiteout"); break;
      case "x": toggleShortcutTool("redact"); break;
      case "r": toggleShortcutTool("rect"); break;
      case "o": toggleShortcutTool("circle"); break;
      case "l": toggleShortcutTool("line"); break;
      case "a": toggleShortcutTool("arrow"); break;
      case "d": toggleShortcutTool("draw"); break;
      case "k": toggleShortcutTool("link"); break;
      case "m": toggleShortcutTool("measure"); break;
      case "c": openCrop(); break;
    }
  }, undefined, [
    canRunFeatureShortcut,
    toggleShortcutTool,
    openSignature,
    openImagePicker,
    openCrop,
  ]);
  useHotkeys("mod+[,mod+]", (e) => {
    if (!canRunFeatureShortcut(e)) return;
    e.preventDefault();
    void rotateSelected(e.key === "[" ? -90 : 90);
  }, undefined, [canRunFeatureShortcut, rotateSelected]);
  useHotkeys("mod+shift+]", (e) => {
    if (!canRunFeatureShortcut(e)) return;
    e.preventDefault();
    void rotateSelected(180);
  }, undefined, [canRunFeatureShortcut, rotateSelected]);
  useHotkeys("mod+alt+e", (e) => {
    if (!canRunFeatureShortcut(e)) return;
    e.preventDefault();
    openExtract();
  }, undefined, [canRunFeatureShortcut, openExtract]);
  useHotkeys("mod+alt+c", (e) => {
    if (!canRunFeatureShortcut(e)) return;
    e.preventDefault();
    openCompress();
  }, undefined, [canRunFeatureShortcut, openCompress]);
  useHotkeys("mod+alt+w", (e) => {
    if (!canRunFeatureShortcut(e)) return;
    e.preventDefault();
    openWatermark();
  }, undefined, [canRunFeatureShortcut, openWatermark]);
  useHotkeys("mod+alt+p", (e) => {
    if (!canRunFeatureShortcut(e)) return;
    e.preventDefault();
    openHeaderFooter();
  }, undefined, [canRunFeatureShortcut, openHeaderFooter]);
  useHotkeys("mod+i", (e) => {
    if (!canRunFeatureShortcut(e)) return;
    e.preventDefault();
    openMetadata();
  }, undefined, [canRunFeatureShortcut, openMetadata]);
  useHotkeys("mod+alt+l", (e) => {
    if (!canRunFeatureShortcut(e)) return;
    e.preventDefault();
    openPageLayout();
  }, undefined, [canRunFeatureShortcut, openPageLayout]);
  useHotkeys("mod+alt+f", (e) => {
    if (!canRunFeatureShortcut(e)) return;
    e.preventDefault();
    openFormFill();
  }, undefined, [canRunFeatureShortcut, openFormFill]);
  useHotkeys("mod+alt+o", (e) => {
    if (!canRunFeatureShortcut(e)) return;
    e.preventDefault();
    openOcr();
  }, undefined, [canRunFeatureShortcut, openOcr]);
  useHotkeys("mod+alt+d", (e) => {
    if (!canRunFeatureShortcut(e)) return;
    e.preventDefault();
    openDigitalSign();
  }, undefined, [canRunFeatureShortcut, openDigitalSign]);
  useHotkeys("mod+alt+a", (e) => {
    if (!canRunFeatureShortcut(e)) return;
    e.preventDefault();
    openAi();
  }, undefined, [canRunFeatureShortcut, openAi]);
  useHotkeys("mod+alt+k", (e) => {
    if (!canRunFeatureShortcut(e)) return;
    e.preventDefault();
    void encryptPdf();
  }, undefined, [canRunFeatureShortcut, encryptPdf]);
  useHotkeys("mod+alt+m", (e) => {
    if (!canRunFeatureShortcut(e)) return;
    e.preventDefault();
    void exportMarkdown();
  }, undefined, [canRunFeatureShortcut, exportMarkdown]);
  useHotkeys("mod+alt+x", (e) => {
    if (!canRunFeatureShortcut(e)) return;
    e.preventDefault();
    void exportDocx();
  }, undefined, [canRunFeatureShortcut, exportDocx]);
  useHotkeys("mod+alt+b", (e) => {
    if (!canRunFeatureShortcut(e, false)) return;
    e.preventDefault();
    openBatch();
  }, undefined, [canRunFeatureShortcut, openBatch]);
  useHotkeys("mod+alt+r", (e) => {
    if (!canRunFeatureShortcut(e, false)) return;
    e.preventDefault();
    openRecentDrafts();
  }, undefined, [canRunFeatureShortcut, openRecentDrafts]);
  useHotkeys("mod+alt+1,mod+alt+2,mod+alt+3", (e) => {
    if (!canRunFeatureShortcut(e)) return;
    e.preventDefault();
    const n = e.key;
    setViewMode(n === "1" ? "single" : n === "2" ? "spread" : "cover-spread");
  }, undefined, [canRunFeatureShortcut, setViewMode]);
  useHotkeys("mod+z", (e) => {
    e.preventDefault();
    if (activeTab) void undo(activeTab.id);
  });
  useHotkeys("mod+shift+z,mod+y", (e) => {
    e.preventDefault();
    const at = useDocumentStore.getState().activeTab();
    if (at) void useDocumentStore.getState().redo(at.id);
  });
  useHotkeys("mod+a", (e) => {
    const el = document.activeElement as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    e.preventDefault();
    if (activeTab) selectAllPages(activeTab.id);
  });
  useHotkeys("mod+f", (e) => {
    e.preventDefault();
    if (activeTab) openSearch();
  });
  useHotkeys("escape", () => {
    if (searchOpen) {
      closeSearch();
    } else if (activeTab && activeTab.selectedPages.size > 0) {
      clearSelection(activeTab.id);
    } else {
      setTool("none");
    }
  });
  useHotkeys("mod+b", (e) => {
    e.preventDefault();
    toggleSidebar();
  });
  useHotkeys("mod+w", (e) => {
    e.preventDefault();
    if (activeTab) useDocumentStore.getState().closeTab(activeTab.id);
  });
  useHotkeys("mod+1,mod+2,mod+3,mod+4,mod+5,mod+6,mod+7,mod+8,mod+9", (e) => {
    const n = Number(e.key);
    if (Number.isNaN(n)) return;
    e.preventDefault();
    const tab = tabs[n - 1];
    if (tab) useDocumentStore.getState().setActiveTab(tab.id);
  });
  useHotkeys("mod+equal,mod+=,mod+plus", (e) => {
    e.preventDefault();
    if (activeTab) setZoom(activeTab.id, activeTab.zoom * 1.1);
  });
  useHotkeys("mod+minus", (e) => {
    e.preventDefault();
    if (activeTab) setZoom(activeTab.id, activeTab.zoom / 1.1);
  });
  useHotkeys("mod+0", (e) => {
    e.preventDefault();
    if (activeTab) setZoom(activeTab.id, 1);
  });
  useHotkeys("arrowright,pagedown", () => {
    const ui = useUIStore.getState();
    // Yield to any selected pending overlay (image / text / shape).
    if (ui.selectedPendingImageId || ui.selectedPendingTextId || ui.selectedPendingShapeId) return;
    if (activeTab) setCurrentPage(activeTab.id, activeTab.currentPage + 1);
  });
  useHotkeys("arrowleft,pageup", () => {
    const ui = useUIStore.getState();
    if (ui.selectedPendingImageId || ui.selectedPendingTextId || ui.selectedPendingShapeId) return;
    if (activeTab) setCurrentPage(activeTab.id, activeTab.currentPage - 1);
  });
  useHotkeys("backspace,delete", async () => {
    const el = document.activeElement as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    const ui = useUIStore.getState();
    if (ui.selectedPendingImageId || ui.selectedPendingTextId || ui.selectedPendingShapeId) return;
    await deleteSelected();
  });

  const rotateCommand = useCallback(
    (delta: 90 | -90 | 180) => {
      void rotateSelected(delta);
    },
    [rotateSelected],
  );

  // File paths the OS hands us (double-click PDF, Open With, drag on Dock icon).
  useEffect(() => {
    return window.weavepdf.onOpenFilePath(async (filePath) => {
      try {
        const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
        const file = await window.weavepdf.readFile(filePath);
        const bytes = new Uint8Array(file.data);
        if (ext === "pdf") {
          await loadAsTab({
            name: file.name,
            path: file.path,
            sizeBytes: file.sizeBytes,
            bytes,
          });
        } else if (["png", "jpg", "jpeg", "heic", "heif"].includes(ext)) {
          const pdfBytes = await convertImageBytesToPdf(bytes, ext);
          await loadAsTab({
            name: file.name.replace(/\.[^.]+$/, ".pdf"),
            path: null,
            sizeBytes: pdfBytes.byteLength,
            bytes: pdfBytes,
          });
        } else if (DOC_EXTS.includes(ext as (typeof DOC_EXTS)[number])) {
          const pdfBytes = await convertDocBytesToPdf(bytes, file.name);
          await loadAsTab({
            name: file.name.replace(/\.[^.]+$/, ".pdf"),
            path: null,
            sizeBytes: pdfBytes.byteLength,
            bytes: pdfBytes,
          });
        }
      } catch (err) {
        alert(`Couldn't open file: ${(err as Error).message ?? err}`);
      }
    });
  }, [loadAsTab]);

  // Bridge the macOS application menu clicks to renderer actions. Read fresh
  // state inside the handler so the menu always acts on the CURRENT tab /
  // zoom / page, not whatever was active when the listener was bound.
  useEffect(() => {
    return window.weavepdf.onMenuCommand((cmd) => {
      const at = useDocumentStore.getState().activeTab();
      switch (cmd) {
        case "open": void openFile(); break;
        case "save": void saveCurrent(false); break;
        case "saveAs": void saveCurrent(true); break;
        case "export": void exportCombined(); break;
        case "print": void printCurrent(); break;
        case "search": if (at) openSearch(); break;
        case "toggleSidebar": toggleSidebar(); break;
        case "addText": setTool("text"); break;
        case "signature": openSignature(); break;
        case "highlight": setTool("highlight"); break;
        case "whiteout": setTool("whiteout"); break;
        case "shapeRect": setTool("rect"); break;
        case "shapeCircle": setTool("circle"); break;
        case "shapeLine": setTool("line"); break;
        case "shapeArrow": setTool("arrow"); break;
        case "draw": setTool("draw"); break;
        case "compress": openCompress(); break;
        case "watermark": openWatermark(); break;
        case "metadata": openMetadata(); break;
        case "extractPages": openExtract(); break;
        case "rotateLeft": rotateCommand(-90); break;
        case "rotateRight": rotateCommand(90); break;
        case "rotate180": rotateCommand(180); break;
        case "deletePages": void deleteSelected(); break;
        case "selectAllPages": if (at) selectAllPages(at.id); break;
        case "undo": if (at) void undo(at.id); break;
        case "redo": if (at) void useDocumentStore.getState().redo(at.id); break;
        case "zoomIn": if (at) setZoom(at.id, at.zoom * 1.1); break;
        case "zoomOut": if (at) setZoom(at.id, at.zoom / 1.1); break;
        case "zoomReset": if (at) setZoom(at.id, 1); break;
        case "nextPage": if (at) setCurrentPage(at.id, at.currentPage + 1); break;
        case "prevPage": if (at) setCurrentPage(at.id, at.currentPage - 1); break;
        case "palette": openPalette(); break;
        case "keyboardShortcuts": openShortcutHelp(); break;
        case "showWelcome": openWelcome(); break;
        case "showWelcomeFinder": openWelcome(1); break;
        case "newTab": addBlankTab(); break;
      }
    });
    // Intentionally omit activeTab from deps — the handler reads fresh store
    // state on every invocation, so re-subscribing on every tab change is
    // wasted work (and was racy on tab-switch during an in-flight command).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    openFile, saveCurrent, exportCombined, printCurrent, openSearch, toggleSidebar,
    setTool, openSignature, openCompress, rotateCommand, deleteSelected,
    selectAllPages, undo, setZoom, setCurrentPage, openPalette, openShortcutHelp,
    openWelcome, addBlankTab,
  ]);

  // Clipboard paste: drop a text string or image at the centre of the
  // current page as a draggable/resizable pending edit.
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      // Don't hijack paste inside inputs, textareas, or contentEditable fields.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (!activeTab?.pdf) return;
      const cd = e.clipboardData;
      if (!cd) return;

      // Prefer image if one is on the clipboard (screenshots, copied images).
      let imageItem: DataTransferItem | null = null;
      for (const item of Array.from(cd.items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          imageItem = item;
          break;
        }
      }

      if (imageItem) {
        e.preventDefault();
        const blob = imageItem.getAsFile();
        if (!blob) return;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const mime: "image/png" | "image/jpeg" =
          blob.type === "image/jpeg" || blob.type === "image/jpg" ? "image/jpeg" : "image/png";

        // Read intrinsic dims to size the pending overlay at 240pt wide max.
        const url = URL.createObjectURL(blob);
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("paste: image decode failed"));
          img.src = url;
        });
        URL.revokeObjectURL(url);

        const page = await activeTab.pdf.getPage(activeTab.currentPage);
        const vp = page.getViewport({ scale: 1 });
        const maxW = Math.min(240, vp.width * 0.5);
        const w = Math.min(maxW, img.naturalWidth);
        const h = w * (img.naturalHeight / img.naturalWidth);

        addPendingImageEdit(activeTab.id, {
          page: activeTab.currentPage,
          xPt: (vp.width - w) / 2,
          yPt: (vp.height - h) / 2,
          widthPt: w,
          heightPt: h,
          bytes,
          mime,
        });
        return;
      }

      const text = cd.getData("text/plain");
      if (text && text.trim()) {
        e.preventDefault();
        const page = await activeTab.pdf.getPage(activeTab.currentPage);
        const vp = page.getViewport({ scale: 1 });
        const size = 12;
        addPendingTextEdit(activeTab.id, {
          page: activeTab.currentPage,
          xPt: 72, // 1" left margin
          yPt: vp.height - 72 - size, // 1" top margin, baseline
          size,
          text: text.trim(),
        });
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [activeTab, addPendingImageEdit, addPendingTextEdit]);

  // Accept files dropped anywhere on the window.
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
    };
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      if (!e.dataTransfer) return;
      const files = Array.from(e.dataTransfer.files);
      for (const f of files) {
        const filePath = window.weavepdf.getPathForFile(f);
        if (!filePath) continue;
        try {
          const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
          const file = await window.weavepdf.readFile(filePath);
          const bytes = new Uint8Array(file.data);
          if (ext === "pdf") {
            await loadAsTab({
              name: file.name,
              path: file.path,
              sizeBytes: file.sizeBytes,
              bytes,
            });
          } else if (["png", "jpg", "jpeg", "heic", "heif"].includes(ext)) {
            const pdfBytes = await convertImageBytesToPdf(bytes, ext);
            await loadAsTab({
              name: file.name.replace(/\.[^.]+$/, ".pdf"),
              path: null,
              sizeBytes: pdfBytes.byteLength,
              bytes: pdfBytes,
            });
          } else if (DOC_EXTS.includes(ext as (typeof DOC_EXTS)[number])) {
            const pdfBytes = await convertDocBytesToPdf(bytes, file.name);
            await loadAsTab({
              name: file.name.replace(/\.[^.]+$/, ".pdf"),
              path: null,
              sizeBytes: pdfBytes.byteLength,
              bytes: pdfBytes,
            });
          }
        } catch (err) {
          alert(`Couldn't open ${f.name}: ${(err as Error).message ?? err}`);
        }
      }
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [loadAsTab]);

  const actions: PaletteAction[] = useMemo(() => {
    const hasTab = !!activeTab;
    return [
      // File
      { id: "open", label: "Open…", group: "File", shortcut: "⌘O", run: openFile },
      { id: "recent-drafts", label: "Recent drafts…", group: "File", shortcut: "⌘⌥R", keywords: ["history", "autosave", "resume", "draft", "revision"], run: openRecentDrafts },
      { id: "save", label: "Save", group: "File", shortcut: "⌘S", disabled: !hasTab, run: () => saveCurrent(false) },
      { id: "save-as", label: "Save As…", group: "File", shortcut: "⌘⇧S", disabled: !hasTab, run: () => saveCurrent(true) },
      { id: "export", label: "Export combined PDF…", group: "File", shortcut: "⌘E", disabled: tabs.length === 0, run: exportCombined },
      { id: "print", label: "Print…", group: "File", shortcut: "⌘P", disabled: !hasTab, run: printCurrent },
      { id: "keyboard-shortcuts", label: "Keyboard shortcuts…", group: "Help", shortcut: "⌘/", keywords: ["keys", "hotkeys", "shortcuts", "reference"], run: openShortcutHelp },
      { id: "show-welcome", label: "Welcome to WeavePDF…", group: "Help", keywords: ["onboarding", "tour", "intro", "first run", "finder", "extension", "setup"], run: openWelcome },
      // Edit
      { id: "add-text", label: "Add text", group: "Edit", shortcut: "T", disabled: !hasTab, keywords: ["insert", "type"], run: () => setTool("text") },
      { id: "edit-text", label: "Edit existing text", group: "Edit", shortcut: "E", disabled: !hasTab, keywords: ["replace", "modify"], run: () => setTool("editText") },
      { id: "add-signature", label: "Signature…", group: "Edit", shortcut: "S", disabled: !hasTab, keywords: ["sign"], run: openSignature },
      { id: "add-image", label: "Place image…", group: "Edit", shortcut: "I", disabled: !hasTab, keywords: ["photo", "picture"], run: openImagePicker },
      { id: "sticky-note", label: "Sticky note", group: "Edit", shortcut: "N", disabled: !hasTab, keywords: ["comment", "yellow"], run: () => setTool("sticky") },
      { id: "highlight", label: "Highlight", group: "Edit", shortcut: "H", disabled: !hasTab, keywords: ["yellow", "marker"], run: () => setTool("highlight") },
      { id: "whiteout", label: "Whiteout", group: "Edit", shortcut: "W", disabled: !hasTab, keywords: ["erase", "cover"], run: () => setTool("whiteout") },
      { id: "redact", label: "Redact region", group: "Edit", shortcut: "X", disabled: !hasTab, keywords: ["black", "remove", "censor"], run: () => setTool("redact") },
      { id: "shape-rect", label: "Rectangle", group: "Edit", shortcut: "R", disabled: !hasTab, keywords: ["box", "square"], run: () => setTool("rect") },
      { id: "shape-circle", label: "Ellipse", group: "Edit", shortcut: "O", disabled: !hasTab, keywords: ["oval"], run: () => setTool("circle") },
      { id: "shape-line", label: "Line", group: "Edit", shortcut: "L", disabled: !hasTab, run: () => setTool("line") },
      { id: "shape-arrow", label: "Arrow", group: "Edit", shortcut: "A", disabled: !hasTab, run: () => setTool("arrow") },
      { id: "draw", label: "Draw freehand", group: "Edit", shortcut: "D", disabled: !hasTab, keywords: ["pen", "ink", "pencil"], run: () => setTool("draw") },
      { id: "add-link", label: "Add hyperlink (URL or page)", group: "Edit", shortcut: "K", disabled: !hasTab, keywords: ["link", "url", "anchor", "goto", "jump"], run: () => setTool("link") },
      { id: "measure", label: "Measure distance", group: "Edit", shortcut: "M", disabled: !hasTab, keywords: ["ruler", "scale", "length", "distance"], run: () => setTool("measure") },
      { id: "calibrate-measure", label: "Calibrate measurement scale…", group: "Edit", disabled: !hasTab, keywords: ["scale", "ruler", "blueprint"], run: calibrateMeasure },
      { id: "delete-selected", label: "Delete selected pages", group: "Edit", shortcut: "⌫", disabled: !activeTab || activeTab.selectedPages.size === 0, run: deleteSelected },
      { id: "extract-pages", label: "Extract pages…", group: "Edit", shortcut: "⌘⌥E", disabled: !hasTab, keywords: ["split", "separate"], run: openExtract },
      { id: "crop-pages", label: "Crop pages…", group: "Document", shortcut: "C", disabled: !hasTab, keywords: ["margin", "trim"], run: openCrop },
      { id: "fill-form", label: "Fill form fields…", group: "Document", shortcut: "⌘⌥F", disabled: !hasTab, keywords: ["acroform", "form", "field", "input"], run: openFormFill },
      { id: "batch", label: "Batch ops on folder…", group: "Document", shortcut: "⌘⌥B", keywords: ["folder", "bulk", "multiple"], run: openBatch },
      { id: "ocr", label: "OCR (Apple Vision)…", group: "Document", shortcut: "⌘⌥O", disabled: !hasTab, keywords: ["scan", "text", "searchable", "recognize"], run: openOcr },
      { id: "export-markdown", label: "Export as Markdown…", group: "File", shortcut: "⌘⌥M", disabled: !hasTab, keywords: ["md", "plaintext", "text"], run: () => exportMarkdown() },
      { id: "export-docx", label: "Export as Word document…", group: "File", shortcut: "⌘⌥X", disabled: !hasTab, keywords: ["docx", "word", "office"], run: () => exportDocx() },
      { id: "encrypt-pdf", label: "Encrypt with password…", group: "Document", shortcut: "⌘⌥K", disabled: !hasTab, keywords: ["password", "lock", "protect"], run: () => encryptPdf() },
      { id: "digital-sign", label: "Sign digitally (PKCS#7)…", group: "Document", shortcut: "⌘⌥D", disabled: !hasTab, keywords: ["digital", "certificate", "cms", "cryptographic"], run: openDigitalSign },
      { id: "ai-summarize", label: "Apple Intelligence: summarize / ask / rewrite…", group: "Document", shortcut: "⌘⌥A", disabled: !hasTab, keywords: ["ai", "summarize", "question", "intelligence", "rewrite", "foundation"], run: openAi },
      { id: "header-footer", label: "Header / footer / page numbers…", group: "Document", shortcut: "⌘⌥P", disabled: !hasTab, keywords: ["page number"], run: openHeaderFooter },
      { id: "rotate-left", label: "Rotate left 90°", group: "Edit", shortcut: "⌘[", disabled: !hasTab, keywords: ["ccw"], run: () => rotateSelected(-90) },
      { id: "rotate-right", label: "Rotate right 90°", group: "Edit", shortcut: "⌘]", disabled: !hasTab, keywords: ["cw"], run: () => rotateSelected(90) },
      { id: "rotate-180", label: "Rotate 180°", group: "Edit", shortcut: "⌘⇧]", disabled: !hasTab, keywords: ["flip"], run: () => rotateSelected(180) },
      { id: "undo", label: "Undo", group: "Edit", shortcut: "⌘Z", disabled: !activeTab || (activeTab.history.length === 0 && !tabHasPendingEdits(activeTab)), run: () => activeTab && undo(activeTab.id) },
      { id: "redo", label: "Redo", group: "Edit", shortcut: "⌘⇧Z", disabled: !activeTab || activeTab.redoStack.length === 0, run: () => activeTab && useDocumentStore.getState().redo(activeTab.id) },
      { id: "compress", label: "Compress PDF…", group: "Document", shortcut: "⌘⌥C", disabled: !hasTab, run: openCompress },
      { id: "page-layout", label: "Page layout… (N-up / Auto-crop / Fit / Booklet / Split)", group: "Document", shortcut: "⌘⌥L", disabled: !hasTab, keywords: ["nup", "n-up", "crop", "fit", "booklet", "split", "spread", "layout", "imposition", "trim", "margins"], run: openPageLayout },
      { id: "watermark", label: "Add watermark…", group: "Document", shortcut: "⌘⌥W", disabled: !hasTab, run: openWatermark },
      { id: "metadata", label: "Document properties…", group: "Document", shortcut: "⌘I", disabled: !hasTab, keywords: ["info", "title", "author"], run: openMetadata },
      // View
      { id: "search", label: "Find in document…", group: "View", shortcut: "⌘F", disabled: !hasTab, run: openSearch },
      { id: "toggle-sidebar", label: "Toggle sidebar", group: "View", shortcut: "⌘B", run: toggleSidebar },
      { id: "view-single", label: "View · single page", group: "View", shortcut: "⌘⌥1", disabled: !hasTab, keywords: ["layout", "single"], run: () => setViewMode("single") },
      { id: "view-spread", label: "View · two-page spread", group: "View", shortcut: "⌘⌥2", disabled: !hasTab, keywords: ["spread", "facing", "book", "magazine"], run: () => setViewMode("spread") },
      { id: "view-cover", label: "View · cover + spread (book mode)", group: "View", shortcut: "⌘⌥3", disabled: !hasTab, keywords: ["book", "cover", "facing"], run: () => setViewMode("cover-spread") },
      { id: "zoom-in", label: "Zoom in", group: "View", shortcut: "⌘=", disabled: !hasTab, run: () => activeTab && setZoom(activeTab.id, activeTab.zoom * 1.1) },
      { id: "zoom-out", label: "Zoom out", group: "View", shortcut: "⌘−", disabled: !hasTab, run: () => activeTab && setZoom(activeTab.id, activeTab.zoom / 1.1) },
      { id: "zoom-reset", label: "Zoom to 100%", group: "View", shortcut: "⌘0", disabled: !hasTab, run: () => activeTab && setZoom(activeTab.id, 1) },
    ];
  }, [
    activeTab, tabs.length, openFile, saveCurrent, exportCombined,
    setTool, openSignature, openMetadata, openWatermark, openExtract,
    openCrop, openHeaderFooter, openImagePicker, openFormFill, openBatch, openOcr,
    openDigitalSign, openAi, openRecentDrafts, openShortcutHelp, openWelcome, deleteSelected, rotateSelected, undo,
    openCompress, openPageLayout, exportMarkdown, exportDocx, encryptPdf, printCurrent, openSearch,
    toggleSidebar, setZoom, setViewMode, calibrateMeasure,
  ]);

  const hasDocs = tabs.length > 0;

  return (
    <div className="flex h-full flex-col bg-[var(--app-bg)] text-[var(--app-fg)]">
      <Titlebar onOpen={openFile} onSave={() => saveCurrent(false)} onExport={exportCombined} />
      <DefaultPdfBanner />
      {hasDocs && activeTab?.bytes && (
        <Toolstrip
          onSave={() => saveCurrent(false)}
          onExport={exportCombined}
          onPrint={printCurrent}
        />
      )}
      <div className="flex min-h-0 flex-1">
        {hasDocs && activeTab?.bytes ? (
          <>
            <Sidebar />
            <main className="relative flex min-w-0 flex-1 flex-col">
              <Viewer />
              {searchOpen && activeTab && <SearchBar />}
            </main>
          </>
        ) : (
          // No tabs OR active tab is a blank ⌘T placeholder — show DropZone.
          // The blank tab keeps the title bar tab-strip visible, so the user
          // can still see + switch between other tabs.
          <DropZone onOpen={openFile} />
        )}
      </div>
      <ContextMenuHost />
      {/* Modals are conditionally mounted so their lazy bundles only load
          when the user actually opens them — keeps cold-launch parse work
          off the critical path. Each is wrapped in a single Suspense so
          React can suspend during the load with no flash of wrong UI. */}
      <Suspense fallback={null}>
        {compressOpen && <CompressModal open={true} onClose={closeCompress} />}
        {signatureOpen && <SignatureModal open={true} onClose={closeSignature} />}
        {metadataOpen && <MetadataModal open={true} onClose={closeMetadata} />}
        {watermarkOpen && <WatermarkModal open={true} onClose={closeWatermark} />}
        {extractOpen && <ExtractModal open={true} onClose={closeExtract} />}
        {cropOpen && <CropModal open={true} onClose={closeCrop} />}
        {headerFooterOpen && <HeaderFooterModal open={true} onClose={closeHeaderFooter} />}
        {formFillOpen && <FormFillModal open={true} onClose={closeFormFill} />}
        {batchOpen && <BatchModal open={true} onClose={closeBatch} />}
        {ocrOpen && <OcrModal open={true} onClose={closeOcr} />}
        {digitalSignOpen && <DigitalSignModal open={true} onClose={closeDigitalSign} />}
        {aiOpen && <AiModal open={true} onClose={closeAi} />}
        {!!encryptPrompt && (
          <PasswordModal
            open={true}
            fileName={encryptPrompt?.name ?? ""}
            busy={encryptBusy}
            error={encryptError}
            mode="encrypt"
            onCancel={() => {
              setEncryptPrompt(null);
              setEncryptBusy(false);
              setEncryptError(null);
            }}
            onSubmit={runEncrypt}
          />
        )}
        {!!passwordPrompt && (
          <PasswordModal
            open={true}
            fileName={passwordPrompt?.name ?? ""}
            busy={passwordBusy}
            error={passwordError}
            onCancel={() => {
              passwordPrompt?.resolve(null);
              setPasswordPrompt(null);
              setPasswordError(null);
              setPasswordBusy(false);
            }}
            onSubmit={async (pw) => {
              if (!passwordPrompt) return;
              setPasswordBusy(true);
              setPasswordError(null);
              try {
                const decrypted = await window.weavepdf.qpdf.decrypt(u8ToAb(passwordPrompt.bytes), pw);
                passwordPrompt.resolve(new Uint8Array(decrypted));
                setPasswordPrompt(null);
              } catch (err) {
                setPasswordError((err as Error).message ?? String(err));
              } finally {
                setPasswordBusy(false);
              }
            }}
          />
        )}
        {pageLayoutOpen && <PageLayoutModal open={true} onClose={closePageLayout} />}
        {shortcutHelpOpen && <ShortcutHelpModal open={true} onClose={closeShortcutHelp} />}
        {welcomeOpen && (
          <WelcomeModal
            open={true}
            onClose={handleCloseWelcome}
            initialStep={welcomeInitialStep}
          />
        )}
        {recentDraftsOpen && (
          <RecentDraftsModal
            open={true}
            onClose={closeRecentDrafts}
            onRestore={handleRestoreFromList}
          />
        )}
        {measurePromptOpen && (
          <PromptModal
            open={true}
            title="Calibrate measurement scale"
            description="Enter what one printed inch on the PDF should represent. Examples: 1 in, 5 ft, 30 cm."
            label="One PDF inch equals"
            initialValue="1 in"
            placeholder="5 ft"
            submitLabel="Set scale"
            validate={(value) => {
              const m = value.match(/^([\d.]+)\s*([a-zA-Z]+)$/);
              if (!m || Number.parseFloat(m[1]) <= 0) {
                return "Use a value like 5 ft or 30 cm.";
              }
              return null;
            }}
            onSubmit={applyMeasureCalibration}
            onClose={() => setMeasurePromptOpen(false)}
          />
        )}
      </Suspense>
      <LinkPopover />
      {restorePrompt && (
        <Suspense fallback={null}>
          <RestoreDraftModal
            manifest={restorePrompt.manifest}
            onRestore={() => {
              restorePrompt.resolve("restore");
              setRestorePrompt(null);
            }}
            onDiscardAndOpen={() => {
              restorePrompt.resolve("discard");
              setRestorePrompt(null);
            }}
            onCancel={() => {
              restorePrompt.resolve("cancel");
              setRestorePrompt(null);
            }}
          />
        </Suspense>
      )}
      <CommandPalette open={paletteOpen} onClose={closePalette} actions={actions} />
    </div>
  );
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function ContextMenuHost() {
  const menu = useUIStore((s) => s.contextMenu);
  const close = useUIStore((s) => s.closeContextMenu);
  return (
    <ContextMenu
      open={!!menu}
      x={menu?.x ?? 0}
      y={menu?.y ?? 0}
      items={menu?.items ?? []}
      onClose={close}
    />
  );
}

const toArrayBuffer = u8ToAb;

async function convertImageBytesToPdf(bytes: Uint8Array, ext: string): Promise<Uint8Array> {
  const { imageToPdf, decodeImageToPng } = await loadPdfOps();
  const e = ext.toLowerCase();
  if (e === "png") return imageToPdf(bytes, "image/png");
  if (e === "jpg" || e === "jpeg") return imageToPdf(bytes, "image/jpeg");
  const blob = bytesToBlob(bytes, "application/octet-stream");
  const png = await decodeImageToPng(blob);
  return imageToPdf(png, "image/png");
}

const DOC_EXTS = ["docx", "doc", "rtf"] as const;

async function convertDocBytesToPdf(bytes: Uint8Array, filename: string): Promise<Uint8Array> {
  const pdfAb = await window.weavepdf.convertDocToPdf(u8ToAb(bytes), filename);
  return new Uint8Array(pdfAb);
}
