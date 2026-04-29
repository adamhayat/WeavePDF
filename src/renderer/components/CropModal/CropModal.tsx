import { useState } from "react";
import { X, Crop } from "lucide-react";
import { useDocumentStore } from "../../stores/document";
import { cropPages } from "../../lib/pdf-ops";

type Props = { open: boolean; onClose: () => void };

export function CropModal({ open, onClose }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const applyEdit = useDocumentStore((s) => s.applyEdit);
  const [top, setTop] = useState(36);
  const [bottom, setBottom] = useState(36);
  const [left, setLeft] = useState(36);
  const [right, setRight] = useState(36);
  const [busy, setBusy] = useState(false);

  if (!open || !activeTab) return null;

  const apply = async () => {
    if (!activeTab.bytes) return;
    setBusy(true);
    try {
      const newBytes = await cropPages(activeTab.bytes, { top, bottom, left, right });
      await applyEdit(activeTab.id, newBytes);
      onClose();
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
        data-testid="crop-modal"
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Crop className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.8} />
            <h2 className="text-[15px] font-semibold">Crop pages</h2>
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

        <p className="mb-4 text-[12px] text-[var(--muted)]">
          Shrink every page by cutting the given margin from each edge. Units are PDF points (1/72 in).
        </p>

        <div className="grid grid-cols-2 gap-3">
          <MarginField label="Top" value={top} onChange={setTop} />
          <MarginField label="Bottom" value={bottom} onChange={setBottom} />
          <MarginField label="Left" value={left} onChange={setLeft} />
          <MarginField label="Right" value={right} onChange={setRight} />
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
            disabled={busy}
            className="h-8 rounded-md bg-[var(--color-accent)] px-3 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
            data-testid="crop-apply"
          >
            {busy ? "Cropping…" : "Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MarginField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">
        {label}
      </span>
      <input
        type="number"
        min={0}
        step={1}
        value={value}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
        className="rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-1.5 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
      />
    </label>
  );
}
