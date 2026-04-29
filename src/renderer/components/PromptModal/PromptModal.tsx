import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

type Props = {
  open: boolean;
  title: string;
  description?: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  submitLabel?: string;
  allowEmpty?: boolean;
  validate?: (value: string) => string | null;
  onSubmit: (value: string) => void | Promise<void>;
  onClose: () => void;
};

export function PromptModal({
  open,
  title,
  description,
  label,
  initialValue = "",
  placeholder,
  submitLabel = "Apply",
  allowEmpty = false,
  validate,
  onSubmit,
  onClose,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    setError(null);
    setBusy(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, initialValue]);

  if (!open) return null;

  const submit = async () => {
    if (busy) return;
    const trimmed = value.trim();
    if (!allowEmpty && !trimmed) return;
    const nextError = validate?.(trimmed) ?? null;
    if (nextError) {
      setError(nextError);
      return;
    }
    setBusy(true);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      data-testid="prompt-modal"
    >
      <div className="w-[420px] overflow-hidden rounded-2xl border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--panel-border)] px-5 py-3">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)] disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>

        <form
          className="px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {description && (
            <p className="mb-3 text-[12px] leading-relaxed text-[var(--muted)]">
              {description}
            </p>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">
              {label}
            </span>
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              placeholder={placeholder}
              disabled={busy}
              className="h-9 rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-50"
              data-testid="prompt-input"
            />
          </label>

          {error && (
            <p className="mt-2 text-[12px] text-[var(--color-destructive)]" role="alert">
              {error}
            </p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="h-8 rounded-md border border-[var(--panel-border)] px-3 text-[12px] text-[var(--app-fg)] hover:bg-[var(--hover-bg)] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || (!allowEmpty && !value.trim())}
              className="h-8 rounded-md bg-[var(--color-accent)] px-3 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
              data-testid="prompt-submit"
            >
              {busy ? "Applying..." : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
