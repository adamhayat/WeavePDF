import { useCallback, useEffect, useState } from "react";
import { FileClock, RotateCcw, Trash2, Save } from "lucide-react";
import { useDocumentStore } from "../../stores/document";
import type { DraftManifest, SnapshotEntry } from "../../../shared/ipc";
import { formatBytes } from "../../lib/cn";

type Props = {
  /**
   * Restore a draft into a new tab. Implemented in `App.tsx` because draft
   * restoration touches the file system + tab/document store; the panel
   * just surfaces the list.
   */
  onRestore: (manifest: DraftManifest) => Promise<void>;
  /**
   * V1.0051: restore a saved-version snapshot into a new tab. Distinct
   * from `onRestore` (which is for autosaved unsaved-work drafts) — this
   * loads the bytes saved at the given timestamp.
   */
  onRestoreSnapshot: (filePath: string, savedAt: string) => Promise<void>;
};

/** Tagged union so the same UI can render both autosave drafts and
 *  saved-version snapshots in one chronological list. */
type RevisionItem =
  | { kind: "draft"; key: string; sortKey: string; manifest: DraftManifest }
  | { kind: "snapshot"; key: string; sortKey: string; filePath: string; entry: SnapshotEntry };

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
export function RevisionsPanel({ onRestore, onRestoreSnapshot }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const [items, setItems] = useState<RevisionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // Pull both lists in parallel — autosaved drafts (unsaved work) AND
      // saved-version snapshots (V1.0051+). Merge into one chronological
      // feed keyed by ISO timestamp so the user sees their full history.
      const [drafts, snapshots] = await Promise.all([
        window.weavepdf.drafts.list(),
        activeTab?.path
          ? window.weavepdf.snapshots.list(activeTab.path)
          : Promise.resolve([] as SnapshotEntry[]),
      ]);
      const merged: RevisionItem[] = [];
      for (const m of drafts) {
        if (!activeTab) continue;
        const matchPath = activeTab.path && m.sourcePath === activeTab.path;
        const matchKey = activeTab.draftKey && m.draftKey === activeTab.draftKey;
        if (matchPath || matchKey) {
          merged.push({ kind: "draft", key: `draft:${m.draftKey}`, sortKey: m.savedAt, manifest: m });
        }
      }
      if (activeTab?.path) {
        for (const e of snapshots) {
          merged.push({
            kind: "snapshot",
            key: `snap:${e.savedAt}`,
            sortKey: e.savedAt,
            filePath: activeTab.path,
            entry: e,
          });
        }
      }
      // Newest first.
      merged.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
      setItems(merged);
    } catch {
      setItems([]);
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

  const handleRestore = async (item: RevisionItem) => {
    setBusyKey(item.key);
    try {
      if (item.kind === "draft") {
        await onRestore(item.manifest);
      } else {
        await onRestoreSnapshot(item.filePath, item.entry.savedAt);
      }
      await refresh();
    } finally {
      setBusyKey(null);
    }
  };

  const handleDelete = async (item: RevisionItem) => {
    if (item.kind !== "draft") return; // snapshots auto-prune at 20
    setBusyKey(item.key);
    try {
      await window.weavepdf.drafts.clear(item.manifest.draftKey);
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
        <span className="tnum normal-case text-[var(--muted)]">{items.length}</span>
      </div>

      <div className="acr-scroll flex-1 overflow-y-auto p-3">
        {loading ? (
          <p className="text-[12px] text-[var(--muted)]">Loading…</p>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 pt-6 text-center text-[12px] text-[var(--muted)]">
            <FileClock className="h-6 w-6 opacity-60" strokeWidth={1.5} />
            <p>No saved revisions for this file yet.</p>
            <p className="text-[11px] opacity-80">
              Saved versions and unsaved drafts will appear here for quick
              restore.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="revisions-list">
            {items.map((item) => {
              const busy = busyKey === item.key;
              const savedAt = item.kind === "draft" ? item.manifest.savedAt : item.entry.savedAt;
              const sizeBytes =
                item.kind === "draft" ? item.manifest.sourceSizeBytes : item.entry.sizeBytes;
              const label = item.kind === "draft" ? draftSummary(item.manifest) : "saved version";
              return (
                <li
                  key={item.key}
                  className="rounded-lg border border-[var(--panel-border)] bg-[var(--panel-bg-raised)] p-3"
                  data-testid="revision-row"
                  data-revision-kind={item.kind}
                >
                  <div className="flex items-start gap-2">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-[var(--color-accent)]">
                      {item.kind === "draft" ? (
                        <FileClock className="h-3.5 w-3.5" strokeWidth={1.7} />
                      ) : (
                        <Save className="h-3.5 w-3.5" strokeWidth={1.7} />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-medium text-[var(--app-fg)]">
                        {formatRelativeTime(savedAt)}
                      </p>
                      <p className="mt-0.5 text-[11px] text-[var(--muted)]">
                        {label} · <span className="tnum">{formatBytes(sizeBytes)}</span>
                      </p>
                    </div>
                  </div>

                  <div className="mt-2 flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void handleRestore(item)}
                      disabled={busy}
                      className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2 text-[11px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
                      data-testid="revision-restore"
                    >
                      <RotateCcw className="h-3 w-3" strokeWidth={2} />
                      Restore
                    </button>
                    {item.kind === "draft" && (
                      <button
                        type="button"
                        onClick={() => void handleDelete(item)}
                        disabled={busy}
                        title="Delete this draft"
                        aria-label="Delete this draft"
                        className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[color-mix(in_srgb,var(--color-destructive)_15%,transparent)] hover:text-[var(--color-destructive)] disabled:opacity-60"
                        data-testid="revision-delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
                      </button>
                    )}
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

function draftSummary(m: DraftManifest): string {
  const parts: string[] = [];
  if (m.hasAppliedChanges) parts.push("committed edits");
  if (m.pendingTextEdits.length > 0)
    parts.push(`${m.pendingTextEdits.length} text`);
  if (m.pendingImageEdits.length > 0)
    parts.push(`${m.pendingImageEdits.length} image`);
  if (m.pendingShapeEdits.length > 0)
    parts.push(`${m.pendingShapeEdits.length} shape`);
  if (parts.length === 0) return "draft";
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

