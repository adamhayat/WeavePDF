import { useEffect, useState } from "react";
import { FileClock, FilePlus2, Upload } from "lucide-react";
import { useUIStore } from "../../stores/ui";

type Props = { onOpen: () => void };

export function DropZone({ onOpen }: Props) {
  const openRecentDrafts = useUIStore((s) => s.openRecentDrafts);
  const [draftCount, setDraftCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void window.weavepdf.drafts
      .list()
      .then((d) => {
        if (!cancelled) setDraftCount(d.length);
      })
      .catch(() => {
        if (!cancelled) setDraftCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-10">
      <button
        type="button"
        onClick={onOpen}
        className="group relative flex w-full max-w-[540px] flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed border-[var(--panel-border-strong)] bg-[var(--panel-bg)] px-10 py-16 text-center transition-all hover:border-[var(--color-accent)] hover:bg-[var(--panel-bg-raised)]"
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--panel-bg-raised)] text-[var(--muted)] transition-colors group-hover:bg-[var(--color-accent)]/10 group-hover:text-[var(--color-accent)]">
          <Upload className="h-6 w-6" strokeWidth={1.5} />
        </div>
        <div className="space-y-1">
          <div className="text-[20px] font-medium leading-snug text-[var(--app-fg)]">
            Drop a PDF to begin
          </div>
          <div className="text-[13px] text-[var(--muted)]">
            Or click to choose a file from your Mac
          </div>
        </div>
        <div className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-[13px] font-medium text-white shadow-sm transition-colors group-hover:bg-[var(--color-accent-hover)]">
          <FilePlus2 className="h-[13px] w-[13px]" strokeWidth={2} />
          Open file
          <span className="ml-1 rounded bg-white/15 px-1.5 py-0.5 text-[10px] tracking-wide">
            ⌘O
          </span>
        </div>
      </button>
      {draftCount > 0 && (
        <button
          type="button"
          onClick={openRecentDrafts}
          className="inline-flex items-center gap-2 rounded-lg border border-[var(--panel-border)] bg-[var(--panel-bg-raised)] px-3 py-1.5 text-[12px] text-[var(--app-fg)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          data-testid="resume-draft-cta"
        >
          <FileClock className="h-3.5 w-3.5" strokeWidth={1.6} />
          Resume previous work · {draftCount} draft{draftCount === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}
