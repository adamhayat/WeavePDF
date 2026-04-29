import { useEffect, useRef, useState } from "react";
import { X, ScanText, CheckCircle2 } from "lucide-react";
import { useDocumentStore } from "../../stores/document";
import { applyOcrTextLayer, type OcrPageResult } from "../../lib/pdf-ops";
import { u8ToAb } from "../../../shared/buffers";

type Props = { open: boolean; onClose: () => void };

type Phase = "idle" | "checking" | "ready" | "running" | "done" | "error";

export function OcrModal({ open, onClose }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const applyEdit = useDocumentStore((s) => s.applyEdit);
  const [phase, setPhase] = useState<Phase>("idle");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [boxCount, setBoxCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setPhase("checking");
    setError(null);
    setCurrentPage(0);
    setBoxCount(0);
    cancelRef.current = false;
    void (async () => {
      try {
        const ok = await window.weavepdf.ocr.available();
        setAvailable(ok);
        setPhase(ok ? "ready" : "error");
        if (!ok) setError("The OCR helper isn't built. Run `node scripts/build-ocr.mjs`, then repackage.");
      } catch (err) {
        setAvailable(false);
        setPhase("error");
        setError((err as Error).message ?? String(err));
      }
    })();
  }, [open]);

  if (!open || !activeTab) return null;

  const runOcr = async () => {
    if (!activeTab.pdf || !activeTab.bytes) return;
    setPhase("running");
    setError(null);
    setBoxCount(0);
    setCurrentPage(0);
    setTotalPages(activeTab.numPages);
    const results: OcrPageResult[] = [];
    let total = 0;
    try {
      for (let p = 1; p <= activeTab.numPages; p++) {
        if (cancelRef.current) break;
        setCurrentPage(p);
        const pngBytes = await renderPageToPng(activeTab.pdf, p, 2);
        const boxes = await window.weavepdf.ocr.runImage(u8ToAb(pngBytes));
        total += boxes.length;
        setBoxCount(total);
        results.push({ page: p, boxes });
      }
      if (cancelRef.current) {
        setPhase("ready");
        return;
      }
      const newBytes = await applyOcrTextLayer(activeTab.bytes, results);
      await applyEdit(activeTab.id, newBytes);
      setPhase("done");
    } catch (err) {
      setPhase("error");
      setError((err as Error).message ?? String(err));
    }
  };

  const cancel = () => {
    cancelRef.current = true;
  };

  const busy = phase === "running";

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="w-[500px] overflow-hidden rounded-2xl border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] shadow-2xl"
        data-testid="ocr-modal"
      >
        <div className="flex items-center justify-between border-b border-[var(--panel-border)] px-5 py-3">
          <div className="flex items-center gap-2">
            <ScanText className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.8} />
            <h2 className="text-[15px] font-semibold">OCR (Apple Vision)</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)] disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>

        <div className="px-5 py-5">
          <p className="mb-3 text-[13px] leading-relaxed text-[var(--app-fg)]">
            Adds a hidden, searchable text layer to this PDF by running Apple Vision on every page. Nothing leaves your Mac.
          </p>
          <p className="mb-4 text-[12px] text-[var(--muted)]">
            {activeTab.numPages} page{activeTab.numPages === 1 ? "" : "s"}
            {" · "}runs locally via the built-in OCR engine
          </p>

          {phase === "checking" && (
            <p className="text-[12px] text-[var(--muted)]">Checking OCR helper…</p>
          )}

          {phase === "error" && (
            <div className="rounded-md border border-[var(--color-destructive)]/40 bg-[var(--color-destructive)]/10 p-3 text-[12px] text-[var(--color-destructive)]">
              {error}
            </div>
          )}

          {phase === "running" && (
            <div>
              <div className="mb-1.5 flex items-center justify-between text-[12px]">
                <span className="text-[var(--app-fg)]">
                  Page {currentPage} of {totalPages}
                </span>
                <span className="tabular-nums text-[var(--muted)]">
                  {boxCount} region{boxCount === 1 ? "" : "s"} found
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-[var(--panel-border)]">
                <div
                  className="h-full bg-[var(--color-accent)] transition-all"
                  style={{
                    width: `${totalPages ? Math.round((currentPage / totalPages) * 100) : 0}%`,
                  }}
                />
              </div>
            </div>
          )}

          {phase === "done" && (
            <div className="flex items-center gap-2 rounded-md border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 p-3 text-[12px] text-[var(--app-fg)]">
              <CheckCircle2 className="h-4 w-4 text-[var(--color-success)]" strokeWidth={2} />
              OCR complete. Added {boxCount} text region{boxCount === 1 ? "" : "s"}. The PDF is now searchable.
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--panel-border)] px-5 py-3">
          {busy ? (
            <>
              <button
                type="button"
                onClick={cancel}
                className="h-8 rounded-md border border-[var(--panel-border)] px-3 text-[12px] text-[var(--app-fg)] hover:bg-[var(--hover-bg)]"
              >
                Cancel after current page
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className="h-8 rounded-md border border-[var(--panel-border)] px-3 text-[12px] text-[var(--app-fg)] hover:bg-[var(--hover-bg)]"
              >
                {phase === "done" ? "Done" : "Cancel"}
              </button>
              {phase === "ready" && (
                <button
                  type="button"
                  onClick={runOcr}
                  disabled={!available}
                  className="h-8 rounded-md bg-[var(--color-accent)] px-3 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
                  data-testid="ocr-run"
                >
                  Run OCR
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

async function renderPageToPng(
  pdf: NonNullable<ReturnType<typeof useDocumentStore.getState>["tabs"][number]["pdf"]>,
  pageNum: number,
  scale: number,
): Promise<Uint8Array> {
  const page = await pdf.getPage(pageNum);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("OCR: canvas 2d context unavailable");
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
  });
  return new Uint8Array(await blob.arrayBuffer());
}
