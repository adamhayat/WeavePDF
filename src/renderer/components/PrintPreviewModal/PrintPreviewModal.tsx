import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Printer, X } from "lucide-react";
import { useDocumentStore } from "../../stores/document";
import * as pdfjsLib from "pdfjs-dist";
import "../../lib/pdfjs"; // ensure worker initialized
import { u8ToAb } from "../../../shared/buffers";
import type { PrinterInfo } from "../../../shared/ipc";
import {
  parsePageRanges,
  usePrintReducer,
  type DuplexMode,
  type PaperKey,
  type PerSheet,
} from "./usePrintReducer";

// pdf-ops is in a separate Vite chunk; lazy to keep the boot bundle small.
const loadPdfOps = () => import("../../lib/pdf-ops");

type Props = {
  open: boolean;
  onClose: () => void;
};

const PER_SHEET_OPTIONS: { value: PerSheet; label: string }[] = [
  { value: 1, label: "1 page per sheet" },
  { value: 2, label: "2 pages per sheet" },
  { value: 4, label: "4 pages per sheet" },
  { value: 6, label: "6 pages per sheet" },
  { value: 9, label: "9 pages per sheet" },
];
const PAPER_OPTIONS: { value: PaperKey; label: string }[] = [
  { value: "letter", label: "US Letter" },
  { value: "legal", label: "US Legal" },
  { value: "a4", label: "A4" },
  { value: "a3", label: "A3" },
  { value: "a5", label: "A5" },
  { value: "tabloid", label: "Tabloid" },
];
const DUPLEX_OPTIONS: { value: DuplexMode; label: string }[] = [
  { value: "simplex", label: "Off (single-sided)" },
  { value: "longEdge", label: "Long-edge binding" },
  { value: "shortEdge", label: "Short-edge binding" },
];

/**
 * Unified Print Preview panel — V1.0028.
 *
 * Single modal, two-column layout: 280 px controls rail on the left, live
 * preview pane on the right. Every print setting (printer, copies, pages,
 * paper, layout/N-up, orientation, color, two-sided) lives here. Clicking
 * Print sends the job silently via the chosen printer — no second macOS
 * dialog. The macOS native dialog is bypassed entirely via `silent:true`.
 *
 * Preview rebuild pipeline (only for settings that affect rendering —
 * paper, layout, orientation, pages range; copies/color/duplex don't
 * trigger a rebuild):
 *   1. extractPages(source, ranges) if range filter is active.
 *   2. nUpPages(derived, layout, {paper, orientation}) if layout > 1.
 *   3. fitToPaper(derived, paper, {orientation}) if paper differs from
 *      source AND we're at 1-up (n-up already encodes paper).
 *   4. Render the result through pdf.js for the preview canvas.
 *
 * Sequenced pdf.js loading: each rebuild creates its own loadingTask. New
 * doc loads fully → state swaps → old proxy destroyed (await). No worker
 * race even under fast toggling. 120 ms debounce absorbs UI clicks.
 */
export function PrintPreviewModal({ open, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const activeTab = useDocumentStore((s) => s.activeTab());
  const commitAllPending = useDocumentStore((s) => s.commitAllPending);

  const [settings, dispatch] = usePrintReducer();
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [printersLoading, setPrintersLoading] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [previewPage, setPreviewPage] = useState(1);
  const [sourceTotalPages, setSourceTotalPages] = useState(0);

  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<ReturnType<typeof pdfjsLib.getDocument> | null>(null);
  const printBytesRef = useRef<Uint8Array | null>(null);

  // ── Reset on open ────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    setPrintError(null);
    setPreviewError(null);
    setPrinting(false);
    setPreviewPage(1);
    requestAnimationFrame(() => closeRef.current?.focus());
  }, [open]);

  // ── Bake pending overlays + capture source page count ────────────────
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

  useEffect(() => {
    setSourceTotalPages(activeTab?.numPages ?? 0);
  }, [activeTab?.numPages]);

  // ── Load printers once on open ──────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPrintersLoading(true);
    void window.weavepdf.listPrinters().then((list) => {
      if (cancelled) return;
      setPrinters(list);
      setPrintersLoading(false);
      // Pick the OS default if we don't already have a selection.
      if (!settings.deviceName) {
        const def = list.find((p) => p.isDefault) ?? list[0];
        if (def) {
          dispatch({
            type: "set-printer",
            name: def.name,
            displayName: def.displayName,
          });
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Page-range parse (memo) ──────────────────────────────────────────
  const rangeParse = useMemo(
    () => parsePageRanges(settings.pagesInput, sourceTotalPages || 1),
    [settings.pagesInput, sourceTotalPages],
  );

  // ── Preview rebuild pipeline ─────────────────────────────────────────
  // Trigger key: any setting that changes what gets rendered to preview.
  // Settings that DON'T trigger rebuild: copies, color, duplex.
  const previewKey = useMemo(() => {
    return [
      activeTab?.id ?? "no-tab",
      activeTab?.version ?? 0,
      settings.paper,
      settings.layout,
      settings.orientation,
      // Cache by parsed ranges, not raw input (prevents bouncing on
      // intermediate "1-" while user is typing).
      JSON.stringify(rangeParse.error ? [] : rangeParse.ranges),
    ].join("|");
  }, [
    activeTab?.id,
    activeTab?.version,
    settings.paper,
    settings.layout,
    settings.orientation,
    rangeParse,
  ]);

  useEffect(() => {
    if (!open || !activeTab?.bytes) return;
    let cancelled = false;
    setPreviewBusy(true);
    setPreviewError(null);

    // Debounce 120ms so rapid radio-button clicks don't fire 5 rebuilds.
    const debounce = setTimeout(() => {
      if (cancelled) return;
      void (async () => {
        try {
          const ops = await loadPdfOps();
          let bytes = activeTab.bytes!;

          // 1. Page-range filter (if user typed a range).
          if (rangeParse.ranges.length > 0) {
            // Flatten ranges to a sorted, dedup'd 1-based index list.
            const indices = new Set<number>();
            for (const r of rangeParse.ranges) {
              for (let i = r.from; i <= r.to; i++) indices.add(i);
            }
            const list = Array.from(indices).sort((a, b) => a - b);
            bytes = await ops.extractPages(bytes, list);
          }

          // 2. N-up (if layout > 1) — bakes orientation + paper into the
          //    laid-out PDF.
          if (settings.layout > 1) {
            bytes = await ops.nUpPages(bytes, settings.layout as 2 | 4 | 6 | 9, {
              paper: settings.paper,
              orientation: settings.orientation,
            });
          } else if (
            // 1-up fit-to-paper. Skip when source paper already matches the
            // selected paper to avoid a re-render that doesn't change anything.
            settings.paper !== "letter" ||
            settings.orientation === "landscape"
          ) {
            try {
              bytes = await ops.fitToPaper(bytes, settings.paper, {
                orientation: settings.orientation,
              });
            } catch {
              // fitToPaper is permissive — fall back to source bytes if
              // anything trips up (uncommon edge: empty doc).
            }
          }

          if (cancelled) return;
          printBytesRef.current = bytes;

          // pdf.js sequenced load.
          let task: ReturnType<typeof pdfjsLib.getDocument> | null = null;
          let loaded: pdfjsLib.PDFDocumentProxy | null = null;
          try {
            task = pdfjsLib.getDocument({ data: new Uint8Array(u8ToAb(bytes)) });
            loadingTaskRef.current = task;
            loaded = await task.promise;
            if (cancelled) {
              try { await loaded.destroy(); } catch { /* ignore */ }
              return;
            }
            const old = pdfRef.current;
            pdfRef.current = loaded;
            setPdf(loaded);
            setPreviewPage(1);
            if (old) {
              try { await old.destroy(); } catch { /* ignore */ }
            }
            if (loadingTaskRef.current === task) loadingTaskRef.current = null;
          } catch (err) {
            if (loaded) try { await loaded.destroy(); } catch { /* ignore */ }
            throw err;
          }
        } catch (err) {
          if (!cancelled) {
            setPreviewError(err instanceof Error ? err.message : String(err));
          }
        } finally {
          if (!cancelled) setPreviewBusy(false);
        }
      })();
    }, 120);

    return () => {
      cancelled = true;
      clearTimeout(debounce);
    };
  }, [open, previewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Final cleanup on unmount ─────────────────────────────────────────
  useEffect(() => {
    return () => {
      const t = loadingTaskRef.current;
      const p = pdfRef.current;
      loadingTaskRef.current = null;
      pdfRef.current = null;
      printBytesRef.current = null;
      if (t) {
        try { void t.destroy(); } catch { /* ignore */ }
      }
      if (p) {
        try { void p.destroy(); } catch { /* ignore */ }
      }
    };
  }, []);

  // ── Handlers ─────────────────────────────────────────────────────────
  const handlePrint = useCallback(async () => {
    if (!printBytesRef.current || printing) return;
    if (!settings.deviceName) {
      setPrintError("Pick a printer first.");
      return;
    }
    if (rangeParse.error) {
      setPrintError(rangeParse.error);
      return;
    }
    setPrinting(true);
    setPrintError(null);
    try {
      const result = await window.weavepdf.printPdfBytes(
        u8ToAb(printBytesRef.current),
        activeTab?.name,
        {
          deviceName: settings.deviceName,
          color: settings.color,
          copies: settings.copies,
          duplexMode: settings.duplex,
          landscape: settings.orientation === "landscape",
          // pageRanges already applied to bytes via extractPages above —
          // don't double-apply here.
        },
      );
      if (result.ok) {
        onClose();
        return;
      }
      setPrintError(result.error || "Print failed.");
    } catch (err) {
      setPrintError((err as Error).message ?? String(err));
    } finally {
      setPrinting(false);
    }
  }, [
    printing,
    settings.deviceName,
    settings.color,
    settings.copies,
    settings.duplex,
    settings.orientation,
    rangeParse.error,
    activeTab?.name,
    onClose,
  ]);

  // ── Esc closes ───────────────────────────────────────────────────────
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
  const numSheets = pdf?.numPages ?? 0;
  const sheetsLabel = numSheets === 1 ? "1 sheet" : `${numSheets} sheets`;
  const totalSheetsWithCopies = numSheets * settings.copies;
  const totalLabel =
    settings.copies > 1
      ? `${sheetsLabel} × ${settings.copies} = ${totalSheetsWithCopies}`
      : sheetsLabel;

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
                Print
              </h2>
            </div>
            <p className="mt-0.5 truncate text-[12px] text-[var(--muted)]">
              {activeTab?.name ?? "Untitled"}
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

        {/* Body: controls rail + preview pane */}
        <div className="flex min-h-[460px] flex-1 overflow-hidden">
          <ControlsRail
            settings={settings}
            dispatch={dispatch}
            printers={printers}
            printersLoading={printersLoading}
            sourceTotalPages={sourceTotalPages}
            rangeError={rangeParse.error}
            disabled={printing}
          />
          <div className="flex flex-1 flex-col">
            <PreviewPane pdf={pdf} pageNumber={previewPage} busy={previewBusy} />
            {numSheets > 1 && (
              <PagePager
                page={previewPage}
                count={numSheets}
                onChange={setPreviewPage}
                disabled={printing}
              />
            )}
            {previewError && (
              <div className="border-t border-[var(--panel-border)] bg-[var(--panel-bg)] px-6 py-2 text-[11px] text-[var(--destructive)]">
                Preview error: {previewError}
              </div>
            )}
          </div>
        </div>

        {/* Footer: sheet count + actions */}
        <div className="flex items-center justify-between gap-3 border-t border-[var(--panel-border)] bg-[var(--panel-bg)] px-6 py-3">
          <p className="text-[11px] text-[var(--muted)] tabular-nums">
            {numSheets > 0 && totalLabel}
            {printError && (
              <span className="ml-3 text-[var(--destructive)]">{printError}</span>
            )}
          </p>
          <div className="flex items-center gap-2">
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
              disabled={
                !settings.deviceName ||
                !!rangeParse.error ||
                printing ||
                previewBusy ||
                numSheets === 0
              }
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
                  <span>Print</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Controls rail ─────────────────────────────────────────────────── */

function ControlsRail({
  settings,
  dispatch,
  printers,
  printersLoading,
  sourceTotalPages,
  rangeError,
  disabled,
}: {
  settings: ReturnType<typeof usePrintReducer>[0];
  dispatch: ReturnType<typeof usePrintReducer>[1];
  printers: PrinterInfo[];
  printersLoading: boolean;
  sourceTotalPages: number;
  rangeError: string | null;
  disabled: boolean;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [pagesAll, setPagesAll] = useState(true);

  // Switch "All pages" radio on whenever the input is empty.
  useEffect(() => {
    setPagesAll(settings.pagesInput.trim() === "");
  }, [settings.pagesInput]);

  return (
    <div
      className="acr-scroll flex w-[280px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-[var(--panel-border)] bg-[var(--panel-bg)] px-4 py-4 text-[12px]"
      data-testid="print-controls-rail"
    >
      <Row label="Printer">
        <select
          value={settings.deviceName}
          onChange={(e) => {
            const p = printers.find((x) => x.name === e.target.value);
            dispatch({
              type: "set-printer",
              name: e.target.value,
              displayName: p?.displayName || e.target.value,
            });
          }}
          disabled={disabled || printersLoading}
          className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg-raised)] px-2 py-1 text-[12px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-50"
        >
          {printersLoading && <option value="">Loading…</option>}
          {!printersLoading && printers.length === 0 && (
            <option value="">No printers found</option>
          )}
          {printers.map((p) => (
            <option key={p.name} value={p.name}>
              {p.displayName}
              {p.isDefault ? " (default)" : ""}
            </option>
          ))}
        </select>
      </Row>

      <Row label="Copies">
        <input
          type="number"
          min={1}
          max={999}
          value={settings.copies}
          onChange={(e) =>
            dispatch({ type: "set-copies", value: Number(e.target.value) })
          }
          disabled={disabled}
          className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg-raised)] px-2 py-1 text-[12px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-50"
        />
      </Row>

      <div className="flex flex-col gap-1.5">
        <span className="text-[var(--muted)]">Pages</span>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            checked={pagesAll}
            onChange={() => {
              setPagesAll(true);
              dispatch({ type: "set-pages-input", value: "" });
            }}
            disabled={disabled}
          />
          <span className="text-[var(--app-fg)]">All pages</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            checked={!pagesAll}
            onChange={() => {
              setPagesAll(false);
              if (!settings.pagesInput) {
                dispatch({
                  type: "set-pages-input",
                  value: sourceTotalPages > 0 ? `1-${sourceTotalPages}` : "1",
                });
              }
            }}
            disabled={disabled}
          />
          <span className="text-[var(--app-fg)]">Range</span>
          <input
            type="text"
            value={settings.pagesInput}
            placeholder="1-3, 5"
            onChange={(e) => {
              setPagesAll(false);
              dispatch({ type: "set-pages-input", value: e.target.value });
            }}
            disabled={disabled || pagesAll}
            className="ml-auto w-[110px] rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg-raised)] px-2 py-0.5 text-[11px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-50"
          />
        </label>
        {rangeError && (
          <span className="text-[11px] text-[var(--destructive)]">{rangeError}</span>
        )}
        {!rangeError && !pagesAll && (
          <span className="text-[11px] text-[var(--muted)]">
            Pages from your document, before layout is applied.
          </span>
        )}
      </div>

      <Row label="Paper">
        <select
          value={settings.paper}
          onChange={(e) =>
            dispatch({ type: "set-paper", value: e.target.value as PaperKey })
          }
          disabled={disabled}
          className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg-raised)] px-2 py-1 text-[12px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-50"
        >
          {PAPER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Row>

      <Row label="Layout">
        <select
          value={settings.layout}
          onChange={(e) =>
            dispatch({ type: "set-layout", value: Number(e.target.value) as PerSheet })
          }
          disabled={disabled}
          className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg-raised)] px-2 py-1 text-[12px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-50"
        >
          {PER_SHEET_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Row>

      <Row label="Orientation">
        <div className="flex gap-1.5">
          <OrientationButton
            active={settings.orientation === "portrait"}
            onClick={() => dispatch({ type: "set-orientation", value: "portrait" })}
            disabled={disabled}
            label="Portrait"
          />
          <OrientationButton
            active={settings.orientation === "landscape"}
            onClick={() => dispatch({ type: "set-orientation", value: "landscape" })}
            disabled={disabled}
            label="Landscape"
          />
        </div>
      </Row>

      <button
        type="button"
        onClick={() => setMoreOpen((v) => !v)}
        disabled={disabled}
        className="mt-1 flex items-center gap-1 self-start text-[11px] text-[var(--muted)] hover:text-[var(--app-fg)] disabled:opacity-50"
      >
        <span>{moreOpen ? "▾" : "▸"} More options</span>
      </button>

      {moreOpen && (
        <>
          <Row label="Color">
            <div className="flex gap-1.5">
              <OrientationButton
                active={settings.color}
                onClick={() => dispatch({ type: "set-color", value: true })}
                disabled={disabled}
                label="Color"
              />
              <OrientationButton
                active={!settings.color}
                onClick={() => dispatch({ type: "set-color", value: false })}
                disabled={disabled}
                label="B&W"
              />
            </div>
          </Row>
          <Row label="Two-sided">
            <select
              value={settings.duplex}
              onChange={(e) =>
                dispatch({ type: "set-duplex", value: e.target.value as DuplexMode })
              }
              disabled={disabled}
              className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg-raised)] px-2 py-1 text-[12px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-50"
            >
              {DUPLEX_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Row>
        </>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[var(--muted)]">{label}</span>
      {children}
    </div>
  );
}

function OrientationButton({
  active,
  onClick,
  disabled,
  label,
}: {
  active: boolean;
  onClick: () => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 rounded-md border px-2 py-1 text-[12px] transition-colors disabled:opacity-50 ${
        active
          ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--app-fg)] font-medium"
          : "border-[var(--panel-border)] bg-[var(--panel-bg-raised)] text-[var(--muted)] hover:text-[var(--app-fg)]"
      }`}
    >
      {label}
    </button>
  );
}

/* ─── Preview pane ──────────────────────────────────────────────────── */

function PreviewPane({
  pdf,
  pageNumber,
  busy,
}: {
  pdf: pdfjsLib.PDFDocumentProxy | null;
  pageNumber: number;
  busy: boolean;
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
      try { renderTask?.cancel(); } catch { /* ignore */ }
    };
  }, [pdf, pageNumber]);

  return (
    <div
      ref={containerRef}
      className="relative flex flex-1 items-center justify-center overflow-auto bg-[var(--panel-bg)] p-4"
      data-testid="print-preview-pane"
    >
      {!pdf ? (
        <div className="text-[13px] text-[var(--muted)]">
          {busy ? "Building preview…" : "No preview yet"}
        </div>
      ) : (
        <div className="rounded-md border border-[var(--panel-border)] bg-white shadow-sm">
          <canvas
            ref={canvasRef}
            className={`block ${renderedPage === pageNumber ? "" : "opacity-0"}`}
          />
        </div>
      )}
      {busy && pdf && (
        <div className="absolute right-3 top-3 flex items-center gap-1.5 rounded-full bg-black/40 px-2 py-1 text-[11px] text-white backdrop-blur">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Updating…</span>
        </div>
      )}
    </div>
  );
}

/* ─── Page pager ────────────────────────────────────────────────────── */

function PagePager({
  page,
  count,
  onChange,
  disabled,
}: {
  page: number;
  count: number;
  onChange: (n: number) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center justify-center gap-2 border-t border-[var(--panel-border)] bg-[var(--panel-bg)] py-2 text-[11px] text-[var(--muted)]">
      <button
        type="button"
        onClick={() => onChange(Math.max(1, page - 1))}
        disabled={disabled || page <= 1}
        className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--hover-bg)] disabled:opacity-30"
        aria-label="Previous page"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <span className="tabular-nums">
        Sheet {page} of {count}
      </span>
      <button
        type="button"
        onClick={() => onChange(Math.min(count, page + 1))}
        disabled={disabled || page >= count}
        className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--hover-bg)] disabled:opacity-30"
        aria-label="Next page"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
