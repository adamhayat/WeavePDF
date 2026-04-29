import { useEffect, useRef, useState } from "react";
import { useUIStore } from "../../stores/ui";
import { useDocumentStore } from "../../stores/document";

type Props = {
  pageNumber: number;
  zoom: number;
  pageHeightPx: number;
};

export function StickyPromptOverlay({ pageNumber, zoom, pageHeightPx }: Props) {
  const prompt = useUIStore((s) => s.stickyPrompt);
  const setStickyPrompt = useUIStore((s) => s.setStickyPrompt);
  const setTool = useUIStore((s) => s.setTool);
  const setSelectedShape = useUIStore((s) => s.setSelectedPendingShape);
  const activeTab = useDocumentStore((s) => s.activeTab());
  const addPendingShape = useDocumentStore((s) => s.addPendingShapeEdit);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (prompt?.page === pageNumber) {
      setValue("");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [prompt?.page, prompt?.xPt, prompt?.yPt, pageNumber]);

  if (!prompt || prompt.page !== pageNumber) return null;

  const leftPx = prompt.xPt * zoom;
  // yPt is the top of the intended note; in PDF coords.
  const topPx = pageHeightPx - prompt.yPt * zoom;

  const commit = async () => {
    if (!activeTab) {
      setStickyPrompt(null);
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      setStickyPrompt(null);
      setTool("none");
      return;
    }
    setBusy(true);
    try {
      // Route through pending-shape so the user can drag the marker around
      // and re-edit the text before committing on save.
      const newId = addPendingShape(activeTab.id, {
        kind: "sticky",
        page: prompt.page,
        xPt: prompt.xPt,
        yPt: prompt.yPt - 16,
        text: trimmed,
      });
      setSelectedShape(newId);
      setStickyPrompt(null);
      setTool("none");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="absolute z-30 flex flex-col gap-1 rounded-md border border-[#f5c21e] bg-[#fff7c2] p-2 shadow-lg"
      style={{ left: leftPx, top: topPx, minWidth: 180 }}
      data-testid="sticky-prompt"
    >
      <textarea
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setStickyPrompt(null);
            setTool("none");
          }
        }}
        placeholder="Sticky note…"
        disabled={busy}
        className="min-h-[60px] w-full resize-y border-0 bg-transparent px-0 text-[12px] leading-snug text-[#3a2d00] placeholder:text-[#8a6f00] focus:outline-none disabled:opacity-60"
        rows={3}
        data-testid="sticky-prompt-input"
      />
      <div className="flex items-center justify-between border-t border-[#e5b81c]/40 pt-1">
        <span className="text-[10px] text-[#8a6f00]">⌘↵ to save · Esc to cancel</span>
        <button
          type="button"
          onClick={() => void commit()}
          disabled={busy || !value.trim()}
          className="rounded bg-[#f5c21e] px-2 py-0.5 text-[11px] font-medium text-[#3a2d00] hover:bg-[#f5b700] disabled:opacity-60"
        >
          {busy ? "…" : "Save"}
        </button>
      </div>
    </div>
  );
}
