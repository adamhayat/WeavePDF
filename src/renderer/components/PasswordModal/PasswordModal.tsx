import { useEffect, useRef, useState } from "react";
import { Lock, X } from "lucide-react";

type Props = {
  open: boolean;
  fileName: string;
  onSubmit: (password: string) => Promise<void>;
  onCancel: () => void;
  error: string | null;
  busy: boolean;
  /** "unlock" = reading encrypted PDF, "encrypt" = setting a new password. */
  mode?: "unlock" | "encrypt";
};

/**
 * Password prompt for encrypted PDFs. Shown by App.tsx when a PDF load throws
 * a password error. Submit calls qpdf.decrypt via IPC.
 */
export function PasswordModal({ open, fileName, onSubmit, onCancel, error, busy, mode = "unlock" }: Props) {
  const isEncrypt = mode === "encrypt";
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setPassword("");
      setConfirmPassword("");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    if (!password || busy) return;
    if (isEncrypt && password !== confirmPassword) return;
    await onSubmit(password);
  };

  const confirmError =
    isEncrypt && confirmPassword.length > 0 && password !== confirmPassword
      ? "Passwords don't match."
      : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
      data-testid="password-modal"
    >
      <div className="w-[420px] overflow-hidden rounded-2xl border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--panel-border)] px-5 py-3">
          <div className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.8} />
            <h2 className="text-[15px] font-semibold">
              {isEncrypt ? "Set a password" : "Password required"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)] disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="px-5 py-4"
        >
          <p className="mb-3 text-[13px] text-[var(--app-fg)]">
            {isEncrypt ? (
              <>Set a password to encrypt <span className="font-medium">{fileName}</span>.</>
            ) : (
              <><span className="font-medium">{fileName}</span> is password-protected.</>
            )}
          </p>
          <p className="mb-3 text-[11px] text-[var(--muted)]">
            {isEncrypt
              ? "Encryption runs locally via qpdf (AES-256). The password never leaves your Mac."
              : "The password is used to decrypt the PDF on-device via qpdf. It never leaves your Mac."}
          </p>
          <input
            ref={inputRef}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            placeholder="Password"
            autoComplete="off"
            className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-2 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-50"
            data-testid="password-input"
          />
          {isEncrypt && (
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={busy}
              placeholder="Confirm password"
              autoComplete="off"
              className="mt-2 w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-2 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-50"
              data-testid="password-confirm-input"
            />
          )}
          {confirmError && (
            <p className="mt-2 text-[12px] text-[var(--color-destructive)]">{confirmError}</p>
          )}
          {error && (
            <p className="mt-2 text-[12px] text-[var(--color-destructive)]">{error}</p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="h-8 rounded-md border border-[var(--panel-border)] px-3 text-[12px] text-[var(--app-fg)] hover:bg-[var(--hover-bg)] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !password || (isEncrypt && (!confirmPassword || password !== confirmPassword))}
              className="h-8 rounded-md bg-[var(--color-accent)] px-3 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
              data-testid="password-submit"
            >
              {busy
                ? isEncrypt
                  ? "Encrypting…"
                  : "Unlocking…"
                : isEncrypt
                  ? "Encrypt"
                  : "Unlock"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
