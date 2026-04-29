import { useState } from "react";
import { X, FileText } from "lucide-react";
import { useDocumentStore } from "../../stores/document";
import { drawHeaderFooter } from "../../lib/pdf-ops";

type Props = { open: boolean; onClose: () => void };

export function HeaderFooterModal({ open, onClose }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const applyEdit = useDocumentStore((s) => s.applyEdit);
  const [header, setHeader] = useState("");
  const [footer, setFooter] = useState("");
  const [pageNumbers, setPageNumbers] = useState(true);
  const [format, setFormat] = useState("Page {n} of {total}");
  const [bates, setBates] = useState(false);
  const [batesPrefix, setBatesPrefix] = useState("BATES");
  const [batesStart, setBatesStart] = useState(1);
  const [batesDigits, setBatesDigits] = useState(6);
  const [busy, setBusy] = useState(false);

  if (!open || !activeTab) return null;

  const canApply = Boolean(header.trim() || footer.trim() || pageNumbers || bates);

  const apply = async () => {
    if (!activeTab.bytes) return;
    setBusy(true);
    try {
      let bytes = activeTab.bytes;
      if (header.trim() || footer.trim() || pageNumbers) {
        bytes = await drawHeaderFooter(bytes, {
          header: header.trim() || undefined,
          footer: footer.trim() || undefined,
          pageNumberFormat: pageNumbers ? format : undefined,
          pageNumberPosition: "footer",
        });
      }
      if (bates && batesPrefix.trim()) {
        // Bates stamps a unique sequential ID on every page — typical legal
        // production layout puts it in the footer, left-aligned. Tokens:
        //   {n}     — sequential number (zero-padded to batesDigits)
        //   Prefix  — e.g. ACME000001
        const { drawBatesNumbers } = await import("../../lib/pdf-ops");
        bytes = await drawBatesNumbers(bytes, {
          prefix: batesPrefix.trim(),
          start: batesStart,
          digits: batesDigits,
        });
      }
      await applyEdit(activeTab.id, bytes);
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
        className="w-[520px] rounded-2xl border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] p-5 shadow-2xl"
        data-testid="headerfooter-modal"
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.8} />
            <h2 className="text-[15px] font-semibold">Header, footer, page numbers</h2>
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
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">
              Header (centred on every page)
            </span>
            <input
              value={header}
              onChange={(e) => setHeader(e.target.value)}
              placeholder="e.g. ACME Corp · Quarterly Report"
              className="rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-3 py-2 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">
              Footer (centred)
            </span>
            <input
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
              placeholder="e.g. Confidential — do not distribute"
              className="rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-3 py-2 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            />
          </label>
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={pageNumbers}
              onChange={(e) => setPageNumbers(e.target.checked)}
            />
            Page numbers (bottom-right)
          </label>
          {pageNumbers && (
            <label className="flex flex-col gap-1 pl-6">
              <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">
                Format — use <span className="font-mono">{"{n}"}</span> and <span className="font-mono">{"{total}"}</span>
              </span>
              <input
                value={format}
                onChange={(e) => setFormat(e.target.value)}
                className="rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-3 py-2 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              />
            </label>
          )}
          <label className="flex items-center gap-2 border-t border-[var(--panel-border)] pt-3 text-[13px]">
            <input
              type="checkbox"
              checked={bates}
              onChange={(e) => setBates(e.target.checked)}
            />
            Bates numbering (bottom-left, legal production format)
          </label>
          {bates && (
            <div className="grid grid-cols-3 gap-2 pl-6">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--subtle)]">Prefix</span>
                <input
                  value={batesPrefix}
                  onChange={(e) => setBatesPrefix(e.target.value)}
                  placeholder="BATES"
                  className="rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-1.5 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--subtle)]">Start</span>
                <input
                  type="number"
                  min={0}
                  value={batesStart}
                  onChange={(e) => setBatesStart(Math.max(0, parseInt(e.target.value, 10) || 0))}
                  className="rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-1.5 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--subtle)]">Digits</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={batesDigits}
                  onChange={(e) => setBatesDigits(Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 6)))}
                  className="rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-1.5 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                />
              </label>
              <p className="col-span-3 text-[11px] text-[var(--muted)]">
                Preview: <span className="font-mono">{(batesPrefix || "BATES") + String(batesStart).padStart(batesDigits, "0")}</span>
              </p>
            </div>
          )}
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
            disabled={busy || !canApply}
            className="h-8 rounded-md bg-[var(--color-accent)] px-3 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
            data-testid="headerfooter-apply"
          >
            {busy ? "Applying…" : "Apply to all pages"}
          </button>
        </div>
      </div>
    </div>
  );
}
