import { useEffect, useState } from "react";
import { X, FileClock, Trash2 } from "lucide-react";
import type { DraftManifest } from "../../../shared/ipc";
import { formatBytes, cn } from "../../lib/cn";

type Props = {
  open: boolean;
  onClose: () => void;
  onRestore: (manifest: DraftManifest) => Promise<void> | void;
};

export function RecentDraftsModal({ open, onClose, onRestore }: Props) {
  const [drafts, setDrafts] = useState<DraftManifest[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoringKey, setRestoringKey] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    window.weavepdf.drafts
      .list()
      .then(setDrafts)
      .catch(() => setDrafts([]))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  const refresh = async () => {
    const list = await window.weavepdf.drafts.list();
    setDrafts(list);
  };

  const handleDiscard = async (m: DraftManifest, e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = window.confirm(`Discard draft "${m.originalName}"? This can't be undone.`);
    if (!ok) return;
    await window.weavepdf.drafts.clear(m.draftKey);
    await refresh();
  };

  const handleRestore = async (m: DraftManifest) => {
    setRestoringKey(m.draftKey);
    try {
      await onRestore(m);
      onClose();
    } finally {
      setRestoringKey(null);
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
        data-testid="recent-drafts-modal"
      >
        <div className="flex items-center justify-between border-b border-[var(--panel-border)] px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold">Recent drafts</h2>
            <p className="text-[11px] text-[var(--muted)]">
              In-progress edits saved automatically. Open one to pick up where you left off.
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

        <div className="flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="p-4 text-center text-[12px] text-[var(--muted)]">Loading…</div>
          ) : drafts.length === 0 ? (
            <div className="p-8 text-center text-[12px] text-[var(--muted)]">
              <FileClock className="mx-auto mb-2 h-8 w-8 opacity-40" strokeWidth={1.4} />
              No drafts yet. WeavePDF will autosave here as you edit.
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {drafts.map((m) => {
                const virtual = !m.sourcePath;
                const restoring = restoringKey === m.draftKey;
                return (
                  <li key={m.draftKey}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => !restoring && void handleRestore(m)}
                      onKeyDown={(e) => {
                        if (restoring) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          void handleRestore(m);
                        }
                      }}
                      className={cn(
                        "group flex w-full cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors",
                        "hover:border-[var(--panel-border)] hover:bg-[var(--hover-bg)]",
                        restoring && "cursor-wait opacity-60",
                      )}
                      data-testid={`draft-${m.draftKey}`}
                    >
                      <div className="flex-1 overflow-hidden">
                        <div className="truncate text-[13px] font-medium">
                          {m.originalName}
                          {virtual && (
                            <span className="ml-2 rounded-full bg-[var(--hover-bg)] px-1.5 py-0.5 text-[10px] font-normal text-[var(--muted)]">
                              untitled
                            </span>
                          )}
                          {m.hasAppliedChanges && (
                            <span className="ml-2 rounded-full bg-[color-mix(in_srgb,var(--color-accent)_15%,transparent)] px-1.5 py-0.5 text-[10px] font-normal text-[var(--color-accent)]">
                              edited
                            </span>
                          )}
                        </div>
                        <div className="truncate text-[11px] text-[var(--muted)]">
                          {formatRelativeTime(m.savedAt)}
                          {" · "}
                          <span className="tnum">{formatBytes(m.sourceSizeBytes)}</span>
                          {pendingCountSuffix(m)}
                          {m.sourcePath && (
                            <>
                              {" · "}
                              <span className="truncate">{m.sourcePath}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => void handleDiscard(m, e)}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] opacity-0 transition-opacity hover:bg-[var(--hover-bg)] hover:text-[var(--color-destructive)] group-hover:opacity-100"
                        aria-label={`Discard ${m.originalName}`}
                        data-testid={`discard-${m.draftKey}`}
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
    </div>
  );
}

function pendingCountSuffix(m: DraftManifest): string {
  const parts: string[] = [];
  if (m.pendingTextEdits.length > 0) parts.push(`${m.pendingTextEdits.length} text`);
  if (m.pendingImageEdits.length > 0) parts.push(`${m.pendingImageEdits.length} image`);
  if (m.pendingShapeEdits.length > 0) parts.push(`${m.pendingShapeEdits.length} shape`);
  return parts.length > 0 ? ` · ${parts.join(", ")} pending` : "";
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
