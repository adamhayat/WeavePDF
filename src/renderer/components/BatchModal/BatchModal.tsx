import { useState } from "react";
import { X, Layers, CheckCircle2, AlertCircle, Play } from "lucide-react";
import { compressLight, drawTextWatermark, rotatePages } from "../../lib/pdf-ops";
import { u8ToAb } from "../../../shared/buffers";

type Props = { open: boolean; onClose: () => void };

type Op = "compress" | "watermark" | "rotate90" | "rotate180";

type PickedFile = {
  path: string;
  name: string;
  sizeBytes: number;
  bytes: Uint8Array;
};

type FileResult =
  | { status: "pending"; file: PickedFile }
  | { status: "ok"; file: PickedFile; outPath: string; newSize: number }
  | { status: "error"; file: PickedFile; error: string };

const OP_LABELS: Record<Op, string> = {
  compress: "Compress",
  watermark: "Add text watermark",
  rotate90: "Rotate 90° clockwise",
  rotate180: "Rotate 180°",
};

export function BatchModal({ open, onClose }: Props) {
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [op, setOp] = useState<Op>("compress");
  const [watermarkText, setWatermarkText] = useState("DRAFT");
  const [suffix, setSuffix] = useState("-processed");
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<FileResult[]>([]);

  if (!open) return null;

  const pickFiles = async () => {
    const r = await window.weavepdf.openFileDialog({
      title: "Select PDFs for batch",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
      multi: true,
    });
    if (r.canceled) return;
    const picked = r.files.map((f) => ({
      path: f.path,
      name: f.name,
      sizeBytes: f.sizeBytes,
      bytes: new Uint8Array(f.data),
    }));
    setFiles(picked);
    setResults([]);
  };

  const run = async () => {
    if (files.length === 0 || running) return;
    setRunning(true);
    const next: FileResult[] = files.map((f) => ({ status: "pending", file: f }));
    setResults(next);
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        let out: Uint8Array;
        if (op === "compress") {
          out = await compressLight(file.bytes);
        } else if (op === "watermark") {
          out = await drawTextWatermark(file.bytes, watermarkText, { opacity: 0.2, rotation: 45 });
        } else if (op === "rotate90") {
          // Rotate every page.
          const pages = await pageIndices(file.bytes);
          out = await rotatePages(file.bytes, pages, 90);
        } else {
          const pages = await pageIndices(file.bytes);
          out = await rotatePages(file.bytes, pages, 180);
        }
        const outPath = file.path.replace(/\.pdf$/i, `${suffix}.pdf`);
        // Bless the derived output path — source was blessed by the dialog;
        // this says "same dir, related filename" is OK to write.
        const blessed = await window.weavepdf.blessDerivedPath(file.path, outPath);
        if (!blessed) throw new Error("Output path rejected by allowlist");
        const w = await window.weavepdf.writeFile(outPath, u8ToAb(out));
        if (!w.ok) throw new Error(w.error);
        next[i] = { status: "ok", file, outPath, newSize: out.byteLength };
      } catch (err) {
        next[i] = { status: "error", file, error: (err as Error).message ?? String(err) };
      }
      setResults([...next]);
    }
    setRunning(false);
  };

  const hasResults = results.length > 0;
  const okCount = results.filter((r) => r.status === "ok").length;
  const errCount = results.filter((r) => r.status === "error").length;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !running) onClose();
      }}
    >
      <div
        className="max-h-[80vh] w-[600px] overflow-hidden rounded-2xl border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] shadow-2xl"
        data-testid="batch-modal"
      >
        <div className="flex items-center justify-between border-b border-[var(--panel-border)] px-5 py-3">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.8} />
            <h2 className="text-[15px] font-semibold">Batch operation</h2>
            {files.length > 0 && (
              <span className="text-[11px] tabular-nums text-[var(--muted)]">
                {files.length} file{files.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)] disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>

        <div className="px-5 py-4">
          <div className="mb-4 flex items-center gap-2">
            <button
              type="button"
              onClick={pickFiles}
              disabled={running}
              className="h-8 rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-3 text-[12px] text-[var(--app-fg)] hover:bg-[var(--hover-bg)] disabled:opacity-50"
            >
              Select PDFs…
            </button>
            {files.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setFiles([]);
                  setResults([]);
                }}
                disabled={running}
                className="text-[11px] text-[var(--muted)] hover:text-[var(--app-fg)] disabled:opacity-50"
              >
                Clear
              </button>
            )}
          </div>

          <div className="mb-4 grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">Operation</span>
              <select
                value={op}
                onChange={(e) => setOp(e.target.value as Op)}
                disabled={running}
                className="h-8 rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-50"
              >
                {Object.entries(OP_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">Output suffix</span>
              <input
                value={suffix}
                onChange={(e) => setSuffix(e.target.value || "-processed")}
                disabled={running}
                className="h-8 rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-50"
              />
            </label>
          </div>

          {op === "watermark" && (
            <label className="mb-4 flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">Watermark text</span>
              <input
                value={watermarkText}
                onChange={(e) => setWatermarkText(e.target.value)}
                disabled={running}
                className="h-8 rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-50"
              />
            </label>
          )}

          <div className="max-h-[260px] overflow-y-auto rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)]">
            {files.length === 0 ? (
              <div className="p-6 text-center text-[12px] text-[var(--muted)]">
                No files selected yet. Pick one or more PDFs to get started.
              </div>
            ) : (
              <ul className="divide-y divide-[var(--panel-border)]">
                {files.map((f, i) => {
                  const r = hasResults ? results[i] : null;
                  return (
                    <li key={f.path} className="flex items-center justify-between gap-2 px-3 py-2">
                      <span className="truncate text-[12px] text-[var(--app-fg)]" title={f.path}>
                        {f.name}
                      </span>
                      <span className="flex items-center gap-2 text-[11px] tabular-nums text-[var(--muted)]">
                        {r?.status === "ok" && (
                          <>
                            <CheckCircle2 className="h-3.5 w-3.5 text-[var(--color-success)]" strokeWidth={2} />
                            {(r.newSize / 1024).toFixed(0)} KB
                          </>
                        )}
                        {r?.status === "error" && (
                          <>
                            <AlertCircle className="h-3.5 w-3.5 text-[var(--color-destructive)]" strokeWidth={2} />
                            <span className="max-w-[160px] truncate" title={r.error}>
                              {r.error}
                            </span>
                          </>
                        )}
                        {r?.status === "pending" && <span>waiting…</span>}
                        {!r && <span>{(f.sizeBytes / 1024).toFixed(0)} KB</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-[var(--panel-border)] px-5 py-3">
          <div className="text-[11px] text-[var(--muted)]">
            {hasResults && !running && `${okCount} succeeded · ${errCount} failed`}
            {running && "Running…"}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={running}
              className="h-8 rounded-md border border-[var(--panel-border)] px-3 text-[12px] text-[var(--app-fg)] hover:bg-[var(--hover-bg)] disabled:opacity-50"
            >
              {hasResults ? "Done" : "Cancel"}
            </button>
            <button
              type="button"
              onClick={run}
              disabled={running || files.length === 0}
              className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
              data-testid="batch-run"
            >
              <Play className="h-3 w-3" strokeWidth={2.5} />
              {running ? "Running…" : `Run on ${files.length} file${files.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

async function pageIndices(bytes: Uint8Array): Promise<number[]> {
  // Load to peek at page count. Cheap — skip fonts/images by just counting.
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  return Array.from({ length: doc.getPageCount() }, (_, i) => i + 1);
}
