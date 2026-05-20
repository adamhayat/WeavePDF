import { useCallback, useEffect, useRef } from "react";
import { Crop, RotateCcw } from "lucide-react";
import { useUIStore } from "../../stores/ui";
import { useDocumentStore } from "../../stores/document";

// V1.0087: floating action bar for the Crop tool. Renders bottom-center,
// viewport-fixed, while `tool === "crop"`. Shows live dimensions + the
// scope ("applies to all N pages"), plus Reset / Cancel / Apply.
// Apply commits any pending text/image/shape edits first (matches the
// save flow), then calls `cropPages` with the TLBR margins computed
// from the active draft, and bumps the doc via `applyEdit`. Cancel
// clears the draft + exits crop mode. Reset re-runs the auto-detect
// seed (clear draft → CropOverlay's seed effect fires again).
//
// Min crop is enforced at 10pt × 10pt (mirrors `MIN_CROP_PT` in
// CropOverlay). Apply disables and the dimensions readout warns when
// the rectangle is below threshold.

const MIN_CROP_PT = 10;

export function CropActionBar() {
  const tool = useUIStore((s) => s.tool);
  const setTool = useUIStore((s) => s.setTool);
  const cropDraft = useUIStore((s) => s.cropDraft);
  const setCropDraft = useUIStore((s) => s.setCropDraft);
  const activeTab = useDocumentStore((s) => s.activeTab());
  const applyEdit = useDocumentStore((s) => s.applyEdit);
  const commitAllPending = useDocumentStore((s) => s.commitAllPending);

  const onApply = useCallback(async () => {
    if (!activeTab?.id || !activeTab?.bytes || !cropDraft) return;
    // Bake any pending text/image/shape overlays before changing the
    // page geometry. Otherwise their absolute coords land at the same
    // PDF points after the MediaBox shift — visually displaced. The
    // save flow auto-commits the same way; crop is just another
    // destructive op.
    await commitAllPending(activeTab.id);
    const fresh = useDocumentStore.getState().tabs.find((t) => t.id === activeTab.id);
    if (!fresh?.bytes) return;
    // Convert the draft (bottom-left origin, scoped to the page it was
    // drawn on) into uniform TLBR margins for `cropPages`. Margins are
    // measured from each page edge inward, in PDF points.
    const top = Math.max(0, cropDraft.pageHPt - (cropDraft.yPt + cropDraft.hPt));
    const bottom = Math.max(0, cropDraft.yPt);
    const left = Math.max(0, cropDraft.xPt);
    const right = Math.max(0, cropDraft.pageWPt - (cropDraft.xPt + cropDraft.wPt));
    const { cropPages } = await import("../../lib/pdf-ops");
    const newBytes = await cropPages(fresh.bytes, { top, bottom, left, right });
    await applyEdit(activeTab.id, newBytes);
    setCropDraft(null);
    setTool("none");
  }, [activeTab, cropDraft, commitAllPending, applyEdit, setCropDraft, setTool]);

  const onCancel = useCallback(() => {
    setCropDraft(null);
    setTool("none");
  }, [setCropDraft, setTool]);

  const onReset = useCallback(() => {
    // Clearing the draft triggers CropOverlay's seed effect to re-run,
    // which re-runs auto-detect on the current page.
    setCropDraft(null);
  }, [setCropDraft]);

  // ESC cancels even when no focus is in our DOM subtree.
  // (CropOverlay handles arrow-key nudge separately.)
  // Wire here so it works even before the user has clicked into the
  // crop region.
  useEscCancel(tool === "crop", onCancel);
  useEnterApply(tool === "crop" && !!cropDraft, onApply);

  if (tool !== "crop") return null;

  const tooSmall =
    !cropDraft || cropDraft.wPt < MIN_CROP_PT || cropDraft.hPt < MIN_CROP_PT;
  const pageCount = activeTab?.numPages ?? 0;

  return (
    <div
      data-testid="crop-action-bar"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-[55] flex justify-center"
    >
      <div
        className="pointer-events-auto flex items-center gap-3 rounded-full border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)]/95 px-3 py-2 shadow-xl backdrop-blur"
      >
        <div className="flex items-center gap-2 pl-1 pr-2">
          <Crop className="h-3.5 w-3.5 text-[var(--color-accent)]" strokeWidth={2} />
          <span className="text-[12px] font-medium text-[var(--app-fg)]">Crop</span>
        </div>
        <div className="h-4 w-px bg-[var(--panel-border)]" />
        <div className="text-[11px] tabular-nums text-[var(--muted)]" data-testid="crop-dimensions">
          {cropDraft
            ? `${Math.round(cropDraft.wPt)} × ${Math.round(cropDraft.hPt)} pt`
            : "…"}
        </div>
        <div className="text-[11px] text-[var(--subtle)]">
          {pageCount === 1
            ? "applies to this page"
            : `applies to all ${pageCount} pages`}
        </div>
        {tooSmall && cropDraft && (
          <div className="text-[11px] text-[var(--color-destructive)]" data-testid="crop-too-small">
            Region too small
          </div>
        )}
        <div className="h-4 w-px bg-[var(--panel-border)]" />
        <button
          type="button"
          onClick={onReset}
          className="flex items-center gap-1 rounded-full px-2 py-1 text-[11px] text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]"
          data-testid="crop-reset"
          title="Reset to auto-detected content"
        >
          <RotateCcw className="h-3 w-3" strokeWidth={2} />
          <span>Reset</span>
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full border border-[var(--panel-border)] px-3 py-1 text-[11px] text-[var(--app-fg)] hover:bg-[var(--hover-bg)]"
          data-testid="crop-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onApply}
          disabled={tooSmall || !cropDraft}
          className="rounded-full bg-[var(--color-accent)] px-3 py-1 text-[11px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
          data-testid="crop-apply"
        >
          Apply
        </button>
      </div>
    </div>
  );
}

// Bind a single keydown handler while `active`. The closure captures
// the latest `handler` via a ref so cropDraft churn doesn't re-bind.
function useKeyHandler(active: boolean, key: string, handler: () => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== key) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      ref.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, key]);
}
function useEscCancel(active: boolean, onCancel: () => void) {
  useKeyHandler(active, "Escape", onCancel);
}
function useEnterApply(active: boolean, onApply: () => void | Promise<void>) {
  useKeyHandler(active, "Enter", () => { void onApply(); });
}
