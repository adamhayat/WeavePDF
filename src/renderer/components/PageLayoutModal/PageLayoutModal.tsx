import { useState } from "react";
import { X, Grid3x3, Maximize2, BookOpen, Scissors, Crop } from "lucide-react";
import { useDocumentStore } from "../../stores/document";
import {
  nUpPages,
  autoCropPages,
  fitToPaper,
  bookletImpose,
  splitDoubleSpread,
  PAPER_SIZES,
  type PaperSize,
} from "../../lib/pdf-ops";
import { cn, formatBytes } from "../../lib/cn";

type Props = { open: boolean; onClose: () => void };

type TabId = "nup" | "crop" | "fit" | "booklet" | "split";

const TABS: Array<{ id: TabId; label: string; icon: typeof Grid3x3; hint: string }> = [
  { id: "nup", label: "N-up", icon: Grid3x3, hint: "Combine 2/4/6/9 pages onto a single sheet" },
  { id: "crop", label: "Auto-crop", icon: Crop, hint: "Trim whitespace borders to maximize content area" },
  { id: "fit", label: "Fit to paper", icon: Maximize2, hint: "Re-paginate every page to a chosen paper size" },
  { id: "booklet", label: "Booklet", icon: BookOpen, hint: "2-up imposition for folded stapled printing" },
  { id: "split", label: "Split spread", icon: Scissors, hint: "Cut each page in half (for scanned book spreads)" },
];

const PAPERS: Array<{ id: PaperSize; label: string }> = [
  { id: "source", label: "Match source page size" },
  { id: "letter", label: "US Letter (8.5×11 in)" },
  { id: "legal", label: "US Legal (8.5×14 in)" },
  { id: "a4", label: "A4 (210×297 mm)" },
  { id: "a3", label: "A3 (297×420 mm)" },
  { id: "a5", label: "A5 (148×210 mm)" },
  { id: "tabloid", label: "Tabloid (11×17 in)" },
];

export function PageLayoutModal({ open, onClose }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const applyEdit = useDocumentStore((s) => s.applyEdit);
  const [tab, setTab] = useState<TabId>("nup");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ before: number; after: number; pages: number } | null>(null);

  // N-up
  const [nupPerSheet, setNupPerSheet] = useState<2 | 4 | 6 | 9>(4);
  const [nupPaper, setNupPaper] = useState<PaperSize>("letter");
  const [nupOrientation, setNupOrientation] = useState<"portrait" | "landscape" | "auto">("auto");
  const [nupAddBorders, setNupAddBorders] = useState(false);

  // Auto-crop
  const [cropUniform, setCropUniform] = useState(true);
  const [cropPadding, setCropPadding] = useState(6);
  const [cropThreshold, setCropThreshold] = useState(240);

  // Fit-to-paper
  const [fitPaper, setFitPaper] = useState<PaperSize>("letter");
  const [fitMode, setFitMode] = useState<"fit" | "fill">("fit");
  const [fitOrientation, setFitOrientation] = useState<"portrait" | "landscape" | "auto">("auto");

  // Booklet
  const [bookletPaper, setBookletPaper] = useState<PaperSize>("letter");

  // Split
  const [splitDir, setSplitDir] = useState<"horizontal" | "vertical">("horizontal");

  if (!open || !activeTab) return null;

  const apply = async () => {
    if (!activeTab.bytes) return;
    setBusy(true);
    setResult(null);
    try {
      let out: Uint8Array;
      switch (tab) {
        case "nup":
          out = await nUpPages(activeTab.bytes, nupPerSheet, {
            paper: nupPaper,
            orientation: nupOrientation,
            addBorders: nupAddBorders,
          });
          break;
        case "crop":
          out = await autoCropPages(activeTab.bytes, {
            uniform: cropUniform,
            padding: cropPadding,
            whiteThreshold: cropThreshold,
          });
          break;
        case "fit":
          out = await fitToPaper(activeTab.bytes, fitPaper, {
            mode: fitMode,
            orientation: fitOrientation,
          });
          break;
        case "booklet":
          out = await bookletImpose(activeTab.bytes, { paper: bookletPaper });
          break;
        case "split":
          out = await splitDoubleSpread(activeTab.bytes, { direction: splitDir });
          break;
      }
      const before = activeTab.sizeBytes;
      const beforePages = activeTab.numPages;
      await applyEdit(activeTab.id, out);
      const newPages = useDocumentStore.getState().tabs.find((t) => t.id === activeTab.id)?.numPages ?? beforePages;
      setResult({ before, after: out.byteLength, pages: newPages });
    } catch (err) {
      alert(`${tab} failed: ${(err as Error).message ?? err}`);
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
        className="flex max-h-[80vh] w-[560px] flex-col rounded-2xl border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] shadow-2xl"
        data-testid="page-layout-modal"
      >
        <div className="flex items-center justify-between border-b border-[var(--panel-border)] px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold">Page layout</h2>
            <p className="text-[11px] text-[var(--muted)]">
              Reshape this document — combine pages, trim margins, fit to a paper size, impose for printing, or split spreads.
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

        {/* Tabs */}
        <div className="flex shrink-0 gap-1 border-b border-[var(--panel-border)] px-3 py-2">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setTab(t.id);
                  setResult(null);
                }}
                className={cn(
                  "flex flex-1 flex-col items-center gap-1 rounded-md px-2 py-2 text-[11px] font-medium transition-colors",
                  tab === t.id
                    ? "bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] text-[var(--color-accent)]"
                    : "text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]",
                )}
                data-testid={`layout-tab-${t.id}`}
              >
                <Icon className="h-4 w-4" strokeWidth={1.8} />
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-4 text-[12px] text-[var(--muted)]">{TABS.find((t) => t.id === tab)?.hint}</p>

          {tab === "nup" && (
            <div className="flex flex-col gap-3">
              <Field label="Pages per sheet">
                <div className="flex gap-2">
                  {([2, 4, 6, 9] as const).map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setNupPerSheet(n)}
                      className={cn(
                        "flex-1 rounded-md border px-2 py-1.5 text-[12px] font-medium transition-colors",
                        nupPerSheet === n
                          ? "border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-[var(--color-accent)]"
                          : "border-[var(--panel-border)] hover:bg-[var(--hover-bg)]",
                      )}
                      data-testid={`nup-${n}`}
                    >
                      {n}-up
                    </button>
                  ))}
                </div>
              </Field>
              <PaperSelect label="Paper" value={nupPaper} onChange={setNupPaper} />
              <OrientationSelect value={nupOrientation} onChange={setNupOrientation} />
              <Checkbox
                checked={nupAddBorders}
                onChange={setNupAddBorders}
                label="Add a thin border around each cell"
              />
              <Estimate
                summary={`${activeTab.numPages} → ${Math.ceil(activeTab.numPages / nupPerSheet)} page${Math.ceil(activeTab.numPages / nupPerSheet) === 1 ? "" : "s"}`}
              />
            </div>
          )}

          {tab === "crop" && (
            <div className="flex flex-col gap-3">
              <Checkbox
                checked={cropUniform}
                onChange={setCropUniform}
                label="Use a single bounding box across every page"
                hint="Off → each page cropped independently. On → all output pages stay the same size."
              />
              <Field label={`Padding (${cropPadding} pt around the content)`}>
                <input
                  type="range"
                  min={0}
                  max={36}
                  step={1}
                  value={cropPadding}
                  onChange={(e) => setCropPadding(Number(e.target.value))}
                  className="w-full"
                />
              </Field>
              <Field label={`White threshold (${cropThreshold} / 255 — higher = more aggressive)`}>
                <input
                  type="range"
                  min={180}
                  max={255}
                  step={5}
                  value={cropThreshold}
                  onChange={(e) => setCropThreshold(Number(e.target.value))}
                  className="w-full"
                />
              </Field>
              <Hint>
                WeavePDF renders each page, walks the pixels, and crops to the
                tightest rectangle that contains all non-white content. Heavy
                operation on long documents — give it a few seconds.
              </Hint>
            </div>
          )}

          {tab === "fit" && (
            <div className="flex flex-col gap-3">
              <PaperSelect label="Target paper" value={fitPaper} onChange={setFitPaper} />
              <OrientationSelect value={fitOrientation} onChange={setFitOrientation} />
              <Field label="Scale mode">
                <div className="flex gap-2">
                  {(["fit", "fill"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setFitMode(m)}
                      className={cn(
                        "flex-1 rounded-md border px-2 py-1.5 text-[12px] font-medium transition-colors",
                        fitMode === m
                          ? "border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-[var(--color-accent)]"
                          : "border-[var(--panel-border)] hover:bg-[var(--hover-bg)]",
                      )}
                    >
                      {m === "fit" ? "Fit (no crop)" : "Fill (may crop)"}
                    </button>
                  ))}
                </div>
              </Field>
              <Hint>
                Fit preserves aspect ratio and centres the page — may leave
                margins. Fill scales up so content reaches every edge —
                trim-bleed style, may crop a hair at the edges.
              </Hint>
            </div>
          )}

          {tab === "booklet" && (
            <div className="flex flex-col gap-3">
              <PaperSelect label="Sheet paper (forced landscape)" value={bookletPaper} onChange={setBookletPaper} />
              <Hint>
                Pads to a multiple of 4 with blank pages, then arranges pages
                so a folded + stapled stack reads in order. Print double-sided,
                short-edge binding, fold the stack down the middle.
              </Hint>
              <Estimate
                summary={`${activeTab.numPages} → ${Math.ceil(activeTab.numPages / 4) * 2} sheet${Math.ceil(activeTab.numPages / 4) * 2 === 1 ? "" : "s"} (after padding to multiple of 4)`}
              />
            </div>
          )}

          {tab === "split" && (
            <div className="flex flex-col gap-3">
              <Field label="Cut direction">
                <div className="flex gap-2">
                  {(["horizontal", "vertical"] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setSplitDir(d)}
                      className={cn(
                        "flex-1 rounded-md border px-2 py-1.5 text-[12px] font-medium transition-colors",
                        splitDir === d
                          ? "border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-[var(--color-accent)]"
                          : "border-[var(--panel-border)] hover:bg-[var(--hover-bg)]",
                      )}
                    >
                      {d === "horizontal" ? "Horizontal · left + right" : "Vertical · top + bottom"}
                    </button>
                  ))}
                </div>
              </Field>
              <Hint>
                Doubles the page count. For scanned books captured as
                two-pages-on-one-image, choose horizontal — left-half PDFs
                read first, then right-halves.
              </Hint>
              <Estimate summary={`${activeTab.numPages} → ${activeTab.numPages * 2} pages`} />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[var(--panel-border)] px-5 py-3">
          <div className="text-[11px] text-[var(--muted)]">
            {result ? (
              <span>
                <span className="tnum">{formatBytes(result.before)}</span>
                {" → "}
                <span className="tnum font-medium text-[var(--app-fg)]">{formatBytes(result.after)}</span>
                {" · "}
                <span className="tnum">{result.pages}</span> page{result.pages === 1 ? "" : "s"}
              </span>
            ) : (
              <span>
                <span className="tnum">{activeTab.numPages}</span> pages · {formatBytes(activeTab.sizeBytes)}
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
            <button
              type="button"
              onClick={apply}
              disabled={busy}
              className="h-8 rounded-md bg-[var(--color-accent)] px-3 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
              data-testid="layout-apply"
            >
              {busy ? "Applying…" : result ? "Apply again" : "Apply"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-[var(--muted)]">{label}</label>
      {children}
    </div>
  );
}

function PaperSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: PaperSize;
  onChange: (v: PaperSize) => void;
}) {
  return (
    <Field label={label}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as PaperSize)}
        className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--app-bg)] px-2.5 py-1.5 text-[12px] outline-none focus:border-[var(--color-accent)]"
      >
        {PAPERS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
            {p.id !== "source" && PAPER_SIZES[p.id as keyof typeof PAPER_SIZES] && ""}
          </option>
        ))}
      </select>
    </Field>
  );
}

function OrientationSelect({
  value,
  onChange,
}: {
  value: "portrait" | "landscape" | "auto";
  onChange: (v: "portrait" | "landscape" | "auto") => void;
}) {
  return (
    <Field label="Orientation">
      <div className="flex gap-2">
        {(["auto", "portrait", "landscape"] as const).map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => onChange(o)}
            className={cn(
              "flex-1 rounded-md border px-2 py-1 text-[11px] font-medium capitalize transition-colors",
              value === o
                ? "border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-[var(--color-accent)]"
                : "border-[var(--panel-border)] hover:bg-[var(--hover-bg)]",
            )}
          >
            {o}
          </button>
        ))}
      </div>
    </Field>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-md p-1 hover:bg-[var(--hover-bg)]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <div>
        <div className="text-[12px] text-[var(--app-fg)]">{label}</div>
        {hint && <div className="text-[10px] text-[var(--muted)]">{hint}</div>}
      </div>
    </label>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-[var(--panel-border)] bg-[var(--hover-bg)] p-2 text-[11px] leading-relaxed text-[var(--muted)]">
      {children}
    </p>
  );
}

function Estimate({ summary }: { summary: string }) {
  return (
    <p className="rounded-md border border-[var(--panel-border)] bg-[color-mix(in_srgb,var(--color-accent)_4%,transparent)] p-2 text-[11px] text-[var(--app-fg)]">
      {summary}
    </p>
  );
}
