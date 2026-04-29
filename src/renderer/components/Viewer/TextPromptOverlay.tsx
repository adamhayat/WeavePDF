import { useEffect, useRef, useState } from "react";
import { useUIStore } from "../../stores/ui";
import { useDocumentStore } from "../../stores/document";

type Props = {
  pageNumber: number;
  zoom: number;
  pageHeightPx: number;
};

export function TextPromptOverlay({ pageNumber, zoom, pageHeightPx }: Props) {
  const prompt = useUIStore((s) => s.textPrompt);
  const setTextPrompt = useUIStore((s) => s.setTextPrompt);
  const activeTab = useDocumentStore((s) => s.activeTab());
  const addPendingTextEdit = useDocumentStore((s) => s.addPendingTextEdit);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [size, setSize] = useState(14);

  useEffect(() => {
    if (prompt?.page === pageNumber) {
      setValue("");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [prompt?.page, prompt?.x, prompt?.y, pageNumber]);

  if (!prompt || prompt.page !== pageNumber) return null;

  const leftPx = prompt.x * zoom;
  const topPx = pageHeightPx - prompt.y * zoom;
  const inputTop = topPx - size * zoom * 1.2;

  const commit = () => {
    if (!activeTab || !value.trim()) {
      setTextPrompt(null);
      return;
    }
    addPendingTextEdit(activeTab.id, {
      page: prompt.page,
      xPt: prompt.x,
      yPt: prompt.y,
      size,
      text: value,
    });
    setTextPrompt(null);
  };

  return (
    <div
      className="absolute z-30 flex items-center gap-1 rounded-md border border-[var(--color-accent)] bg-[var(--panel-bg-raised)] px-1 py-0.5 shadow-lg"
      style={{ left: leftPx, top: inputTop }}
      data-testid="text-prompt"
    >
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setTextPrompt(null);
          }
        }}
        placeholder="Type text…"
        className="w-[240px] border-0 bg-transparent px-1 text-[13px] text-[var(--app-fg)] placeholder:text-[var(--subtle)] focus:outline-none"
        style={{ fontSize: size * zoom }}
        data-testid="text-prompt-input"
      />
      <select
        value={size}
        onChange={(e) => setSize(Number(e.target.value))}
        className="bg-transparent text-[11px] text-[var(--muted)]"
        onKeyDown={(e) => e.stopPropagation()}
      >
        <option value={10}>10</option>
        <option value={12}>12</option>
        <option value={14}>14</option>
        <option value={18}>18</option>
        <option value={24}>24</option>
        <option value={36}>36</option>
      </select>
    </div>
  );
}
