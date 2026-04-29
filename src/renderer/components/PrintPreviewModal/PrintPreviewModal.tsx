import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Printer, X } from "lucide-react";
import { useDocumentStore } from "../../stores/document";
import * as pdfjsLib from "pdfjs-dist";
import "../../lib/pdfjs"; // ensure worker initialized
import { u8ToAb } from "../../../shared/buffers";

// Lazy import — pdf-ops is in a separate chunk we don't want to pull eagerly.
const loadPdfOps = () => import("../../lib/pdf-ops");

type Props = {
  open: boolean;
  onClose: () => void;
};

type PerSheet = 1 | 2 | 4 | 6 | 9;
type Orientation = "auto" | "portrait" | "landscape";

const PER_SHEET_OPTIONS: { value: PerSheet; label: string }[] = [
  { value: 1, label: "1 per sheet" },
  { value: 2, label: "2 per sheet" },
  { value: 4, label: "4 per sheet" },
  { value: 6, label: "6 per sheet" },
  { value: 9, label: "9 per sheet" },
];

const ORIENTATION_OPTIONS: { value: Orientation; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "portrait", label: "Portrait" },
  { value: "landscape", label: "Landscape" },
];

/**
 * Print Preview modal — V1.0021. Modeled on macOS Preview.app's print panel:
 * thumbnail strip on the left, large preview on the right, layout controls
 * at the top. Replaces the V1.0020 path that called webContents.print() on
 * the renderer window itself (which dumped sidebar thumbnails + chrome
 * into the printed page).
 *
 * Flow:
 *   1. On open, commitAllPending bakes pending overlays into the active
 *      tab's PDF bytes. From here on we treat those as the source of truth.
 *   2. Layout selector (1/2/4/6/9 per sheet) feeds nUpPages to produce a
 *      derived "print bytes" PDF. 1-per-sheet means the source bytes
 *      directly — we never re-render through pdf-lib for that case.
 *   3. pdf.js renders the print bytes for both the thumbnail strip and the
 *      big preview pane.
 *   4. "Print" → window.weavepdf.printPdfBytes(printBytes), which writes
 *      to a temp file, opens a hidden BrowserWindow, calls webContents.print
 *      with empty header/footer (no filename in margins), shows the native
 *      macOS print dialog. The user picks printer/copies/etc. there.
 */
export function PrintPreviewModal({ open, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const activeTab = useDocumentStore((s) => s.activeTab());
  const commitAllPending = useDocumentStore((s) => s.commitAllPending);

  const [perSheet, setPerSheet] = useState<PerSheet>(1);
  const [orientation, setOrientation] = useState<Orientation>("auto");
  const [printBytes, setPrintBytes] = useState<Uint8Array | null>(null);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [selectedPage, setSelectedPage] = useState(1);

  // Refs to avoid putting pdf/loadingTask in deps (which would cause a
  // tear-rebuild loop). The pdf.js worker race fixed in V1.0022 lives here:
  // every load is sequenced — we await destroy of the previous proxy
  // BEFORE swapping in the new one. Without that, rapid layout/orientation
  // changes triggered overlapping getDocument() + destroy() against the
  // shared worker port, which surfaced as "PDFWorker.fromPort - the worker
  // is being destroyed".
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<ReturnType<typeof pdfjsLib.getDocument> | null>(null);

  // Reset state on open. Important: any pdf proxy from a previous open is
  // destroyed via the ref-based cleanup below, not here.
  useEffect(() => {
    if (!open) {
      setPrintBytes(null);
      setSelectedPage(1);
      setLayoutError(null);
      setPerSheet(1);
      setOrientation("auto");
      setPrinting(false);
      // Hand pdf cleanup to the unmount/printBytes-null effect below.
      return;
    }
    requestAnimationFrame(() => closeRef.current?.focus());
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bake pending overlays the moment the modal opens so the preview
  // matches what will print. Same pattern as the V1.0020 printCurrent.
  useEffect(() => {
    if (!open || !activeTab) return;
    const hasPending =
      activeTab.pendingTextEdits.length > 0 ||
      activeTab.pendingImageEdits.length > 0 ||
      activeTab.pendingShapeEdits.length > 0;
    if (hasPending) {
      void commitAllPending(activeTab.id);
    }
  }, [open, activeTab?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build print bytes whenever layout or source bytes change.
  useEffect(() => {
    if (!open || !activeTab?.bytes) return;
    let cancelled = false;
    setLayoutBusy(true);
    setLayoutError(null);
    (async () => {
      try {
        let next: Uint8Array;
        if (perSheet === 1) {
          // 1-per-sheet always renders the source bytes directly. Any
          // orientation control is a no-op here — rotating individual
          // pages is a separate operation outside print preview's scope.
          next = activeTab.bytes!;
        } else {
          // V1.0022: "Auto" must NOT be passed as a string to nUpPages
          // because resolvePaperSize treats "auto" as "use base orientation
          // of the paper" (i.e. portrait Letter for 2/4/6/9-up). The
          // user-friendly default for 2-up is landscape, for 4/6/9-up is
          // portrait — that's what nUpPages's `defaultOrient` provides
          // when `orientation` is omitted. So when the modal says "auto",
          // we DROP the orientation key so the primitive picks its default.
          const { nUpPages } = await loadPdfOps();
          const opts: Parameters<typeof nUpPages>[2] =
            orientation === "auto" ? {} : { orientation };
          next = await nUpPages(activeTab.bytes!, perSheet, opts);
        }
        if (cancelled) return;
        setPrintBytes(next);
      } catch (err) {
        if (!cancelled) {
          setLayoutError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLayoutBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, activeTab?.bytes, activeTab?.version, perSheet, orientation]);

  // V1.0022: properly sequenced pdf.js load. The previous version had a
  // race where rapid layout/orientation changes triggered overlapping
  // getDocument() + destroy() calls against the shared pdf.js worker, which
  // pdf.js surfaced as "PDFWorker.fromPort - the worker is being destroyed."
  //
  // Sequencing rules:
  //   1. Each effect run gets a `cancelled` token. The cleanup sets it.
  //   2. We never destroy() the previous pdf BEFORE the new one finishes
  //      loading — that's what was racing the worker. Instead: load new,
  //      then swap state, then destroy old (so the swap renders without
  //      pdf.js worker contention).
  //   3. If a newer effect cancelled this one mid-load, destroy the
  //      orphaned new pdf instead of mounting it.
  useEffect(() => {
    if (!printBytes) return;
    let cancelled = false;

    (async () => {
      let task: ReturnType<typeof pdfjsLib.getDocument> | null = null;
      let loaded: pdfjsLib.PDFDocumentProxy | null = null;
      try {
        const data = new Uint8Array(u8ToAb(printBytes));
        task = pdfjsLib.getDocument({ data });
        loadingTaskRef.current = task;
        loaded = await task.promise;
        if (cancelled) {
          // A newer effect superseded us; throw the load away cleanly.
          try { await loaded.destroy(); } catch { /* ignore */ }
          return;
        }
        // Swap: state update first, then await destroy of the old proxy.
        const old = pdfRef.current;
        pdfRef.current = loaded;
        setPdf(loaded);
        setSelectedPage(1);
        setLayoutError(null);
        if (old) {
          try { await old.destroy(); } catch { /* ignore — best-effort */ }
        }
        if (loadingTaskRef.current === task) loadingTaskRef.current = null;
      } catch (err) {
        if (!cancelled) {
          setLayoutError(err instanceof Error ? err.message : String(err));
        }
        if (loaded) {
          try { await loaded.destroy(); } catch { /* ignore */ }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [printBytes]);

  // Final cleanup on unmount: destroy any in-flight task + any mounted pdf.
  useEffect(() => {
    return () => {
      const t = loadingTaskRef.current;
      const p = pdfRef.current;
      loadingTaskRef.current = null;
      pdfRef.current = null;
      if (t) {
        try { void t.destroy(); } catch { /* ignore */ }
      }
      if (p) {
        try { void p.destroy(); } catch { /* ignore */ }
      }
    };
  }, []);

  const handlePrint = useCallback(async () => {
    if (!printBytes || printing) return;
    setPrinting(true);
    try {
      const result = await window.weavepdf.printPdfBytes(
        u8ToAb(printBytes),
        activeTab?.name,
      );
      if (result.ok) {
        onClose();
        return;
      }
      if (result.error) {
        // ok=false + no error = user cancelled in the dialog. Stay open
        // so the user can adjust + retry.
        alert(`Print failed: ${result.error}`);
      }
    } catch (err) {
      alert(`Print failed: ${(err as Error).message ?? err}`);
    } finally {
      setPrinting(false);
    }
  }, [printBytes, printing, onClose, activeTab?.name]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !printing) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, printing, onClose]);

  if (!open) return null;
  const numPages = pdf?.numPages ?? 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !printing) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="print-preview-title"
        className="flex max-h-[92vh] w-[calc(100vw-32px)] max-w-[1100px] flex-col overflow-hidden rounded-2xl border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] shadow-2xl"
        data-testid="print-preview-modal"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-[var(--panel-border)] px-6 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Printer className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.8} />
              <h2 id="print-preview-title" className="text-[15px] font-semibold">
                Print Preview
              </h2>
            </div>
            <p className="mt-0.5 text-[12px] text-[var(--muted)]">
              {activeTab?.name ?? "Untitled"}
              {numPages > 0 && ` • ${numPages} sheet${numPages === 1 ? "" : "s"}`}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={() => !printing && onClose()}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-50"
            aria-label="Close"
            disabled={printing}
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>

        {/* Layout controls */}
        <div className="flex flex-wrap items-center gap-4 border-b border-[var(--panel-border)] bg-[var(--panel-bg)] px-6 py-3 text-[12px]">
          <div className="flex items-center gap-2">
            <span className="text-[var(--muted)]">Layout:</span>
            <select
              value={perSheet}
              onChange={(e) => setPerSheet(Number(e.target.value) as PerSheet)}
              disabled={printing || layoutBusy}
              className="rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg-raised)] px-2 py-1 text-[12px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              data-testid="print-preview-per-sheet"
            >
              {PER_SHEET_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[var(--muted)]">Orientation:</span>
            <select
              value={orientation}
              onChange={(e) => setOrientation(e.target.value as Orientation)}
              disabled={printing || layoutBusy || perSheet === 1}
              className="rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg-raised)] px-2 py-1 text-[12px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-50"
            >
              {ORIENTATION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          {layoutBusy && (
            <div className="flex items-center gap-1.5 text-[var(--muted)]">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>Building preview…</span>
            </div>
          )}
          {layoutError && (
            <div className="text-[var(--destructive)]">Couldn’t build preview: {layoutError}</div>
          )}
        </div>

        {/* Body: thumbnail strip + main preview */}
        <div className="flex min-h-[400px] flex-1 overflow-hidden">
          <ThumbnailStrip
            pdf={pdf}
            selectedPage={selectedPage}
            onSelect={setSelectedPage}
            disabled={printing}
          />
          <PreviewPane pdf={pdf} pageNumber={selectedPage} />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-[var(--panel-border)] bg-[var(--panel-bg)] px-6 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={printing}
            className="rounded-md px-4 py-1.5 text-[13px] text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handlePrint}
            disabled={!printBytes || printing || layoutBusy}
            className="flex items-center gap-2 rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-[13px] font-medium text-white hover:bg-[var(--color-accent-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:ring-offset-[var(--panel-bg-raised)] disabled:opacity-50"
            data-testid="print-preview-print"
          >
            {printing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Printing…</span>
              </>
            ) : (
              <>
                <Printer className="h-3.5 w-3.5" />
                <span>Print…</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Thumbnail strip ──────────────────────────────────────────────── */

function ThumbnailStrip({
  pdf,
  selectedPage,
  onSelect,
  disabled,
}: {
  pdf: pdfjsLib.PDFDocumentProxy | null;
  selectedPage: number;
  onSelect: (n: number) => void;
  disabled: boolean;
}) {
  const numPages = pdf?.numPages ?? 0;
  const indices = useMemo(
    () => Array.from({ length: numPages }, (_, i) => i + 1),
    [numPages],
  );
  return (
    <div
      className="acr-scroll flex w-[180px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-[var(--panel-border)] bg-[var(--panel-bg)] px-3 py-3"
      data-testid="print-preview-thumbs"
    >
      {indices.length === 0 && (
        <div className="text-center text-[12px] text-[var(--muted)]">No pages</div>
      )}
      {indices.map((n) => (
        <ThumbButton
          key={n}
          pdf={pdf!}
          pageNumber={n}
          selected={n === selectedPage}
          onClick={() => !disabled && onSelect(n)}
        />
      ))}
    </div>
  );
}

function ThumbButton({
  pdf,
  pageNumber,
  selected,
  onClick,
}: {
  pdf: pdfjsLib.PDFDocumentProxy;
  pageNumber: number;
  selected: boolean;
  onClick: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let renderTask: ReturnType<pdfjsLib.PDFPageProxy["render"]> | null = null;
    (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: 1 });
        const targetWidth = 130; // matches the ~150px column - padding
        const scale = targetWidth / viewport.width;
        const scaled = page.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.floor(scaled.width);
        canvas.height = Math.floor(scaled.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        renderTask = page.render({ canvasContext: ctx, viewport: scaled });
        await renderTask.promise;
        if (!cancelled) setRendered(true);
      } catch {
        // pdf.destroy from parent — ignore.
      }
    })();
    return () => {
      cancelled = true;
      try {
        renderTask?.cancel();
      } catch {
        // ignore
      }
    };
  }, [pdf, pageNumber]);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative flex flex-col items-center gap-1 rounded-md p-1.5 transition-colors ${
        selected
          ? "bg-[var(--color-accent)]/10 ring-2 ring-[var(--color-accent)]"
          : "hover:bg-[var(--hover-bg)]"
      }`}
      aria-label={`Page ${pageNumber}`}
      data-testid={`print-preview-thumb-${pageNumber}`}
    >
      <div className="overflow-hidden rounded border border-[var(--panel-border)] bg-white">
        <canvas
          ref={canvasRef}
          className={`block ${rendered ? "" : "opacity-0"}`}
          style={{ width: 130, maxWidth: "100%", height: "auto" }}
        />
      </div>
      <span
        className={`text-[11px] tabular-nums ${
          selected ? "font-medium text-[var(--app-fg)]" : "text-[var(--muted)]"
        }`}
      >
        {pageNumber}
      </span>
    </button>
  );
}

/* ─── Big preview pane ─────────────────────────────────────────────── */

function PreviewPane({
  pdf,
  pageNumber,
}: {
  pdf: pdfjsLib.PDFDocumentProxy | null;
  pageNumber: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [renderedPage, setRenderedPage] = useState(0);

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    let renderTask: ReturnType<pdfjsLib.PDFPageProxy["render"]> | null = null;
    (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const container = containerRef.current;
        if (!container) return;
        const containerWidth = container.clientWidth - 32; // padding
        const containerHeight = container.clientHeight - 32;
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(
          containerWidth / baseViewport.width,
          containerHeight / baseViewport.height,
        );
        // Render at devicePixelRatio for sharpness.
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: scale * dpr });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        renderTask = page.render({ canvasContext: ctx, viewport });
        await renderTask.promise;
        if (!cancelled) setRenderedPage(pageNumber);
      } catch {
        // pdf.destroy or container disappeared mid-render.
      }
    })();
    return () => {
      cancelled = true;
      try {
        renderTask?.cancel();
      } catch {
        // ignore
      }
    };
  }, [pdf, pageNumber]);

  return (
    <div
      ref={containerRef}
      className="flex flex-1 items-center justify-center overflow-auto bg-[var(--panel-bg)] p-4"
      data-testid="print-preview-pane"
    >
      {!pdf ? (
        <div className="text-[13px] text-[var(--muted)]">No preview yet…</div>
      ) : (
        <div className="rounded-md border border-[var(--panel-border)] bg-white shadow-sm">
          <canvas
            ref={canvasRef}
            className={`block ${renderedPage === pageNumber ? "" : "opacity-0"}`}
          />
        </div>
      )}
    </div>
  );
}
