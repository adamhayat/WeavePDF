import { useCallback, useEffect, useState } from "react";
import { FileClock, RotateCcw, Trash2 } from "lucide-react";
import { useDocumentStore } from "../../stores/document";
import type { DraftManifest } from "../../../shared/ipc";
import { formatBytes } from "../../lib/cn";

type Props = {
  /**
   * Restore a draft into a new tab. Implemented in `App.tsx` because draft
   * restoration touches the file system + tab/document store; the panel
   * just surfaces the list.
   */
  onRestore: (manifest: DraftManifest) => Promise<void>;
};

/**
 * Lists autosaved drafts for the active tab's source file. V1.0040 replaces
 * the "Restore unsaved work?" modal that fired on every open: drafts now
 * surface here so the user can pick when (or if) to restore — no interruption
 * just for opening a file.
 *
 * Today, drafts are single-slot-per-file (one slot keyed by absolute path),
 * so this list will show 0 or 1 entry per active tab. When the snapshotting
 * model gets richer in a future version, the panel renders any number of
 * timestamped revisions without further changes.
 */
export function RevisionsPanel({ onRestore }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const [revisions, setRevisions] = useState<DraftManifest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const all = await window.weavepdf.drafts.list();
      const filtered = all.filter((m) => {
        if (!activeTab) return false;
        if (activeTab.path && m.sourcePath === activeTab.path) return true;
        if (activeTab.draftKey && m.draftKey === activeTab.draftKey) return true;
        return false;
      });
      setRevisions(filtered);
    } catch {
      setRevisions([]);
    } finally {
      setLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    void refresh();
    // Refresh after every applyEdit so a freshly-autosaved draft surfaces
    // without the user having to switch tabs. version bump = something just
    // committed → debounced autosave will fire shortly after.
  }, [refresh, activeTab?.version]);

  const handleRestore = async (m: DraftManifest) => {
    setBusyKey(m.draftKey);
    try {
      await onRestore(m);
      await refresh();
    } finally {
      setBusyKey(null);
    }
  };

  const handleDelete = async (m: DraftManifest) => {
    setBusyKey(m.draftKey);
    try {
      await window.weavepdf.drafts.clear(m.draftKey);
      await refresh();
    } finally {
      setBusyKey(null);
    }
  };

  if (!activeTab) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--panel-border)] px-3 text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">
        Revisions
        <span className="tnum normal-case text-[var(--muted)]">{revisions.length}</span>
      </div>

      <div className="acr-scroll flex-1 overflow-y-auto p-3">
        {loading ? (
          <p className="text-[12px] text-[var(--muted)]">Loading…</p>
        ) : revisions.length === 0 ? (
          <div className="flex flex-col items-center gap-2 pt-6 text-center text-[12px] text-[var(--muted)]">
            <FileClock className="h-6 w-6 opacity-60" strokeWidth={1.5} />
            <p>No saved revisions for this file yet.</p>
            <p className="text-[11px] opacity-80">
              Edits autosave in the background. Past versions appear here for
              quick restore.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="revisions-list">
            {revisions.map((m) => {
              const busy = busyKey === m.draftKey;
              return (
                <li
                  key={m.draftKey}
                  className="rounded-lg border border-[var(--panel-border)] bg-[var(--panel-bg-raised)] p-3"
                  data-testid="revision-row"
                >
                  <div className="flex items-start gap-2">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-[var(--color-accent)]">
                      <FileClock className="h-3.5 w-3.5" strokeWidth={1.7} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-medium text-[var(--app-fg)]">
                        {formatRelativeTime(m.savedAt)}
                      </p>
                      <p className="mt-0.5 text-[11px] text-[var(--muted)]">
                        {summary(m)} · <span className="tnum">{formatBytes(m.sourceSizeBytes)}</span>
                      </p>
                    </div>
                  </div>

                  <div className="mt-2 flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void handleRestore(m)}
                      disabled={busy}
                      className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2 text-[11px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
                      data-testid="revision-restore"
                    >
                      <RotateCcw className="h-3 w-3" strokeWidth={2} />
                      Restore
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(m)}
                      disabled={busy}
                      title="Delete this draft"
                      aria-label="Delete this draft"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[color-mix(in_srgb,var(--color-destructive)_15%,transparent)] hover:text-[var(--color-destructive)] disabled:opacity-60"
                      data-testid="revision-delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function summary(m: DraftManifest): string {
  const parts: string[] = [];
  if (m.hasAppliedChanges) parts.push("committed edits");
  if (m.pendingTextEdits.length > 0)
    parts.push(`${m.pendingTextEdits.length} text`);
  if (m.pendingImageEdits.length > 0)
    parts.push(`${m.pendingImageEdits.length} image`);
  if (m.pendingShapeEdits.length > 0)
    parts.push(`${m.pendingShapeEdits.length} shape`);
  if (parts.length === 0) return "snapshot";
  return parts.join(", ");
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const sec = Math.floor((Date.now() - then) / 1000);
  if (sec < 5) return "Just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

