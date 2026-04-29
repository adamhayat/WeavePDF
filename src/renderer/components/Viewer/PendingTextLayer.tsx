import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { X, Edit2, Minus, Plus } from "lucide-react";
import { useDocumentStore, type PendingTextEdit } from "../../stores/document";
import { useUIStore } from "../../stores/ui";

type Props = {
  pageNumber: number;
  zoom: number;
  pageHeightPx: number; // rendered page height in CSS pixels
};

export function PendingTextLayer({ pageNumber, zoom, pageHeightPx }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
  if (!activeTab) return null;

  const edits = activeTab.pendingTextEdits.filter((e) => e.page === pageNumber);
  if (edits.length === 0) return null;

  return (
    <>
      {edits.map((edit) => (
        <PendingTextWhiteout
          key={`${edit.id}-whiteout`}
          edit={edit}
          zoom={zoom}
          pageHeightPx={pageHeightPx}
        />
      ))}
      {edits.map((edit) => (
        <PendingText
          key={edit.id}
          edit={edit}
          zoom={zoom}
          pageHeightPx={pageHeightPx}
          tabId={activeTab.id}
        />
      ))}
    </>
  );
}

function PendingTextWhiteout({
  edit,
  zoom,
  pageHeightPx,
}: {
  edit: PendingTextEdit;
  zoom: number;
  pageHeightPx: number;
}) {
  if (!edit.whiteout) return null;
  return (
    <div
      className="pointer-events-none absolute z-[19] bg-white"
      data-testid="pending-text-whiteout"
      style={{
        left: edit.whiteout.x * zoom,
        top: pageHeightPx - (edit.whiteout.y + edit.whiteout.height) * zoom,
        width: edit.whiteout.width * zoom,
        height: edit.whiteout.height * zoom,
      }}
    />
  );
}

type PendingTextProps = {
  edit: PendingTextEdit;
  zoom: number;
  pageHeightPx: number;
  tabId: string;
};

function PendingText({ edit, zoom, pageHeightPx, tabId }: PendingTextProps) {
  const updatePendingTextEdit = useDocumentStore((s) => s.updatePendingTextEdit);
  const removePendingTextEdit = useDocumentStore((s) => s.removePendingTextEdit);
  const selected = useUIStore((s) => s.selectedPendingTextId === edit.id);
  const setSelectedId = useUIStore((s) => s.setSelectedPendingText);
  const shouldEditNow = useUIStore((s) => s.editingPendingTextId === edit.id);
  const setEditingId = useUIStore((s) => s.setEditingPendingText);
  const [isEditing, setIsEditing] = useState(false);
  const [draftText, setDraftText] = useState(edit.text);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Auto-enter edit mode when the Edit-Existing-Text click handler added us
  // with editingPendingTextId set. This turns "click the word I want to fix"
  // into "click, type replacement, press Enter" instead of "click, see a
  // duplicate, double-click to actually edit".
  useLayoutEffect(() => {
    if (shouldEditNow) {
      setDraftText(edit.text);
      setIsEditing(true);
      setSelectedId(edit.id);
      setEditingId(null);
    }
  }, [shouldEditNow, edit.text, edit.id, setEditingId, setSelectedId]);
  const dragState = useRef<{
    startClientX: number;
    startClientY: number;
    startXPt: number;
    startYPt: number;
    active: boolean;
  } | null>(null);

  // When entering edit mode, synchronously focus + select-all so the very
  // next keystroke replaces existing text. autoFocus runs after React's
  // commit which races against global keyboard handlers.
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Position — the pdf-lib drawText origin is the baseline's bottom-left, so
  // the DOM box top must sit (size * lineHeight) points above that point.
  const leftPx = edit.xPt * zoom;
  const baselineYFromTopPx = pageHeightPx - edit.yPt * zoom;
  // Approximate visual baseline with font-size * 1.2 line-box.
  const topPx = baselineYFromTopPx - edit.size * zoom * 1.0;

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (isEditing) return;
      if (e.button !== 0) return;
      const target = e.currentTarget;
      dragState.current = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startXPt: edit.xPt,
        startYPt: edit.yPt,
        active: true,
      };
      target.setPointerCapture(e.pointerId);
      setSelectedId(edit.id);
      e.stopPropagation();
    },
    [edit.xPt, edit.yPt, isEditing, edit.id, setSelectedId],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragState.current?.active) return;
      const dx = (e.clientX - dragState.current.startClientX) / zoom;
      const dy = (e.clientY - dragState.current.startClientY) / zoom;
      // Y flips: DOM down = PDF down.
      updatePendingTextEdit(tabId, edit.id, {
        xPt: dragState.current.startXPt + dx,
        yPt: dragState.current.startYPt - dy,
      });
    },
    [zoom, updatePendingTextEdit, tabId, edit.id],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragState.current) return;
      dragState.current.active = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* may already be released */
      }
    },
    [],
  );

  const commitEdit = useCallback(() => {
    updatePendingTextEdit(tabId, edit.id, { text: draftText });
    setIsEditing(false);
    setSelectedId(null);
  }, [draftText, edit.id, setSelectedId, tabId, updatePendingTextEdit]);

  // Keyboard: arrow nudge, font-size step, delete, escape — when selected and not editing.
  useEffect(() => {
    if (!selected || isEditing) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        updatePendingTextEdit(tabId, edit.id, { yPt: edit.yPt + step });
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        updatePendingTextEdit(tabId, edit.id, { yPt: edit.yPt - step });
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        updatePendingTextEdit(tabId, edit.id, { xPt: edit.xPt - step });
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        updatePendingTextEdit(tabId, edit.id, { xPt: edit.xPt + step });
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        removePendingTextEdit(tabId, edit.id);
        setSelectedId(null);
      } else if (e.key === "Enter") {
        e.preventDefault();
        setDraftText(edit.text);
        setIsEditing(true);
      } else if (e.key === "Escape") {
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [selected, isEditing, edit.xPt, edit.yPt, edit.id, edit.text, tabId, updatePendingTextEdit, removePendingTextEdit, setSelectedId]);

  return (
    <div
      className="absolute z-20 select-none"
      style={{
        left: leftPx,
        top: topPx,
        cursor: isEditing ? "text" : "move",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={() => {
        setDraftText(edit.text);
        setIsEditing(true);
      }}
      data-testid="pending-text"
      data-edit-id={edit.id}
      data-x-pt={edit.xPt.toFixed(2)}
      data-y-pt={edit.yPt.toFixed(2)}
    >
      {isEditing ? (
        <div
          className="flex items-center gap-1 rounded-md border border-[var(--color-accent)] bg-[var(--panel-bg-raised)] px-1 py-0.5 shadow-lg"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <input
            ref={inputRef}
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                commitEdit();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setIsEditing(false);
                setDraftText(edit.text);
                e.currentTarget.blur();
              }
            }}
            data-testid="pending-text-input"
            className="bg-transparent px-1 text-[var(--app-fg)] focus:outline-none"
            style={{ fontSize: edit.size * zoom, fontFamily: "Helvetica, sans-serif", width: Math.max(120, draftText.length * edit.size * zoom * 0.55) }}
          />
        </div>
      ) : (
        <div
          className={
            "group relative rounded px-0.5 outline-none transition-colors " +
            (selected
              ? "ring-2 ring-[var(--color-accent)]"
              : "hover:ring-1 hover:ring-[var(--color-accent)]/40")
          }
          style={{
            fontSize: edit.size * zoom,
            lineHeight: 1,
            fontFamily: "Helvetica, sans-serif",
            color: "#0b0b0e",
            whiteSpace: "pre",
          }}
          title="Drag to move · Double-click to edit · ← ↑ ↓ → to nudge"
        >
          {edit.text}
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setDraftText(edit.text);
              setIsEditing(true);
            }}
            className={
              "absolute -top-3.5 left-0 h-4 items-center gap-0.5 rounded bg-[var(--panel-bg-raised)] px-1 text-[10px] text-[var(--muted)] shadow-sm " +
              (selected ? "flex" : "hidden group-hover:flex")
            }
            aria-label="Edit text"
          >
            <Edit2 className="h-2.5 w-2.5" strokeWidth={2} />
          </button>
          {selected && (
            <div className="absolute -top-3.5 left-8 flex h-4 items-center gap-0.5 rounded bg-[var(--panel-bg-raised)] px-1 shadow-sm">
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  updatePendingTextEdit(tabId, edit.id, {
                    size: Math.max(6, edit.size - 1),
                  });
                }}
                className="flex h-3 w-3 items-center justify-center text-[var(--muted)] hover:text-[var(--app-fg)]"
                aria-label="Decrease font size"
              >
                <Minus className="h-2.5 w-2.5" strokeWidth={2} />
              </button>
              <span className="text-[9px] tabular-nums text-[var(--muted)]">
                {Math.round(edit.size)}
              </span>
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  updatePendingTextEdit(tabId, edit.id, {
                    size: Math.min(144, edit.size + 1),
                  });
                }}
                className="flex h-3 w-3 items-center justify-center text-[var(--muted)] hover:text-[var(--app-fg)]"
                aria-label="Increase font size"
              >
                <Plus className="h-2.5 w-2.5" strokeWidth={2} />
              </button>
            </div>
          )}
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              removePendingTextEdit(tabId, edit.id);
              setSelectedId(null);
            }}
            className={
              "absolute -top-3.5 right-0 h-4 items-center justify-center rounded bg-[var(--panel-bg-raised)] px-1 text-[10px] text-[var(--muted)] shadow-sm hover:text-[var(--color-destructive)] " +
              (selected ? "flex" : "hidden group-hover:flex")
            }
            aria-label="Remove text"
          >
            <X className="h-2.5 w-2.5" strokeWidth={2} />
          </button>
        </div>
      )}
    </div>
  );
}
