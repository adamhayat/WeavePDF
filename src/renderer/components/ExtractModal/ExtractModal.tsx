import { useMemo, useState } from "react";
import { X, Scissors } from "lucide-react";
import { useDocumentStore } from "../../stores/document";
import { extractPages } from "../../lib/pdf-ops";

type Props = { open: boolean; onClose: () => void };

export function ExtractModal({ open, onClose }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const [range, setRange] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => parseRange(range, activeTab?.numPages ?? 0), [range, activeTab?.numPages]);

  if (!open || !activeTab) return null;

  const defaultRange =
    activeTab.selectedPages.size > 0
      ? collapseRange(Array.from(activeTab.selectedPages).sort((a, b) => a - b))
      : `1-${activeTab.numPages}`;

  const handleExtract = async () => {
    if (!activeTab.bytes) return;
    const pages = (range.trim() ? parsed : parseRange(defaultRange, activeTab.numPages)).pages;
    if (pages.length === 0) {
      setError("No valid pages selected");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const bytes = await extractPages(activeTab.bytes, pages);
      const suggested = (activeTab.name.replace(/\.[^.]+$/, "") || "extract") + `-pages.pdf`;
      const save = await window.weavepdf.saveFileDialog({
        title: "Save extracted pages",
        suggestedName: suggested,
        extensions: ["pdf"],
      });
      if (save.canceled) return;
      await window.weavepdf.writeFile(save.path, toArrayBuffer(bytes));
      onClose();
    } catch (err) {
      setError(String((err as Error).message ?? err));
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
        data-testid="extract-modal"
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Scissors className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.8} />
            <h2 className="text-[15px] font-semibold">Extract pages</h2>
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

        <div className="flex flex-col gap-2">
          <label className="text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">
            Pages
          </label>
          <input
            value={range}
            onChange={(e) => {
              setRange(e.target.value);
              setError(null);
            }}
            placeholder={defaultRange}
            className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-3 py-2 text-[14px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            data-testid="extract-range"
          />
          <p className="text-[11px] text-[var(--muted)]">
            Examples: <span className="font-mono">1-3</span>, <span className="font-mono">1,3,5-7</span>.
            Default: {activeTab.selectedPages.size > 0 ? "currently-selected pages" : "all pages"}.
          </p>
          {(range.trim() ? parsed : { pages: [], warning: "" }).warning && (
            <p className="text-[11px] text-[var(--color-warn)]">{parsed.warning}</p>
          )}
          {error && <p className="text-[11px] text-[var(--color-destructive)]">{error}</p>}
          <p className="tnum mt-1 text-[11px] text-[var(--muted)]">
            {(range.trim() ? parsed.pages : parseRange(defaultRange, activeTab.numPages).pages).length} pages will be saved
          </p>
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
            onClick={handleExtract}
            disabled={busy}
            className="h-8 rounded-md bg-[var(--color-accent)] px-3 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
            data-testid="extract-apply"
          >
            {busy ? "Saving…" : "Save pages…"}
          </button>
        </div>
      </div>
    </div>
  );
}

function parseRange(input: string, max: number): { pages: number[]; warning: string } {
  if (!input.trim()) return { pages: [], warning: "" };
  const pages = new Set<number>();
  let warning = "";
  for (const chunk of input.split(",")) {
    const t = chunk.trim();
    if (!t) continue;
    const m = t.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) {
      warning = `Can't parse "${t}"`;
      continue;
    }
    const a = Math.max(1, Math.min(max, Number(m[1])));
    const b = m[2] ? Math.max(1, Math.min(max, Number(m[2]))) : a;
    for (let p = Math.min(a, b); p <= Math.max(a, b); p++) pages.add(p);
  }
  return { pages: [...pages].sort((x, y) => x - y), warning };
}

function collapseRange(pages: number[]): string {
  if (pages.length === 0) return "";
  const out: string[] = [];
  let start = pages[0];
  let prev = pages[0];
  for (let i = 1; i < pages.length; i++) {
    if (pages[i] === prev + 1) {
      prev = pages[i];
      continue;
    }
    out.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = pages[i];
    prev = pages[i];
  }
  out.push(start === prev ? `${start}` : `${start}-${prev}`);
  return out.join(",");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}
