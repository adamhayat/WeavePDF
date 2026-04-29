import { useState } from "react";
import { X, Droplets } from "lucide-react";
import { useDocumentStore } from "../../stores/document";
import { drawTextWatermark } from "../../lib/pdf-ops";

type Props = { open: boolean; onClose: () => void };

type Color = { r: number; g: number; b: number; label: string };

const COLORS: Color[] = [
  { r: 0.7, g: 0.1, b: 0.1, label: "Red" },
  { r: 0.15, g: 0.35, b: 0.8, label: "Blue" },
  { r: 0.2, g: 0.2, b: 0.2, label: "Gray" },
  { r: 0.05, g: 0.45, b: 0.15, label: "Green" },
];

export function WatermarkModal({ open, onClose }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const applyEdit = useDocumentStore((s) => s.applyEdit);
  const [text, setText] = useState("CONFIDENTIAL");
  const [opacity, setOpacity] = useState(0.22);
  const [colorIdx, setColorIdx] = useState(0);
  const [rotation, setRotation] = useState(45);
  const [busy, setBusy] = useState(false);

  if (!open || !activeTab) return null;

  const apply = async () => {
    if (!activeTab.bytes || !text.trim()) return;
    setBusy(true);
    try {
      const color = COLORS[colorIdx];
      const newBytes = await drawTextWatermark(activeTab.bytes, text, {
        opacity,
        color: { r: color.r, g: color.g, b: color.b },
        rotation,
      });
      await applyEdit(activeTab.id, newBytes);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const previewColor = COLORS[colorIdx];

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[520px] rounded-2xl border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] p-5 shadow-2xl"
        data-testid="watermark-modal"
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Droplets className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.8} />
            <h2 className="text-[15px] font-semibold">Add watermark</h2>
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

        <div className="flex flex-col gap-3">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Watermark text"
            className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-3 py-2 text-[14px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            data-testid="watermark-text"
          />

          <div className="flex gap-1.5">
            {COLORS.map((c, i) => (
              <button
                key={c.label}
                type="button"
                onClick={() => setColorIdx(i)}
                className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[11px] transition-colors ${
                  colorIdx === i
                    ? "border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]"
                    : "border-[var(--panel-border)] hover:bg-[var(--hover-bg)]"
                }`}
              >
                <span
                  className="inline-block h-3 w-3 rounded-full"
                  style={{ background: `rgb(${c.r * 255},${c.g * 255},${c.b * 255})` }}
                />
                {c.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">
                Opacity · {Math.round(opacity * 100)}%
              </span>
              <input
                type="range"
                min={0.05}
                max={0.6}
                step={0.01}
                value={opacity}
                onChange={(e) => setOpacity(Number(e.target.value))}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">
                Rotation · {rotation}°
              </span>
              <input
                type="range"
                min={0}
                max={90}
                step={1}
                value={rotation}
                onChange={(e) => setRotation(Number(e.target.value))}
              />
            </label>
          </div>

          <div className="relative mt-1 flex h-[120px] items-center justify-center overflow-hidden rounded-xl border border-[var(--panel-border)] bg-white">
            <div
              style={{
                transform: `rotate(-${rotation}deg)`,
                color: `rgb(${previewColor.r * 255},${previewColor.g * 255},${previewColor.b * 255})`,
                opacity,
                fontSize: 42,
                fontWeight: 700,
                letterSpacing: 2,
              }}
            >
              {text || "Preview"}
            </div>
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2 border-t border-[var(--panel-border)] pt-4">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md border border-[var(--panel-border)] px-3 text-[12px] text-[var(--app-fg)] hover:bg-[var(--hover-bg)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={busy || !text.trim()}
            className="h-8 rounded-md bg-[var(--color-accent)] px-3 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
            data-testid="watermark-apply"
          >
            {busy ? "Applying…" : "Apply to all pages"}
          </button>
        </div>
      </div>
    </div>
  );
}
