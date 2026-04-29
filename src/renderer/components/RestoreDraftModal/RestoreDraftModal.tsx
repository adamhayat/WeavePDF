import { FileClock } from "lucide-react";
import type { DraftManifest } from "../../../shared/ipc";
import { formatBytes } from "../../lib/cn";

type Props = {
  manifest: DraftManifest;
  onRestore: () => void;
  onDiscardAndOpen: () => void;
  onCancel: () => void;
};

/**
 * Quick prompt that fires when the user reopens a file that has an autosaved
 * draft on disk. Three actions:
 *   - Restore — load draft state on top of the original
 *   - Open original — discard the draft and open the file fresh
 *   - Cancel — back out entirely (don't open anything)
 */
export function RestoreDraftModal({ manifest, onRestore, onDiscardAndOpen, onCancel }: Props) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="w-[440px] rounded-2xl border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] p-5 shadow-2xl"
        data-testid="restore-draft-modal"
      >
        <div className="mb-4 flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-[var(--color-accent)]">
            <FileClock className="h-5 w-5" strokeWidth={1.6} />
          </div>
          <div className="flex-1">
            <h2 className="text-[15px] font-semibold">Restore unsaved work?</h2>
            <p className="mt-1 text-[12px] text-[var(--muted)]">
              You have an autosaved draft for{" "}
              <span className="font-medium text-[var(--app-fg)]">{manifest.originalName}</span> from{" "}
              {formatRelativeTime(manifest.savedAt)}.
              {pendingSummary(manifest)}
              {" "}
              <span className="tnum">{formatBytes(manifest.sourceSizeBytes)}</span> on disk.
            </p>
          </div>
        </div>

        <div className="mt-2 flex flex-col gap-2">
          <button
            type="button"
            onClick={onRestore}
            className="w-full rounded-md bg-[var(--color-accent)] px-3 py-2 text-[13px] font-medium text-white hover:bg-[var(--color-accent-hover)]"
            data-testid="restore-draft-yes"
          >
            Restore draft
          </button>
          <button
            type="button"
            onClick={onDiscardAndOpen}
            className="w-full rounded-md border border-[var(--panel-border)] px-3 py-2 text-[13px] text-[var(--app-fg)] hover:bg-[var(--hover-bg)]"
            data-testid="restore-draft-discard"
          >
            Open original (discard draft)
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="w-full rounded-md px-3 py-2 text-[12px] text-[var(--muted)] hover:bg-[var(--hover-bg)]"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function pendingSummary(m: DraftManifest): string {
  const parts: string[] = [];
  if (m.pendingTextEdits.length > 0) parts.push(`${m.pendingTextEdits.length} text edit${m.pendingTextEdits.length === 1 ? "" : "s"}`);
  if (m.pendingImageEdits.length > 0) parts.push(`${m.pendingImageEdits.length} image${m.pendingImageEdits.length === 1 ? "" : "s"}`);
  if (m.pendingShapeEdits.length > 0) parts.push(`${m.pendingShapeEdits.length} shape${m.pendingShapeEdits.length === 1 ? "" : "s"}`);
  if (m.hasAppliedChanges) parts.push("committed edits");
  if (parts.length === 0) return "";
  return ` ${parts.join(", ")}.`;
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const sec = Math.floor((Date.now() - then) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
