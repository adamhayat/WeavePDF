import { useEffect, useRef } from "react";
import { Keyboard, X } from "lucide-react";
import pkg from "../../../../package.json";

type Props = {
  open: boolean;
  onClose: () => void;
};

const APP_VERSION_DISPLAY = (() => {
  const parts = pkg.version.split(".");
  const major = parts[0] ?? "1";
  const patch = parseInt(parts[2] ?? "0", 10) || 0;
  return `V${major}.${String(patch).padStart(4, "0")}`;
})();

type ShortcutSection = {
  title: string;
  rows: Array<{ action: string; shortcut: string }>;
};

const sections: ShortcutSection[] = [
  {
    title: "File & Navigation",
    rows: [
      { action: "Open", shortcut: "⌘O" },
      { action: "Save", shortcut: "⌘S" },
      { action: "Save As", shortcut: "⌘⇧S" },
      { action: "Export combined PDF", shortcut: "⌘E" },
      { action: "Print", shortcut: "⌘P" },
      { action: "Command Palette", shortcut: "⌘K" },
      { action: "Keyboard Shortcuts", shortcut: "⌘/" },
      { action: "Find in document", shortcut: "⌘F" },
      { action: "Toggle sidebar", shortcut: "⌘B" },
      { action: "Close tab", shortcut: "⌘W" },
      { action: "Switch tabs", shortcut: "⌘1-9" },
      { action: "Select all pages", shortcut: "⌘A" },
      { action: "Zoom in / out / 100%", shortcut: "⌘=  ⌘−  ⌘0" },
      { action: "Next / previous page", shortcut: "→  ←  PgDn  PgUp" },
      { action: "Clear selection / close surface", shortcut: "Esc" },
    ],
  },
  {
    title: "Tools",
    rows: [
      { action: "Add Text", shortcut: "T" },
      { action: "Edit Existing Text", shortcut: "E" },
      { action: "Signature", shortcut: "S" },
      { action: "Place Image", shortcut: "I" },
      { action: "Sticky Note", shortcut: "N" },
      { action: "Highlight", shortcut: "H" },
      { action: "Whiteout", shortcut: "W" },
      { action: "Redact", shortcut: "X" },
      { action: "Rectangle", shortcut: "R" },
      { action: "Ellipse", shortcut: "O" },
      { action: "Line", shortcut: "L" },
      { action: "Arrow", shortcut: "A" },
      { action: "Draw", shortcut: "D" },
      { action: "Link", shortcut: "K" },
      { action: "Measure", shortcut: "M" },
      { action: "Crop", shortcut: "C" },
    ],
  },
  {
    title: "Document",
    rows: [
      { action: "Undo / redo", shortcut: "⌘Z  ⌘⇧Z" },
      { action: "Rotate left / right / 180°", shortcut: "⌘[  ⌘]  ⌘⇧]" },
      { action: "Delete selected pages", shortcut: "⌫  Del" },
      { action: "Extract pages", shortcut: "⌘⌥E" },
      { action: "Compress PDF", shortcut: "⌘⌥C" },
      { action: "Watermark", shortcut: "⌘⌥W" },
      { action: "Header / footer", shortcut: "⌘⌥P" },
      { action: "Document properties", shortcut: "⌘I" },
      { action: "Page layout", shortcut: "⌘⌥L" },
      { action: "Fill form", shortcut: "⌘⌥F" },
      { action: "OCR", shortcut: "⌘⌥O" },
      { action: "Digital sign", shortcut: "⌘⌥D" },
      { action: "Apple Intelligence", shortcut: "⌘⌥A" },
      { action: "Encrypt", shortcut: "⌘⌥K" },
      { action: "Export Markdown", shortcut: "⌘⌥M" },
      { action: "Export Word", shortcut: "⌘⌥X" },
      { action: "Batch ops", shortcut: "⌘⌥B" },
      { action: "Recent drafts", shortcut: "⌘⌥R" },
      { action: "View single / spread / cover", shortcut: "⌘⌥1  ⌘⌥2  ⌘⌥3" },
    ],
  },
];

export function ShortcutHelpModal({ open, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => closeRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-help-title"
        className="flex max-h-[82vh] w-[calc(100vw-32px)] max-w-[900px] flex-col overflow-hidden rounded-2xl border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] shadow-2xl"
        data-testid="shortcut-help-modal"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--panel-border)] px-5 py-4">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              <Keyboard className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.8} />
              <h2 id="shortcut-help-title" className="text-[15px] font-semibold">
                Keyboard Shortcuts
              </h2>
            </div>
            <p className="text-[12px] text-[var(--muted)]">
              Tool keys work when a PDF is open and no text field or modal is active.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>

        <div className="grid min-h-0 gap-4 overflow-y-auto p-5 acr-scroll md:grid-cols-3">
          {sections.map((section) => (
            <section key={section.title} className="min-w-0">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--subtle)]">
                {section.title}
              </h3>
              <div className="overflow-hidden rounded-lg border border-[var(--panel-border)]">
                {section.rows.map((row) => (
                  <div
                    key={`${section.title}-${row.action}`}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--panel-border)] px-3 py-2 last:border-b-0"
                  >
                    <span className="min-w-0 text-[12px] leading-snug text-[var(--app-fg)]">
                      {row.action}
                    </span>
                    <kbd className="max-w-[170px] whitespace-nowrap rounded bg-[var(--hover-bg)] px-1.5 py-0.5 text-right font-mono text-[10px] text-[var(--muted)]">
                      {row.shortcut}
                    </kbd>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--panel-border)] px-5 py-2.5 text-[11px] text-[var(--subtle)]">
          <span>WeavePDF · Local-first PDF editor for macOS</span>
          <span
            className="font-mono tracking-wider text-[var(--muted)]"
            data-testid="app-version"
          >
            {APP_VERSION_DISPLAY}
          </span>
        </div>
      </div>
    </div>
  );
}
