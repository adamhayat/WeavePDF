import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type MenuItem =
  | { kind: "item"; label: string; shortcut?: string; onClick: () => void; disabled?: boolean; danger?: boolean }
  | { kind: "separator" };

type Props = {
  open: boolean;
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
};

export function ContextMenu({ open, x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });

  // Reposition to stay on-screen.
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const el = ref.current;
    const rect = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (nx + rect.width > window.innerWidth - 8) nx = window.innerWidth - rect.width - 8;
    if (ny + rect.height > window.innerHeight - 8) ny = window.innerHeight - rect.height - 8;
    setPos({ x: Math.max(8, nx), y: Math.max(8, ny) });
  }, [open, x, y, items.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-[100] min-w-[180px] rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg-raised)] py-1 shadow-2xl backdrop-blur-sm"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => {
        if (it.kind === "separator") {
          return <div key={i} className="my-1 h-px bg-[var(--panel-border)]" />;
        }
        return (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              it.onClick();
              onClose();
            }}
            className={
              "flex w-full items-center justify-between gap-4 px-3 py-1 text-left text-[13px] " +
              (it.disabled
                ? "cursor-default text-[var(--muted)] opacity-50"
                : it.danger
                  ? "text-[var(--color-destructive)] hover:bg-[var(--color-destructive)]/10"
                  : "text-[var(--app-fg)] hover:bg-[var(--color-accent)]/10")
            }
          >
            <span>{it.label}</span>
            {it.shortcut && (
              <span className="text-[11px] tabular-nums text-[var(--muted)]">{it.shortcut}</span>
            )}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
