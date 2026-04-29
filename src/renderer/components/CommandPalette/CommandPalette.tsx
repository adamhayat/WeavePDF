import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "../../lib/cn";

export type PaletteAction = {
  id: string;
  label: string;
  group?: string;
  shortcut?: string;
  disabled?: boolean;
  keywords?: string[];
  run: () => void | Promise<void>;
};

type Props = { open: boolean; onClose: () => void; actions: PaletteAction[] };

function matches(action: PaletteAction, query: string): boolean {
  if (!query) return true;
  const hay = [action.label, action.group ?? "", ...(action.keywords ?? [])]
    .join(" ")
    .toLowerCase();
  // simple token-based match: every token must appear somewhere.
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t));
}

export function CommandPalette({ open, onClose, actions }: Props) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(
    () => actions.filter((a) => matches(a, query)),
    [actions, query],
  );

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (filtered.length === 0) {
      setCursor(0);
      return;
    }
    if (cursor >= filtered.length) {
      setCursor(Math.max(0, filtered.length - 1));
      return;
    }
    if (filtered[cursor]?.disabled) {
      const nextEnabled = filtered.findIndex((a) => !a.disabled);
      if (nextEnabled >= 0) setCursor(nextEnabled);
    }
  }, [filtered, cursor]);

  if (!open) return null;

  const run = async (a: PaletteAction) => {
    if (a.disabled) return;
    onClose();
    await a.run();
  };

  const moveCursor = (delta: 1 | -1) => {
    if (filtered.length === 0) return;
    let next = cursor;
    for (let i = 0; i < filtered.length; i++) {
      next = Math.max(0, Math.min(filtered.length - 1, next + delta));
      if (!filtered[next]?.disabled || next === 0 || next === filtered.length - 1) break;
    }
    setCursor(next);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[120px] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="palette"
    >
      <div className="w-[520px] overflow-hidden rounded-2xl border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] shadow-2xl">
        <div className="flex h-11 items-center gap-2 border-b border-[var(--panel-border)] px-3">
          <Search className="h-4 w-4 text-[var(--muted)]" strokeWidth={1.8} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                moveCursor(1);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                moveCursor(-1);
              } else if (e.key === "Enter") {
                e.preventDefault();
                const a = filtered[cursor];
                if (a) void run(a);
              }
            }}
            placeholder="Search commands…"
            className="flex-1 bg-transparent text-[14px] text-[var(--app-fg)] placeholder:text-[var(--subtle)] focus:outline-none"
            data-testid="palette-input"
          />
        </div>
        <div className="max-h-[380px] overflow-y-auto acr-scroll p-1">
          {filtered.length === 0 ? (
            <div className="p-4 text-center text-[12px] text-[var(--muted)]">
              No commands
            </div>
          ) : (
            filtered.map((a, i) => (
              <button
                key={a.id}
                type="button"
                onClick={() => run(a)}
                onMouseEnter={() => {
                  if (!a.disabled) setCursor(i);
                }}
                className={cn(
                  "flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-[13px] transition-colors",
                  a.disabled
                    ? "cursor-default opacity-45"
                    : "",
                  i === cursor && !a.disabled
                    ? "bg-[var(--hover-bg)] text-[var(--app-fg)]"
                    : "text-[var(--app-fg)]",
                )}
                disabled={a.disabled}
                data-testid="palette-item"
                data-action-id={a.id}
              >
                <div className="flex items-center gap-3">
                  <span>{a.label}</span>
                  {a.group && (
                    <span className="text-[10px] uppercase tracking-wider text-[var(--subtle)]">
                      {a.group}
                    </span>
                  )}
                  {a.disabled && (
                    <span className="text-[10px] text-[var(--subtle)]">
                      Open a PDF first
                    </span>
                  )}
                </div>
                {a.shortcut && (
                  <kbd className="rounded bg-[var(--hover-bg)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)]">
                    {a.shortcut}
                  </kbd>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
