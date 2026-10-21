import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Printer, X } from "lucide-react";
import { useDocumentStore, waitForTabIdle } from "../../stores/document";
import { flushActiveFormField } from "../../lib/pending-field";
import { loadPrintPrefs, prefsPatchFromAction, savePrintPrefs } from "../../lib/print-prefs";
import * as pdfjsLib from "pdfjs-dist";
import "../../lib/pdfjs"; // ensure worker initialized
import { u8ToAb } from "../../../shared/buffers";
import type { PrinterInfo } from "../../../shared/ipc";
import {
  parsePageRanges,
  usePrintReducer,
  type PrintAction,
  type DuplexMode,
  type PaperKey,
  type PerSheet,
} from "./usePrintReducer";

// pdf-ops is in a separate Vite chunk; lazy to keep the boot bundle small.
const loadPdfOps = () => import("../../lib/pdf-ops");

/** Point dimensions of each Paper option, orientation-independent (short edge
 *  first). Mirrors PAPER_SIZES in pdf-ops; kept local so the modal can size
 *  itself without pulling in the lazy pdf-ops chunk just to read constants. */
const PAPER_POINTS: Record<PaperKey, [number, number]> = {
  letter: [612, 792],
  legal: [612, 1008],
  a4: [595.28, 841.89],
  a3: [841.89, 1190.55],
  a5: [419.53, 595.28],
  tabloid: [792, 1224],
};

/** CUPS media names for `lp -o media=…`. */
const CUPS_MEDIA: Record<PaperKey, string> = {
  letter: "Letter",
  legal: "Legal",
  a4: "A4",
  a3: "A3",
  a5: "A5",
  tabloid: "Tabloid",
};

/** pdf.js's "PDFWorker.fromPort - the worker is being destroyed" — transient:
 *  another document on the shared worker port is mid-destroy. */
export function isWorkerTeardownError(err: unknown): boolean {
  return err instanceof Error && /worker is being destroyed/i.test(err.message);
}

type Props = {
  open: boolean;
  onClose: () => void;
};

// V1.0085: Layout absorbs the "Fit all on one sheet" mode (was the V1.0084
// "Shrink to one sheet" Scale option — confusingly mode-mixed). Pages-per-
// sheet now ranges 1/2/4/6/9 + the dynamic "fit" grid that computes
// ceil(sqrt(n)) × ceil(n/cols) on the fly so a 30-page doc actually fits on
// one sheet (no 9-cap).
const PER_SHEET_OPTIONS: { value: PerSheet; label: string }[] = [
  { value: 1, label: "1 page per sheet" },
  { value: 2, label: "2 pages per sheet" },
  { value: 4, label: "4 pages per sheet" },
  { value: 6, label: "6 pages per sheet" },
  { value: 9, label: "9 pages per sheet" },
  { value: "fit", label: "Fit all on one sheet" },
];
const PAPER_OPTIONS: { value: PaperKey; label: string }[] = [
  { value: "letter", label: "US Letter" },
  { value: "legal", label: "US Legal" },
  { value: "a4", label: "A4" },
  { value: "a3", label: "A3" },
  { value: "a5", label: "A5" },
  { value: "tabloid", label: "Tabloid" },
];
const paperLabel = (k: PaperKey) => PAPER_OPTIONS.find((o) => o.value === k)?.label ?? k;
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
  const panelRef = useRef<HTMLDivElement>(null);
  const activeTab = useDocumentStore((s) => s.activeTab());
  const renderOutput = useDocumentStore((s) => s.renderOutput);
  // V1.0126: the document as it will print (clean page + every editable
  // element), built once per open into a private copy. Pre-V1.0126 opening
  // Print baked the elements INTO the open tab — marking it unsaved and
  // doubling every element on the next save.
  const [sourceBytes, setSourceBytes] = useState<Uint8Array | null>(null);

  // V1.0127: start from the settings the user chose last time (printer,
  // paper, layout, scale, full page, colour, two-sided). The dialog unmounts
  // on close, so before this every open started from factory defaults.
  const [initialPrefs] = useState(loadPrintPrefs);
  const [settings, dispatch] = usePrintReducer(initialPrefs);
  // User changes go through here and are remembered; the dialog's own seeding
  // (default printer, paper detected from the document) uses plain `dispatch`
  // so a guess never becomes a remembered choice.
  const userDispatch = useCallback(
    (action: PrintAction) => {
      dispatch(action);
      const patch = prefsPatchFromAction(action);
      if (patch) savePrintPrefs(patch);
    },
    [dispatch],
  );
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
    // V1.0123: focus the dialog PANEL, not the ✕. Focusing the close button
    // meant pressing Return the instant the dialog opened dismissed it — and
    // Return is exactly what a user presses to confirm a dialog. Focusing the
    // Print button instead would be worse (Return would fire a real print job),
    // so the panel takes focus: Escape still closes, Tab still reaches every
    // control, and Return does nothing until the user chooses a button.
    requestAnimationFrame(() => panelRef.current?.focus());
  }, [open]);

  // ── Bake pending overlays + capture source page count ────────────────
  useEffect(() => {
    if (!open || !activeTab) return;
    // V1.0123: flush the form field (V1.0126: or WeavePDF text box) still
    // holding the caret and wait for any running edit before rendering —
    // ⌘P doesn't blur, so the sheet could be printed without the value the
    // user just typed.
    const tabId = activeTab.id;
    let cancelled = false;
    setSourceBytes(null);
    void (async () => {
      await flushActiveFormField();
      await waitForTabIdle(tabId);
      const out = await renderOutput(tabId);
      if (!cancelled) setSourceBytes(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, activeTab?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setSourceTotalPages(activeTab?.numPages ?? 0);
  }, [activeTab?.numPages]);

  // ── V1.0121: seed Paper + Orientation from the DOCUMENT ──────────────
  // These used to be hardcoded to US Letter / portrait no matter what was
  // open. For a landscape or A4 source that meant the fit branch below was
  // skipped (its condition compared against those hardcoded defaults rather
  // than the real page), so the source went to the printer at its own size and
  // the driver clipped whatever overflowed — the "printing cuts off pages"
  // report. Reading page 1's viewport (which already accounts for /Rotate)
  // makes the defaults match what the user is looking at, exactly like every
  // native print dialog.
  const [sourceSheet, setSourceSheet] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (!open || !activeTab?.pdf) return;
    let cancelled = false;
    void (async () => {
      try {
        const page = await activeTab.pdf!.getPage(1);
        const vp = page.getViewport({ scale: 1 });
        if (cancelled) return;
        setSourceSheet({ width: vp.width, height: vp.height });
        // V1.0128: an orientation the user chose is remembered and wins;
        // the document's shape is only the first-time default.
        if (!loadPrintPrefs().orientation) {
          dispatch({
            type: "set-orientation",
            value: vp.width > vp.height ? "landscape" : "portrait",
          });
        }
        // V1.0127: Paper is NO LONGER taken from the document. An A4 invoice
        // set Paper = A4 while the printer had Letter loaded, so the A4
        // layout was printed onto Letter and ~18 mm was cut off (Adam,
        // 2026-10-13). Paper now = the user's remembered choice, else the
        // printer's own default (see the effect below); the fit step scales
        // an off-size document onto that sheet.
      } catch {
        // Unreadable page 1 — keep the Letter/portrait defaults.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, activeTab?.id, activeTab?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load printers once on open ──────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPrintersLoading(true);
    void window.weavepdf.listPrinters().then((list) => {
      if (cancelled) return;
      setPrinters(list);
      setPrintersLoading(false);
      // Pick the OS default if we don't already have a selection — or if the
      // remembered printer (V1.0127) is no longer installed.
      const remembered = settings.deviceName
        ? list.find((p) => p.name === settings.deviceName)
        : undefined;
      if (remembered) {
        if (remembered.displayName !== settings.deviceDisplayName) {
          dispatch({
            type: "set-printer",
            name: remembered.name,
            displayName: remembered.displayName,
          });
        }
      } else {
        const def = list.find((p) => p.isDefault) ?? list[0];
        if (def) {
          dispatch({
            type: "set-printer",
            name: def.name,
            displayName: def.displayName,
          });
        } else if (settings.deviceName) {
          // No printers at all: don't keep a remembered name we can't print to.
          dispatch({ type: "set-printer", name: "", displayName: "" });
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── V1.0127: Paper follows the selected printer's loaded paper ───────
  // unless the user picked a Paper themselves (remembered in print-prefs).
  const selectedPrinter = printers.find((p) => p.name === settings.deviceName);
  useEffect(() => {
    if (!selectedPrinter || loadPrintPrefs().paper) return;
    const loaded = selectedPrinter.defaultPaper ?? "letter";
    if (loaded !== settings.paper) dispatch({ type: "set-paper", value: loaded });
  }, [selectedPrinter]); // eslint-disable-line react-hooks/exhaustive-deps

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
      settings.scalePct,
      settings.fullPage ? "1" : "0",
      // Cache by parsed ranges, not raw input (prevents bouncing on
      // intermediate "1-" while user is typing).
      JSON.stringify(rangeParse.error ? [] : rangeParse.ranges),
      // V1.0122: the fit decision now measures the printed pages directly
      // (see needsFit below), but `sourceSheet` still seeds the paper /
      // orientation defaults asynchronously after open — keep it in the key
      // so the pipeline re-runs once the measurement lands and the preview
      // reflects the seeded defaults.
      sourceSheet ? `${Math.round(sourceSheet.width)}x${Math.round(sourceSheet.height)}` : "?",
    ].join("|");
  }, [
    activeTab?.id,
    activeTab?.version,
    settings.paper,
    settings.layout,
    settings.orientation,
    settings.scalePct,
    settings.fullPage,
    rangeParse,
    sourceSheet,
  ]);

  useEffect(() => {
    if (!open || !sourceBytes) return;
    let cancelled = false;
    setPreviewBusy(true);
    setPreviewError(null);

    // Debounce 120ms so rapid radio-button clicks don't fire 5 rebuilds.
    const debounce = setTimeout(() => {
      if (cancelled) return;
      void (async () => {
        try {
          const ops = await loadPdfOps();
          let bytes = sourceBytes;

          // 1. Page-range filter (if user typed a range).
          // `printedPages` keeps the ORIGINAL 1-based numbers of the pages
          // going to the printer — the fit decision below must measure THOSE
          // pages, not page 1 (V1.0122: a range print of an A3 page 2 in a
          // Letter-page-1 doc used to skip the fit and clip).
          let printedPages: number[] | null = null;
          if (rangeParse.ranges.length > 0) {
            // Flatten ranges to a sorted, dedup'd 1-based index list.
            const indices = new Set<number>();
            for (const r of rangeParse.ranges) {
              for (let i = r.from; i <= r.to; i++) indices.add(i);
            }
            const list = Array.from(indices).sort((a, b) => a - b);
            printedPages = list;
            bytes = await ops.extractPages(bytes, list);
          }

          // 2. Layout dispatch.
          //   - "fit" → V1.0086 content-aware single-sheet composition.
          //   - n-up (>1) → V1.0083 nUpPages with explicit grid; scale
          //     composes via the legacy scalePageContent multiplier
          //     inside each tile.
          //   - 1-up + fullPage ON → V1.0088 scaleToFitForPrint: auto-
          //     rotates content when source aspect mismatches sheet
          //     aspect and scales it to fill the printable area
          //     (scale=100% fills exactly).
          //   - 1-up + fullPage OFF (V1.0089 default) → render the
          //     source at its intrinsic size. Apply the slider as a
          //     literal scale (legacy scalePageContent). Apply
          //     fitToPaper ONLY when paper/orientation explicitly
          //     differ from the source defaults (Letter portrait); for
          //     Letter portrait the source is rendered untouched, so
          //     Adam's cert at 100% looks identical to opening it in
          //     Preview.
          if (settings.layout === "fit") {
            bytes = await ops.fitAllOntoSingleSheet(
              bytes,
              settings.paper,
              settings.orientation,
            );
          } else if (settings.layout > 1) {
            // V1.0122: every rebuild below goes through embedPdf, which
            // carries page content only — flatten filled form fields into the
            // page first so the printout keeps the user's answers.
            try {
              bytes = await ops.flattenFormsForPrint(bytes);
            } catch {
              // exotic fields — print with live fields rather than lose them
            }
            // V1.0128: Full page at n-up = trim every page's white margins
            // (one shared box) so the content fills its tile.
            if (settings.fullPage) {
              try {
                bytes = await ops.trimPagesToContentForPrint(bytes);
              } catch {
                // permissive — print untrimmed rather than fail
              }
            }
            if (settings.scalePct !== 100) {
              try {
                bytes = await ops.scalePageContent(bytes, settings.scalePct / 100);
              } catch {
                // permissive — fall back to unscaled bytes
              }
            }
            bytes = await ops.nUpPages(bytes, settings.layout as 2 | 4 | 6 | 9, {
              paper: settings.paper,
              orientation: settings.orientation,
            });
          } else if (settings.fullPage) {
            try {
              bytes = await ops.flattenFormsForPrint(bytes); // see layout>1 note
              bytes = await ops.scaleToFitForPrint(
                bytes,
                settings.paper,
                settings.orientation,
                settings.scalePct,
              );
            } catch {
              // permissive — fall back to source bytes
            }
          } else {
            if (settings.scalePct !== 100) {
              try {
                bytes = await ops.flattenFormsForPrint(bytes); // see layout>1 note
                bytes = await ops.scalePageContent(bytes, settings.scalePct / 100);
              } catch {
                // permissive
              }
            }
            // V1.0121: decide by comparing the REAL source page against the
            // chosen sheet. The old condition was
            //   `paper !== "letter" || orientation === "landscape"`
            // i.e. it compared the user's selection against a hardcoded
            // "Letter portrait" assumption about the source. For a landscape
            // or A4 document with the (now document-derived) defaults, that
            // test is false, so nothing was fitted and the oversized page went
            // to the driver, which clipped the overflow — the "cuts off pages"
            // report. Skipping the fit when the sizes already match matters:
            // fitToPaper rebuilds the document via embedPdf, which drops the
            // AcroForm, so it must not run on the common same-size path.
            const target = PAPER_POINTS[settings.paper];
            const [sheetW, sheetH] =
              settings.orientation === "landscape"
                ? [Math.max(...target), Math.min(...target)]
                : [Math.min(...target), Math.max(...target)];
            // V1.0122: measure the pages actually being PRINTED, not page 1.
            // Mixed-size docs (which drag-to-merge produces) and range prints
            // of an off-size page used to be judged by page 1's geometry and
            // go to the driver unfitted — clipped, with `media=` now forcing
            // the wrong tray on top. Early-exit on the first mismatch; a
            // measurement FAILURE means no fit (keep-the-defaults fallback —
            // the old `!sourceSheet ||` forced the destructive path instead).
            let needsFit = false;
            try {
              const src = activeTab!.pdf!;
              const nums =
                printedPages ?? Array.from({ length: src.numPages }, (_, i) => i + 1);
              for (const n of nums) {
                const vp = (await src.getPage(n)).getViewport({ scale: 1 });
                if (
                  Math.abs(vp.width - sheetW) > 2 ||
                  Math.abs(vp.height - sheetH) > 2
                ) {
                  needsFit = true;
                  break;
                }
              }
            } catch {
              needsFit = false;
            }
            if (needsFit) {
              try {
                // fitToPaper rebuilds via embedPdf (page content only) —
                // flatten filled fields first so answers survive in print.
                bytes = await ops.flattenFormsForPrint(bytes);
                // V1.0127: 18 pt margin — the same as n-up / Full page. Laser
                // printers can't print the outer ~6 mm (Adam's Brother:
                // ImageableArea 18/12 pt), so an edge-to-edge fit lost
                // whatever the preview showed in that strip.
                bytes = await ops.fitToPaper(bytes, settings.paper, {
                  orientation: settings.orientation,
                  margin: 18,
                });
              } catch {
                // fitToPaper is permissive
              }
            }
          }

          if (cancelled) return;
          printBytesRef.current = bytes;

          // pdf.js sequenced load.
          let task: ReturnType<typeof pdfjsLib.getDocument> | null = null;
          let loaded: pdfjsLib.PDFDocumentProxy | null = null;
          try {
            // V1.0131: pdf.js shares ONE worker; if another document is
            // still being destroyed (a tab just closed, a pdf-ops helper that
            // didn't await its destroy), getDocument throws "the worker is
            // being destroyed" — Adam saw it as "Preview error: PDFWorker.
            // fromPort…". Wait for the teardown and retry once.
            for (let attempt = 0; ; attempt++) {
              task = pdfjsLib.getDocument({ data: new Uint8Array(u8ToAb(bytes)) });
              loadingTaskRef.current = task;
              try {
                loaded = await task.promise;
                break;
              } catch (err) {
                if (attempt >= 2 || !isWorkerTeardownError(err)) throw err;
                await new Promise((r) => setTimeout(r, 150));
                if (cancelled) return;
              }
            }
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
  }, [open, previewKey, sourceBytes]); // eslint-disable-line react-hooks/exhaustive-deps

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
          // V1.0121: the Paper dropdown reached the page geometry but never the
          // printer, so CUPS kept pulling its default tray and rescaled/clipped
          // the job to that media.
          media: CUPS_MEDIA[settings.paper],
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
    // V1.0122: `media` reads settings.paper inside this callback. Without the
    // dep, changing ONLY the Paper dropdown left the memoized closure holding
    // the previous paper, so lp got a stale `-o media=` and CUPS pulled the
    // wrong tray — the exact bug the media flag was added to fix.
    settings.paper,
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
        ref={panelRef}
        tabIndex={-1}
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
            dispatch={userDispatch}
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
              <div className="border-t border-[var(--panel-border)] bg-[var(--panel-bg)] px-6 py-2 text-[11px] text-[var(--color-destructive)]">
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
              <span className="ml-3 text-[var(--color-destructive)]">{printError}</span>
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
  dispatch: (action: PrintAction) => void;
  printers: PrinterInfo[];
  printersLoading: boolean;
  sourceTotalPages: number;
  rangeError: string | null;
  disabled: boolean;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  // V1.0127: warn when the chosen Paper isn't the paper the printer is set up
  // for — that mismatch is exactly what cut Adam's invoice off.
  const printerPaper = printers.find((p) => p.name === settings.deviceName)?.defaultPaper;
  const paperMismatch = !!printerPaper && printerPaper !== settings.paper;
  const [pagesAll, setPagesAll] = useState(true);
  const rangeRef = useRef<HTMLInputElement>(null);

  // Switch "All pages" radio on whenever the input is empty.
  // V1.0123: …but NOT while the caret is in the range box. Clearing the field
  // to retype a range (select-all + delete) momentarily empties it, which used
  // to flip the radio to "All pages", DISABLE the input and drop focus — so
  // the rest of what the user typed went nowhere and the box stayed empty.
  useEffect(() => {
    if (settings.pagesInput.trim() !== "") {
      setPagesAll(false);
      return;
    }
    if (document.activeElement === rangeRef.current) return; // mid-edit
    setPagesAll(true);
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
            ref={rangeRef}
            type="text"
            value={settings.pagesInput}
            placeholder="1-3, 5"
            onChange={(e) => {
              setPagesAll(false);
              dispatch({ type: "set-pages-input", value: e.target.value });
            }}
            // Leaving the box empty is the user's way of saying "all pages" —
            // apply it on blur, once they're done editing.
            onBlur={() => {
              if (settings.pagesInput.trim() === "") setPagesAll(true);
            }}
            disabled={disabled || pagesAll}
            className="ml-auto w-[110px] rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg-raised)] px-2 py-0.5 text-[11px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-50"
          />
        </label>
        {rangeError && (
          <span className="text-[11px] text-[var(--color-destructive)]">{rangeError}</span>
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
        {paperMismatch && (
          <span
            className="mt-1 block text-[11px] leading-snug text-[var(--color-warn,#FF9F0A)]"
            data-testid="print-paper-mismatch"
          >
            This printer is set up for {paperLabel(printerPaper!)} paper. Printing on{" "}
            {paperLabel(settings.paper)} will be cut off unless {paperLabel(settings.paper)}{" "}
            paper is loaded.
          </span>
        )}
      </Row>

      <Row label="Layout">
        <select
          value={settings.layout}
          onChange={(e) => {
            const raw = e.target.value;
            const v: PerSheet = raw === "fit" ? "fit" : (Number(raw) as PerSheet);
            dispatch({ type: "set-layout", value: v });
          }}
          disabled={disabled}
          data-testid="print-layout-select"
          className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg-raised)] px-2 py-1 text-[12px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-50"
        >
          {PER_SHEET_OPTIONS.map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
      </Row>

      {/* V1.0085: Scale is now an always-visible slider with a click-to-
          edit numeric readout. Replaces the old mode dropdown — Adam's
          feedback was the hidden text input felt awkward and the modes
          confused layout vs. scale. Disabled when Layout = "fit" because
          the fit-all path scales each tile to fill its cell; the slider
          value would have no visible effect. */}
      <Row label="Scale">
        <div className="flex w-full items-center gap-2">
          <input
            type="range"
            min={10}
            max={400}
            step={1}
            value={settings.scalePct}
            onChange={(e) =>
              dispatch({ type: "set-scale-pct", value: Number(e.target.value) })
            }
            disabled={disabled || settings.layout === "fit"}
            title={settings.layout === "fit" ? "Scale is auto-fit when Layout is 'Fit all on one sheet'." : undefined}
            data-testid="print-scale-slider"
            className="flex-1 accent-[var(--color-accent)] disabled:opacity-50"
          />
          <input
            type="number"
            min={10}
            max={400}
            value={settings.scalePct}
            onChange={(e) =>
              dispatch({ type: "set-scale-pct", value: Number(e.target.value) })
            }
            disabled={disabled || settings.layout === "fit"}
            data-testid="print-scale-input"
            className="w-14 rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg-raised)] px-2 py-1 text-right text-[12px] text-[var(--app-fg)] tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-50"
          />
          <span className="text-[11px] text-[var(--muted)]">%</span>
        </div>
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

      {/* V1.0089: explicit "Full page" opt-in. Default OFF so portrait
          renders the source as-is (Adam's "actual size" expectation).
          ON enables the V1.0088 auto-fit + auto-rotate behavior: each
          source page's content bbox is detected, rotated 90° if its
          aspect mismatches the sheet, and scaled to fill the printable
          area. Disabled when Layout = "fit" (the fit-all path already
          fills the sheet by design — Full page would be redundant). */}
      {/* V1.0127 disabled Full page at 2/4/6/9 per sheet (it silently did
          nothing there). V1.0128 makes it work instead: it trims every page's
          white margins so the content fills its tile (Adam: "it could work
          here"). Only "Fit all on one sheet" disables it — that mode already
          trims and fills. */}
      <Row label="Full page">
        <div className="flex gap-1.5">
          <OrientationButton
            active={settings.fullPage}
            onClick={() => dispatch({ type: "set-full-page", value: true })}
            disabled={disabled || settings.layout === "fit"}
            label="On"
          />
          <OrientationButton
            active={!settings.fullPage}
            onClick={() => dispatch({ type: "set-full-page", value: false })}
            disabled={disabled || settings.layout === "fit"}
            label="Off"
          />
        </div>
        {settings.layout === "fit" && (
          <span className="mt-1 block text-[11px] text-[var(--muted)]">
            "Fit all on one sheet" already fills the sheet.
          </span>
        )}
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
