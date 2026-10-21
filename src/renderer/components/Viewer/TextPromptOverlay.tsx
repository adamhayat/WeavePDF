import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { useUIStore } from "../../stores/ui";
import { useDocumentStore } from "../../stores/document";
import { clearActiveFieldFlusher, setActiveFieldFlusher } from "../../lib/pending-field";

const MIN_WRAP_TEXT_WIDTH_PT = 120;

type Props = {
  pageNumber: number;
  zoom: number;
  pageHeightPx: number;
};

export function TextPromptOverlay({ pageNumber, zoom, pageHeightPx }: Props) {
  const prompt = useUIStore((s) => s.textPrompt);
  const setTextPrompt = useUIStore((s) => s.setTextPrompt);
  const clearAllPendingSelections = useUIStore((s) => s.clearAllPendingSelections);
  const setSelectedPendingText = useUIStore((s) => s.setSelectedPendingText);
  const activeTab = useDocumentStore((s) => s.activeTab());
  const addPendingTextEdit = useDocumentStore((s) => s.addPendingTextEdit);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  const [size, setSize] = useState(14);

  // V1.0126: what's typed into the open box, so it can be KEPT when the user
  // clicks somewhere else (or saves) instead of pressing Enter. Before, a
  // click elsewhere opened a fresh box and everything typed was thrown away.
  // Escape / ✕ still discard on purpose.
  type Draft = { tabId: string; page: number; x: number; y: number; size: number; text: string; widthPt: number };
  const draftRef = useRef<Draft | null>(null);
  const keepDraft = () => {
    const d = draftRef.current;
    draftRef.current = null;
    if (!d || !d.text.trim()) return;
    useDocumentStore.getState().addPendingTextEdit(d.tabId, {
      page: d.page, xPt: d.x, yPt: d.y, size: d.size, text: d.text, widthPt: d.widthPt,
    });
  };

  useEffect(() => {
    // The prompt moved, closed or switched page: keep what was typed.
    keepDraft();
    if (prompt?.page === pageNumber) {
      setValue("");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt?.page, prompt?.x, prompt?.y, pageNumber]);

  // Keep what was typed if the box unmounts (tab switch, tool change).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => keepDraft(), []);

  // ⌘S / ⌘P while the box is open: include the typed text.
  const promptOpenHere = prompt?.page === pageNumber;
  useEffect(() => {
    if (!promptOpenHere) return;
    const flush = async () => {
      // Keep it AND close the box, or Enter afterwards would add it twice.
      keepDraft();
      useUIStore.getState().setTextPrompt(null);
    };
    setActiveFieldFlusher(flush);
    return () => clearActiveFieldFlusher(flush);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptOpenHere, prompt?.x, prompt?.y]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value, size, zoom, prompt?.widthPt]);

  if (!prompt || prompt.page !== pageNumber) return null;

  const leftPx = prompt.x * zoom;
  const topPx = pageHeightPx - prompt.y * zoom;
  const inputTop = topPx - size * zoom * 1.2;
  const widthPt = Math.max(MIN_WRAP_TEXT_WIDTH_PT, prompt.widthPt ?? MIN_WRAP_TEXT_WIDTH_PT);
  draftRef.current = activeTab
    ? { tabId: activeTab.id, page: prompt.page, x: prompt.x, y: prompt.y, size, text: value, widthPt }
    : null;

  const cancel = () => {
    draftRef.current = null;
    setTextPrompt(null);
  };

  const commit = () => {
    draftRef.current = null;
    if (!activeTab || !value.trim()) {
      setTextPrompt(null);
      return;
    }
    const editId = addPendingTextEdit(activeTab.id, {
      page: prompt.page,
      xPt: prompt.x,
      yPt: prompt.y,
      size,
      text: value,
      // V1.0062: carry the margin-aware width through from PageCanvas so the
      // new text wraps to fit the printable area.
      widthPt,
    });
    clearAllPendingSelections();
    setSelectedPendingText(editId);
    setTextPrompt(null);
  };

  return (
    <div
      className="absolute z-30"
      style={{ left: leftPx, top: inputTop }}
      data-testid="text-prompt"
    >
      <textarea
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        placeholder="Type text…"
        rows={1}
        className="block resize-none overflow-hidden rounded-[2px] border border-[var(--color-accent)]/70 bg-transparent px-1 py-0.5 text-[#0b0b0e] placeholder:text-[rgba(11,11,14,0.45)] caret-[var(--color-accent)] shadow-[0_0_0_1px_rgba(59,76,202,0.12)] focus:border-[var(--color-accent)] focus:outline-none"
        style={{
          fontSize: size * zoom,
          lineHeight: 1.2,
          fontFamily: "Helvetica, sans-serif",
          width: widthPt * zoom,
          minHeight: `${size * zoom * 1.2}px`,
          wordBreak: "break-word",
          overflowWrap: "break-word",
        }}
        data-testid="text-prompt-input"
      />
      <div
        className="absolute -top-5 left-0 flex h-4 items-center gap-1 rounded bg-[var(--panel-bg-raised)] px-1 shadow-sm"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <select
          value={size}
          onChange={(e) => setSize(Number(e.target.value))}
          className="bg-transparent text-[10px] tabular-nums text-[var(--muted)] focus:outline-none"
          onKeyDown={(e) => e.stopPropagation()}
          aria-label="Font size"
        >
          <option value={10}>10</option>
          <option value={12}>12</option>
          <option value={14}>14</option>
          <option value={18}>18</option>
          <option value={24}>24</option>
          <option value={36}>36</option>
        </select>
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            commit();
          }}
          disabled={!value.trim()}
          className="flex h-3 w-3 items-center justify-center rounded-sm bg-[var(--color-accent)] text-white shadow-sm hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
          aria-label="Add text"
          title="Add text · Enter"
          data-testid="text-prompt-confirm"
        >
          <Check className="h-2.5 w-2.5" strokeWidth={2.5} />
        </button>
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            cancel();
          }}
          className="flex h-3 w-3 items-center justify-center rounded-sm text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]"
          aria-label="Cancel"
          title="Cancel · Esc"
        >
          <X className="h-2.5 w-2.5" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}
