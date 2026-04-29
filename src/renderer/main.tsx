import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { pdfjsLib, initPdfWorker } from "./lib/pdfjs";
import { useDocumentStore } from "./stores/document";
import { u8ToAb } from "../shared/buffers";
// Lazy-loaded so the pdf-lib chunk doesn't pull at boot. Only the test hook
// uses it (exportCombinedTo merges multiple tabs); production builds skip
// the test-hook block entirely so pdf-lib never loads from this site.
const loadPdfOps = () => import("./lib/pdf-ops");
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root in index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Test hook — lets Playwright E2E specs load a fixture PDF without
// going through the native file dialog or simulating drag-drop from Finder.
// Only installed in dev or when packaging with VITE_E2E=1. Production builds
// (`npm run package`) ship without it.
declare global {
  interface Window {
    __weavepdfTest__: {
      openPdfByPath: (path: string) => Promise<void>;
      benchmarkPdfLoad: (path: string) => Promise<{
        blessMs: number;
        readMs: number;
        parseMs: number;
        addTabMs: number;
        totalMs: number;
        sizeBytes: number;
        pages: number;
      }>;
      saveActiveAs: (path: string) => Promise<boolean>;
      exportCombinedTo: (path: string) => Promise<boolean>;
      getActiveTab: () => null | {
        id: string;
        name: string;
        path: string | null;
        saveInPlace: boolean;
        sizeBytes: number;
        bytes: Uint8Array | null;
        numPages: number;
        currentPage: number;
        zoom: number;
        dirty: boolean;
        selectedPages: number[];
        version: number;
      };
    };
  }
}

function hasPendingEdits(tab: {
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

if (import.meta.env.DEV || import.meta.env.VITE_E2E === "1") {
  window.__weavepdfTest__ = {
    async openPdfByPath(filePath: string) {
      initPdfWorker();
      // Bless the path so the new read-file allowlist accepts it.
      await (window.weavepdf as unknown as { __testBless?: (p: string) => Promise<void> }).__testBless?.(filePath);
      const file = await window.weavepdf.readFile(filePath);
      const bytes = new Uint8Array(file.data);
      const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      useDocumentStore.getState().addTab({
        name: file.name,
        path: file.path,
        sizeBytes: file.sizeBytes,
        bytes,
        pdf,
        numPages: pdf.numPages,
      });
    },
    // Benchmark variant of openPdfByPath that measures each stage. Used by
    // tests/e2e/perf.spec.ts to capture baseline + post-optimization numbers
    // for the PDF load pipeline (read → parse → state update). Stages mirror
    // the production loadAsTab path in App.tsx so numbers are representative.
    async benchmarkPdfLoad(filePath: string) {
      initPdfWorker();
      const t0 = performance.now();
      await (window.weavepdf as unknown as { __testBless?: (p: string) => Promise<void> }).__testBless?.(filePath);
      const t1 = performance.now();
      const file = await window.weavepdf.readFile(filePath);
      const t2 = performance.now();
      const bytes = new Uint8Array(file.data);
      const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      const t3 = performance.now();
      useDocumentStore.getState().addTab({
        name: file.name,
        path: file.path,
        sizeBytes: file.sizeBytes,
        bytes,
        pdf,
        numPages: pdf.numPages,
      });
      const t4 = performance.now();
      return {
        blessMs: +(t1 - t0).toFixed(2),
        readMs: +(t2 - t1).toFixed(2),
        parseMs: +(t3 - t2).toFixed(2),
        addTabMs: +(t4 - t3).toFixed(2),
        totalMs: +(t4 - t0).toFixed(2),
        sizeBytes: file.sizeBytes,
        pages: pdf.numPages,
      };
    },
    async saveActiveAs(path: string) {
      const tab = useDocumentStore.getState().activeTab();
      if (!tab?.bytes) return false;
      if (hasPendingEdits(tab)) {
        await useDocumentStore.getState().commitAllPending(tab.id);
      }
      const fresh = useDocumentStore.getState().tabs.find((t) => t.id === tab.id);
      if (!fresh?.bytes) return false;
      // Bless the output path so the main-side allowlist accepts it.
      await (window.weavepdf as unknown as { __testBless?: (p: string) => Promise<void> }).__testBless?.(path);
      const r = await window.weavepdf.writeFile(path, u8ToAb(fresh.bytes));
      if (r.ok) useDocumentStore.getState().markClean(fresh.id, path);
      return r.ok;
    },
    async exportCombinedTo(path: string) {
      const tabs = useDocumentStore.getState().tabs;
      for (const tab of tabs) {
        if (hasPendingEdits(tab)) {
          await useDocumentStore.getState().commitAllPending(tab.id);
        }
      }
      const freshTabs = useDocumentStore.getState().tabs;
      const sources = freshTabs.filter((t) => t.bytes).map((t) => t.bytes!);
      if (sources.length === 0) return false;
      await (window.weavepdf as unknown as { __testBless?: (p: string) => Promise<void> }).__testBless?.(path);
      const { mergePdfs } = await loadPdfOps();
      const merged = sources.length === 1 ? sources[0] : await mergePdfs(sources);
      const r = await window.weavepdf.writeFile(path, u8ToAb(merged));
      return r.ok;
    },
    getActiveTab() {
      const tab = useDocumentStore.getState().activeTab();
      if (!tab) return null;
      const { pdf: _pdf, selectedPages, ...serializable } = tab;
      void _pdf;
      return { ...serializable, selectedPages: [...selectedPages] };
    },
  };
}
