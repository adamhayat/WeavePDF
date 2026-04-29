import { cloneElement, useCallback, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Props = {
  label: string;
  shortcut?: string;
  children: React.ReactElement<{
    "aria-describedby"?: string;
  }>;
};

type Position = {
  left: number;
  top: number;
};

export function ShortcutTooltip({ label, shortcut, children }: Props) {
  const id = useId();
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<Position | null>(null);

  const show = useCallback(() => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(96, Math.min(window.innerWidth - 96, rect.left + rect.width / 2));
    setPosition({ left, top: rect.bottom + 8 });
  }, []);

  const hide = useCallback(() => setPosition(null), []);

  return (
    <span
      ref={wrapperRef}
      className="inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
    >
      {cloneElement(children, {
        "aria-describedby": position ? id : undefined,
      })}
      {position &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            data-testid="shortcut-tooltip"
            className="pointer-events-none fixed z-[80] -translate-x-1/2 rounded-lg border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] px-2.5 py-1.5 text-[11px] text-[var(--app-fg)] shadow-xl"
            style={{ left: position.left, top: position.top }}
          >
            <span className="mr-2 whitespace-nowrap">{label}</span>
            {shortcut && (
              <kbd className="rounded bg-[var(--hover-bg)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)]">
                {shortcut}
              </kbd>
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}
