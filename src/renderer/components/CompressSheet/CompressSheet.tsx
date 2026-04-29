import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { compressLight } from "../../lib/pdf-ops";
import { useDocumentStore } from "../../stores/document";
import { formatBytes } from "../../lib/cn";
import { cn } from "../../lib/cn";
import { u8ToAb } from "../../../shared/buffers";

type Preset = {
  id: "email" | "standard" | "high" | "gs-screen" | "gs-ebook" | "gs-printer";
  label: string;
  hint: string;
  targetRatio: number; // estimated compression ratio (for preview only)
  engine: "pdflib" | "ghostscript";
  gsQuality?: "screen" | "ebook" | "printer" | "prepress";
};

const PRESETS: Preset[] = [
  { id: "email", label: "Email (fast)", hint: "pdf-lib object streams — object-level only", targetRatio: 0.85, engine: "pdflib" },
  { id: "standard", label: "Standard (fast)", hint: "pdf-lib object streams", targetRatio: 0.9, engine: "pdflib" },
  { id: "high", label: "High quality (fast)", hint: "pdf-lib object streams, minimal loss", targetRatio: 0.95, engine: "pdflib" },
  { id: "gs-screen", label: "Heavy · Screen (72 dpi)", hint: "Ghostscript · smallest file, images downsampled", targetRatio: 0.2, engine: "ghostscript", gsQuality: "screen" },
  { id: "gs-ebook", label: "Heavy · eBook (150 dpi)", hint: "Ghostscript · great for sharing", targetRatio: 0.35, engine: "ghostscript", gsQuality: "ebook" },
  { id: "gs-printer", label: "Heavy · Printer (300 dpi)", hint: "Ghostscript · print-quality", targetRatio: 0.6, engine: "ghostscript", gsQuality: "printer" },
];

type Props = { open: boolean; onClose: () => void };

export function CompressSheet({ open, onClose }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const applyEdit = useDocumentStore((s) => s.applyEdit);
  const [selected, setSelected] = useState<Preset["id"]>("standard");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ before: number; after: number } | null>(null);
  const [gsAvailable, setGsAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    if (!open) {
      setResult(null);
      setBusy(false);
      return;
    }
    void window.weavepdf.ghostscript.available().then(setGsAvailable);
  }, [open]);

  const before = activeTab?.sizeBytes ?? 0;
  const previewAfter = useMemo(
    () => Math.round(before * (PRESETS.find((p) => p.id === selected)?.targetRatio ?? 1)),
    [before, selected],
  );

  if (!open || !activeTab) return null;

  const handleCompress = async () => {
    if (!activeTab.bytes) return;
    const preset = PRESETS.find((p) => p.id === selected);
    if (!preset) return;
    setBusy(true);
    try {
      let out: Uint8Array;
      if (preset.engine === "ghostscript" && preset.gsQuality) {
        const resultAb = await window.weavepdf.ghostscript.compress(
          u8ToAb(activeTab.bytes),
          preset.gsQuality,
        );
        out = new Uint8Array(resultAb);
      } else {
        out = await compressLight(activeTab.bytes);
      }
      await applyEdit(activeTab.id, out);
      setResult({ before, after: out.byteLength });
    } catch (err) {
      alert(`Compression failed: ${(err as Error).message ?? err}`);
    } finally {
      setBusy(false);
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
        className="w-[460px] rounded-2xl border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] p-5 shadow-2xl"
        data-testid="compress-sheet"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">Compress PDF</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>

        <div className="flex flex-col gap-2">
          {PRESETS.map((p) => {
            const disabled = p.engine === "ghostscript" && gsAvailable === false;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => !disabled && setSelected(p.id)}
                disabled={disabled}
                className={cn(
                  "flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left transition-colors",
                  disabled
                    ? "cursor-not-allowed border-[var(--panel-border)] opacity-40"
                    : selected === p.id
                      ? "border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]"
                      : "border-[var(--panel-border)] hover:bg-[var(--hover-bg)]",
                )}
                data-testid={`preset-${p.id}`}
                data-selected={selected === p.id || undefined}
              >
                <div>
                  <div className="text-[13px] font-medium">{p.label}</div>
                  <div className="text-[11px] text-[var(--muted)]">{p.hint}</div>
                </div>
                <div className="tnum text-[11px] text-[var(--muted)]">
                  ~{formatBytes(Math.round(before * p.targetRatio))}
                </div>
              </button>
            );
          })}
          {gsAvailable === false && (
            <p className="rounded-md border border-[var(--panel-border)] bg-[var(--hover-bg)] p-2 text-[11px] text-[var(--muted)]">
              Install Ghostscript (<code>brew install ghostscript</code>) to enable the Heavy presets — they typically shrink image-heavy PDFs by 60–80%.
            </p>
          )}
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-[var(--panel-border)] pt-4">
          <div className="text-[11px] text-[var(--muted)]">
            {result ? (
              <span>
                <span className="tnum">{formatBytes(result.before)}</span>
                {" → "}
                <span className="tnum font-medium text-[var(--app-fg)]">
                  {formatBytes(result.after)}
                </span>
                {" · "}
                {Math.round(((result.before - result.after) / result.before) * 100)}
                % smaller
              </span>
            ) : (
              <span>
                Current: <span className="tnum">{formatBytes(before)}</span> · Estimate: ~
                <span className="tnum">{formatBytes(previewAfter)}</span>
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-8 rounded-md border border-[var(--panel-border)] px-3 text-[12px] text-[var(--app-fg)] hover:bg-[var(--hover-bg)]"
            >
              {result ? "Close" : "Cancel"}
            </button>
            {!result && (
              <button
                type="button"
                onClick={handleCompress}
                disabled={busy}
                className="h-8 rounded-md bg-[var(--color-accent)] px-3 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
                data-testid="compress-apply"
              >
                {busy ? "Compressing…" : "Compress"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
