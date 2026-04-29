import { useEffect, useMemo, useRef, useState } from "react";
import { X, Loader2, Sparkles, Check } from "lucide-react";
import { useDocumentStore } from "../../stores/document";
import { compressLight } from "../../lib/pdf-ops";
import { formatBytes, cn } from "../../lib/cn";
import { u8ToAb } from "../../../shared/buffers";

type Engine = "pdflib" | "qpdf" | "mutool" | "gs" | "gs-advanced";

type PresetSpec = {
  id: string;
  label: string;
  hint: string;
  engine: Engine;
  /** When engine === "gs" */
  gsQuality?: "screen" | "ebook" | "printer" | "prepress";
  /** When engine === "gs-advanced" */
  advanced?: { colorDpi: number; grayDpi: number; monoDpi: number; jpegQuality: number };
  /** Tags shown on the preset card. */
  tags: ("lossless" | "balanced" | "smallest" | "best-quality" | "smart")[];
  /** Requirement check — preset is greyed out + replaced with install hint
   *  when this returns false. */
  requires: () => Promise<boolean>;
};

// Five built-in presets, ordered from least → most destructive.
// **Critical:** every gs preset gets a qpdf post-pass for free 5-15% extra
// (see runPreset). When a result ends up ≥ 95% of the input, the row shows
// "Already optimized" instead of misleading −2% — small text PDFs literally
// grow under Ghostscript, the original is the right answer in that case.
const PRESETS: PresetSpec[] = [
  {
    id: "lossless-qpdf",
    label: "Lossless · qpdf re-pack",
    hint: "Object-stream compression + linearize. Visually identical, no image touching.",
    engine: "qpdf",
    tags: ["lossless"],
    requires: () => window.weavepdf.qpdf.available(),
  },
  {
    id: "lossless-mutool",
    label: "Lossless+ · mutool clean",
    hint: "MuPDF aggressive object dedup + stream recompression. Often beats qpdf on text-heavy docs.",
    engine: "mutool",
    tags: ["lossless", "smart"],
    requires: () => window.weavepdf.mutool.available(),
  },
  {
    id: "print-300",
    label: "Print · 300 DPI images",
    hint: "True print quality. Resamples to 300 dpi color/gray + 600 dpi mono. Indistinguishable from source.",
    engine: "gs-advanced",
    advanced: { colorDpi: 300, grayDpi: 300, monoDpi: 600, jpegQuality: 95 },
    tags: ["best-quality"],
    requires: () => window.weavepdf.ghostscript.available(),
  },
  {
    id: "balanced-150",
    label: "Balanced · 150 DPI images",
    hint: "Sweet spot for sharing. Crisp on Retina screens; small enough to email.",
    engine: "gs-advanced",
    advanced: { colorDpi: 150, grayDpi: 150, monoDpi: 300, jpegQuality: 80 },
    tags: ["balanced", "smart"],
    requires: () => window.weavepdf.ghostscript.available(),
  },
  {
    id: "smallest-72",
    label: "Smallest · 72 DPI images",
    hint: "Aggressive resample. Image quality drops noticeably. For email when size is critical.",
    engine: "gs-advanced",
    advanced: { colorDpi: 72, grayDpi: 72, monoDpi: 300, jpegQuality: 50 },
    tags: ["smallest"],
    requires: () => window.weavepdf.ghostscript.available(),
  },
];

const ALREADY_OPTIMIZED_THRESHOLD = 0.95;

type Props = { open: boolean; onClose: () => void };

type RowState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; bytes: Uint8Array; sizeBytes: number; thumb: string | null; ratio: number }
  | { phase: "missing"; reason: string }
  | { phase: "error"; error: string };

export function CompressModal({ open, onClose }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const applyEdit = useDocumentStore((s) => s.applyEdit);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  // Custom-tab state
  const [colorDpi, setColorDpi] = useState(150);
  const [grayDpi, setGrayDpi] = useState(150);
  const [monoDpi, setMonoDpi] = useState(450);
  const [jpegQuality, setJpegQuality] = useState(80);

  // Pre-compute is keyed off (tab.id, version) so when the user re-opens
  // the modal after an edit, results are recomputed against fresh bytes.
  const computeKey = useMemo(
    () => (activeTab ? `${activeTab.id}::${activeTab.version}` : null),
    [activeTab],
  );
  const lastComputeKey = useRef<string | null>(null);
  // Token used to invalidate in-flight preset runs when the modal re-opens
  // against new bytes — stale results from the previous compute won't be
  // written into state.
  const computeToken = useRef(0);

  // ─── Pre-compute every preset in parallel when the modal opens ───
  useEffect(() => {
    if (!open || !activeTab?.bytes || !computeKey) return;
    if (lastComputeKey.current === computeKey) return; // cached this version
    lastComputeKey.current = computeKey;
    setAppliedId(null);
    const myToken = ++computeToken.current;
    const initial: Record<string, RowState> = {};
    for (const p of PRESETS) initial[p.id] = { phase: "running" };
    setRows(initial);

    void (async () => {
      const before = activeTab.bytes!;
      const sourceBytes = activeTab.bytes!;
      // Promise.allSettled — we want every preset to run to completion even
      // if one engine is missing or errors. UI shows partial results.
      await Promise.allSettled(
        PRESETS.map(async (preset) => {
          // Availability gate first — surfaces the install hint without
          // actually shelling out.
          const available = await preset.requires().catch(() => false);
          if (!available) {
            if (computeToken.current === myToken) {
              setRows((prev) => ({
                ...prev,
                [preset.id]: { phase: "missing", reason: missingHint(preset.engine) },
              }));
            }
            return;
          }
          try {
            const out = await runPreset(preset, sourceBytes);
            const ratio = before.byteLength > 0 ? out.byteLength / before.byteLength : 1;
            // Render page 1 of the compressed output to a tiny thumbnail so
            // the user can see exactly what they're trading away in quality.
            const thumb = await renderFirstPageThumb(out).catch(() => null);
            if (computeToken.current === myToken) {
              setRows((prev) => ({
                ...prev,
                [preset.id]: { phase: "done", bytes: out, sizeBytes: out.byteLength, thumb, ratio },
              }));
            }
          } catch (err) {
            if (computeToken.current === myToken) {
              setRows((prev) => ({
                ...prev,
                [preset.id]: { phase: "error", error: (err as Error).message ?? String(err) },
              }));
            }
          }
        }),
      );
    })();
  }, [open, activeTab, computeKey]);

  // Reset cached results when the modal closes so the next open recomputes
  // against the latest bytes (in case of edits between opens of the same tab).
  useEffect(() => {
    if (!open) {
      lastComputeKey.current = null;
      computeToken.current++;
      setRows({});
      setAppliedId(null);
    }
  }, [open]);

  if (!open || !activeTab) return null;

  const before = activeTab.sizeBytes;

  // "Smart pick": smallest of the done presets that's tagged balanced or
  // best-quality AND actually shrunk the file (skip "Already optimized"
  // results). Falls back to the smallest overall when no safe option saved
  // bytes; null when nothing meaningful happened.
  const smartPick = ((): { id: string; sizeBytes: number } | null => {
    const done = (
      Object.entries(rows).filter(([, r]) => r.phase === "done") as Array<
        [string, Extract<RowState, { phase: "done" }>]
      >
    ).filter(([, r]) => r.ratio < ALREADY_OPTIMIZED_THRESHOLD);
    if (done.length === 0) return null;
    const safe = done.filter(([id]) => {
      const tags = PRESETS.find((p) => p.id === id)?.tags ?? [];
      return tags.includes("balanced") || tags.includes("best-quality") || tags.includes("smart");
    });
    const pool = safe.length > 0 ? safe : done;
    pool.sort((a, b) => a[1].sizeBytes - b[1].sizeBytes);
    return { id: pool[0][0], sizeBytes: pool[0][1].sizeBytes };
  })();

  const applyPreset = async (presetId: string) => {
    const row = rows[presetId];
    if (!row || row.phase !== "done") return;
    await applyEdit(activeTab.id, row.bytes);
    setAppliedId(presetId);
  };

  const runCustom = async () => {
    if (!activeTab?.bytes) return;
    const gsOk = await window.weavepdf.ghostscript.available();
    if (!gsOk) {
      alert("Ghostscript required for custom compression. Run `brew install ghostscript`.");
      return;
    }
    const customId = "custom";
    setRows((prev) => ({ ...prev, [customId]: { phase: "running" } }));
    try {
      const outAb = await window.weavepdf.ghostscript.compressAdvanced(u8ToAb(activeTab.bytes), {
        colorDpi,
        grayDpi,
        monoDpi,
        jpegQuality,
      });
      const out = new Uint8Array(outAb);
      const thumb = await renderFirstPageThumb(out).catch(() => null);
      setRows((prev) => ({
        ...prev,
        [customId]: {
          phase: "done",
          bytes: out,
          sizeBytes: out.byteLength,
          thumb,
          ratio: before > 0 ? out.byteLength / before : 1,
        },
      }));
    } catch (err) {
      setRows((prev) => ({
        ...prev,
        [customId]: { phase: "error", error: (err as Error).message ?? String(err) },
      }));
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[88vh] w-[640px] flex-col rounded-2xl border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] shadow-2xl"
        data-testid="compress-modal"
      >
        <div className="flex items-center justify-between border-b border-[var(--panel-border)] px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold">Compress PDF</h2>
            <p className="text-[11px] text-[var(--muted)]">
              WeavePDF runs every preset in parallel and shows the real output size — no fake estimates. Click a preset to apply.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3">
          <div className="mb-3 flex items-center justify-between px-2 text-[11px] text-[var(--muted)]">
            <span>
              Source: <span className="tnum text-[var(--app-fg)]">{formatBytes(before)}</span> · {activeTab.numPages} pages
            </span>
            {smartPick && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--color-accent)_15%,transparent)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-accent)]">
                <Sparkles className="h-3 w-3" strokeWidth={2} />
                Smart pick: {PRESETS.find((p) => p.id === smartPick.id)?.label.split("·")[0].trim()} · {formatBytes(smartPick.sizeBytes)}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-2">
            {PRESETS.map((preset) => {
              const row = rows[preset.id] ?? { phase: "idle" };
              const isApplied = appliedId === preset.id;
              const isSmart = smartPick?.id === preset.id;
              const ratioPct =
                row.phase === "done" ? Math.round((1 - row.ratio) * 100) : null;
              const noSavings = row.phase === "done" && row.ratio >= ALREADY_OPTIMIZED_THRESHOLD;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => row.phase === "done" && !noSavings && void applyPreset(preset.id)}
                  disabled={row.phase !== "done" || noSavings}
                  className={cn(
                    "group flex w-full items-stretch gap-3 rounded-lg border p-2.5 text-left transition-colors",
                    row.phase === "done"
                      ? isApplied
                        ? "border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)]"
                        : noSavings
                          ? "cursor-default border-[var(--panel-border)] opacity-60"
                          : isSmart
                            ? "border-[color-mix(in_srgb,var(--color-accent)_50%,transparent)] hover:bg-[var(--hover-bg)]"
                            : "border-[var(--panel-border)] hover:bg-[var(--hover-bg)]"
                      : row.phase === "missing"
                        ? "cursor-not-allowed border-dashed border-[var(--panel-border)] opacity-60"
                        : row.phase === "error"
                          ? "border-[color-mix(in_srgb,var(--color-destructive)_30%,var(--panel-border))]"
                          : "cursor-progress border-[var(--panel-border)]",
                  )}
                  data-testid={`preset-${preset.id}`}
                >
                  {/* Thumbnail */}
                  <div className="flex h-16 w-12 shrink-0 items-center justify-center overflow-hidden rounded border border-[var(--panel-border)] bg-white">
                    {row.phase === "done" && row.thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={row.thumb} alt="" className="h-full w-full object-cover" />
                    ) : row.phase === "running" ? (
                      <Loader2 className="h-4 w-4 animate-spin text-[var(--muted)]" strokeWidth={1.8} />
                    ) : (
                      <div className="h-full w-full" />
                    )}
                  </div>

                  {/* Body */}
                  <div className="flex-1 overflow-hidden">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[13px] font-medium">{preset.label}</span>
                      {row.phase === "done" && !noSavings && (
                        <span className="shrink-0 tnum text-[12px] font-semibold text-[var(--app-fg)]">
                          {formatBytes(row.sizeBytes)}
                          {ratioPct !== null && ratioPct > 0 && (
                            <span className="ml-1 text-[10px] font-normal text-[var(--muted)]">
                              −{ratioPct}%
                            </span>
                          )}
                        </span>
                      )}
                      {row.phase === "done" && noSavings && (
                        <span className="shrink-0 text-[11px] font-medium text-[var(--muted)]">
                          Already optimized
                        </span>
                      )}
                      {row.phase === "running" && (
                        <span className="shrink-0 text-[11px] text-[var(--muted)]">computing…</span>
                      )}
                    </div>
                    <div className="truncate text-[11px] text-[var(--muted)]">
                      {row.phase === "missing"
                        ? row.reason
                        : row.phase === "error"
                          ? row.error
                          : noSavings
                            ? "This preset wouldn't shrink your file — your PDF is already lean."
                            : preset.hint}
                    </div>
                  </div>

                  {isApplied && (
                    <div className="flex items-center pr-1 text-[var(--color-accent)]">
                      <Check className="h-4 w-4" strokeWidth={2} />
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Custom advanced controls */}
          <div className="mt-4 rounded-lg border border-[var(--panel-border)]">
            <button
              type="button"
              onClick={() => setShowCustom((v) => !v)}
              className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-[12px] font-medium hover:bg-[var(--hover-bg)]"
              data-testid="compress-custom-toggle"
            >
              <span>Custom · advanced controls</span>
              <span className="text-[10px] text-[var(--muted)]">{showCustom ? "Hide" : "Show"}</span>
            </button>
            {showCustom && (
              <div className="border-t border-[var(--panel-border)] p-3">
                <div className="grid grid-cols-2 gap-3">
                  <Slider label={`Color images: ${colorDpi} dpi`} value={colorDpi} min={36} max={600} onChange={setColorDpi} />
                  <Slider label={`Gray images: ${grayDpi} dpi`} value={grayDpi} min={36} max={600} onChange={setGrayDpi} />
                  <Slider label={`Mono / line art: ${monoDpi} dpi`} value={monoDpi} min={72} max={1200} onChange={setMonoDpi} />
                  <Slider label={`JPEG quality: ${jpegQuality}`} value={jpegQuality} min={5} max={100} onChange={setJpegQuality} />
                </div>
                {rows.custom?.phase === "done" && (
                  <div className="mt-3 flex items-center gap-2 rounded-md border border-[var(--panel-border)] bg-[var(--hover-bg)] p-2">
                    {rows.custom.thumb && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={rows.custom.thumb} alt="" className="h-12 w-9 rounded border border-[var(--panel-border)] object-cover" />
                    )}
                    <div className="flex-1">
                      <div className="text-[12px] font-medium">
                        Custom result: <span className="tnum">{formatBytes(rows.custom.sizeBytes)}</span>
                        {rows.custom.ratio < 1 && (
                          <span className="ml-1 text-[10px] font-normal text-[var(--muted)]">
                            −{Math.round((1 - rows.custom.ratio) * 100)}%
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => applyPreset("custom")}
                      className="h-7 rounded-md bg-[var(--color-accent)] px-3 text-[11px] font-medium text-white hover:bg-[var(--color-accent-hover)]"
                    >
                      Apply
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void runCustom()}
                  disabled={rows.custom?.phase === "running"}
                  className="mt-3 h-7 w-full rounded-md border border-[var(--panel-border)] text-[11px] font-medium hover:bg-[var(--hover-bg)] disabled:opacity-60"
                  data-testid="compress-custom-run"
                >
                  {rows.custom?.phase === "running" ? "Computing…" : "Run with these settings"}
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-[var(--panel-border)] px-5 py-3">
          <div className="text-[11px] text-[var(--muted)]">
            {appliedId ? (
              <span>
                Applied · undo with ⌘Z if you want to revert
              </span>
            ) : (
              <span>Click any preset to apply. Modal stays open so you can compare.</span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md border border-[var(--panel-border)] px-3 text-[12px] text-[var(--app-fg)] hover:bg-[var(--hover-bg)]"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

async function runPreset(preset: PresetSpec, source: Uint8Array): Promise<Uint8Array> {
  let mid: Uint8Array;
  switch (preset.engine) {
    case "pdflib":
      mid = await compressLight(source);
      break;
    case "qpdf": {
      const ab = await window.weavepdf.qpdfCompress(u8ToAb(source));
      mid = new Uint8Array(ab);
      break;
    }
    case "mutool": {
      const ab = await window.weavepdf.mutool.clean(u8ToAb(source));
      mid = new Uint8Array(ab);
      break;
    }
    case "gs": {
      const ab = await window.weavepdf.ghostscript.compress(u8ToAb(source), preset.gsQuality!);
      mid = new Uint8Array(ab);
      break;
    }
    case "gs-advanced": {
      const ab = await window.weavepdf.ghostscript.compressAdvanced(
        u8ToAb(source),
        preset.advanced!,
      );
      mid = new Uint8Array(ab);
      break;
    }
  }

  // qpdf post-pass: research shows always running qpdf after gs picks up an
  // extra 5-20% for free with no quality cost. Skip when the engine is
  // already qpdf (would double-pass) or when qpdf isn't installed.
  if (preset.engine !== "qpdf" && (await window.weavepdf.qpdf.available().catch(() => false))) {
    try {
      const finalAb = await window.weavepdf.qpdfCompress(u8ToAb(mid));
      const final = new Uint8Array(finalAb);
      // Only keep the post-pass result if it's actually smaller (rarely it's
      // not, e.g. if mid was already linearized).
      if (final.byteLength < mid.byteLength) return final;
    } catch {
      /* swallow — return the un-post-passed bytes */
    }
  }

  // Critical guard: if the "compressed" output is ≥ 95% of the source, the
  // doc was already optimal — small text PDFs literally grow under
  // Ghostscript. Return the source unchanged so the user doesn't pay a tax.
  if (mid.byteLength >= source.byteLength * ALREADY_OPTIMIZED_THRESHOLD) {
    return source;
  }

  return mid;
}

function missingHint(engine: Engine): string {
  switch (engine) {
    case "qpdf":
      return "Install qpdf: brew install qpdf";
    case "mutool":
      return "Install MuPDF: brew install mupdf-tools";
    case "gs":
    case "gs-advanced":
      return "Install Ghostscript: brew install ghostscript";
    default:
      return "Engine not available";
  }
}

async function renderFirstPageThumb(bytes: Uint8Array): Promise<string | null> {
  const { pdfjsLib } = await import("../../lib/pdfjs");
  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  try {
    const page = await doc.getPage(1);
    const baseVp = page.getViewport({ scale: 1 });
    // Target ~96px wide thumbnail (high DPR for Retina).
    const targetWidthCss = 96;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const scale = (targetWidthCss / baseVp.width) * dpr;
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return canvas.toDataURL("image/png");
  } finally {
    void doc.destroy();
  }
}

function Slider({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-[10px] font-medium text-[var(--muted)]">{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
      />
    </div>
  );
}
