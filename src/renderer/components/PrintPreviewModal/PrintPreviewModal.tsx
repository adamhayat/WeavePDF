import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Printer, X } from "lucide-react";
import { useDocumentStore } from "../../stores/document";
import * as pdfjsLib from "pdfjs-dist";
import "../../lib/pdfjs"; // ensure worker initialized
import { u8ToAb } from "../../../shared/buffers";

type Props = {
  open: boolean;
  onClose: () => void;
};

/**
 * Print Preview modal — V1.0027 simplified.
 *
 * V1.0021 added layout (n-up) + orientation controls, but the macOS native
 * print dialog ALSO has those exact same controls (Layout > Pages per
 * Sheet, Orientation). The user reported the duplicate was confusing —
 * "different than how I set it up in the first flow" — and frankly it was.
 *
 * V1.0027 makes our modal preview-only. The user sees what they're about
 * to print (clean PDF, no app chrome — fixes the V1.0020 sidebar-bleed
 * bug). They click Print, the native macOS dialog opens with all the real
 * controls (printer, copies, layout, orientation, paper, duplex, color).
 * One source of truth for the print options, one preview for "is this
 * the right document?". No more dual-stage settings.
 *
 * Flow:
 *   1. Open → commitAllPending bakes pending overlays into the active tab.
 *   2. pdf.js renders the source bytes for thumbnails + big preview.
 *   3. Print → window.weavepdf.printPdfBytes opens the native dialog;
 *      user picks layout / orientation / printer there.
 */
export function PrintPreviewModal({ open, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const activeTab = useDocumentStore((s) => s.activeTab());
  const commitAllPending = useDocumentStore((s) => s.commitAllPending);

  const [printing, setPrinting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [selectedPage, setSelectedPage] = useState(1);

  // Refs avoid pdf/loadingTask appearing in deps (which would cause a
  // tear-rebuild loop). Loads are sequenced — await destroy of the
  // previous proxy BEFORE swapping in the new one — to dodge the
  // pdf.js shared-worker race that V1.0022 was about.
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<ReturnType<typeof pdfjsLib.getDocument> | null>(null);

  // Reset on open. pdf cleanup is owned by the unmount effect below.
  useEffect(() => {
    if (!open) {
      setSelectedPage(1);
      setLoadError(null);
      setPrinting(false);
      return;
    }
    requestAnimationFrame(() => closeRef.current?.focus());
  }, [open]);

  // Bake pending overlays the moment the modal opens so the preview
  // matches what will print.
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

  // Load the active tab's bytes through pdf.js for the preview. Sequenced
  // load: new doc loads first, state swaps, old doc destroy is awaited
  // AFTER the swap so nothing races the shared pdf.js worker port.
  useEffect(() => {
    if (!open || !activeTab?.bytes) return;
    let cancelled = false;

    (async () => {
      let task: ReturnType<typeof pdfjsLib.getDocument> | null = null;
      let loaded: pdfjsLib.PDFDocumentProxy | null = null;
      try {
        const data = new Uint8Array(u8ToAb(activeTab.bytes!));
        task = pdfjsLib.getDocument({ data });
        loadingTaskRef.current = task;
        loaded = await task.promise;
        if (cancelled) {
          try { await loaded.destroy(); } catch { /* ignore */ }
          return;
        }
        const old = pdfRef.current;
        pdfRef.current = loaded;
        setPdf(loaded);
        setSelectedPage(1);
        setLoadError(null);
        if (old) {
          try { await old.destroy(); } catch { /* ignore */ }
        }
        if (loadingTaskRef.current === task) loadingTaskRef.current = null;
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
        if (loaded) {
          try { await loaded.destroy(); } catch { /* ignore */ }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, activeTab?.bytes, activeTab?.version]);

  // Final cleanup on unmount.
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
    if (!activeTab?.bytes || printing) return;
    setPrinting(true);
    try {
      const result = await window.weavepdf.printPdfBytes(
        u8ToAb(activeTab.bytes),
        activeTab.name,
      );
      if (result.ok) {
        onClose();
        return;
      }
      if (result.error) {
        // ok=false + no error = user cancelled in the dialog. Stay open
        // so the user can retry without re-navigating.
        alert(`Print failed: ${result.error}`);
      }
    } catch (err) {
      alert(`Print failed: ${(err as Error).message ?? err}`);
    } finally {
      setPrinting(false);
    }
  }, [activeTab?.bytes, activeTab?.name, printing, onClose]);

  // Esc closes (when not mid-print).
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
              {numPages > 0 && ` • ${numPages} page${numPages === 1 ? "" : "s"}`}
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

        {loadError && (
          <div className="border-b border-[var(--panel-border)] bg-[var(--panel-bg)] px-6 py-2 text-[12px] text-[var(--destructive)]">
            Couldn’t build preview: {loadError}
          </div>
        )}

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
        <div className="flex items-center justify-between gap-3 border-t border-[var(--panel-border)] bg-[var(--panel-bg)] px-6 py-3">
          <p className="hidden text-[11px] text-[var(--muted)] sm:block">
            Pick layout (pages per sheet), orientation, and paper size in the next dialog.
          </p>
          <div className="ml-auto flex items-center gap-2">
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
              disabled={!activeTab?.bytes || printing}
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
        const targetWidth = 130;
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
        const containerWidth = container.clientWidth - 32;
        const containerHeight = container.clientHeight - 32;
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(
          containerWidth / baseViewport.width,
          containerHeight / baseViewport.height,
        );
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
