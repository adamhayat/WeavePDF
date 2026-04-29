import { useEffect, useState } from "react";
import { X } from "lucide-react";

// Banner asking the user to set WeavePDF as their default PDF viewer. Shows
// at the top of the main content area on launch IF:
//   - WeavePDF isn't already the default PDF handler (queried via the
//     app:get-default-pdf-app IPC, which shells out to inline Swift)
//   - the user hasn't dismissed it permanently via "Don't show again"
//     (persisted in localStorage["weavepdf-default-prompt-suppressed"])
//
// Three actions:
//   - "Make Default" → calls app:set-as-default-pdf-app, hides the banner
//     on success
//   - "Later" → hides for this session only; re-shows next launch
//   - "Don't show again" → sets the localStorage flag, hides permanently
//
// macOS will pop a system confirmation dialog when changing the default
// handler. That's fine — gives the user a final chance to cancel.

const SUPPRESS_FLAG = "weavepdf-default-prompt-suppressed";

export function DefaultPdfBanner() {
  const [state, setState] = useState<"idle" | "checking" | "show" | "hidden" | "applying">(
    "checking",
  );
  const [error, setError] = useState<string | null>(null);

  // On mount, check if the user has suppressed the prompt + whether
  // WeavePDF is already the default. The default-app check shells out to
  // /usr/bin/swift via IPC, which is a real piece of work. Defer it past
  // first paint via requestIdleCallback so it doesn't compete for the cold-
  // launch critical path. The banner appearing 200 ms later is invisible to
  // the user; freeing those 200 ms during boot is measurable.
  useEffect(() => {
    if (localStorage.getItem(SUPPRESS_FLAG) === "1") {
      setState("hidden");
      return;
    }
    let cancelled = false;
    const runCheck = () => {
      void (async () => {
        try {
          const { isDefault } = await window.weavepdf.getDefaultPdfApp();
          if (cancelled) return;
          setState(isDefault ? "hidden" : "show");
        } catch {
          if (!cancelled) setState("hidden");
        }
      })();
    };
    type IdleWin = Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const w = window as IdleWin;
    let idleId: number | undefined;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    if (typeof w.requestIdleCallback === "function") {
      idleId = w.requestIdleCallback(runCheck, { timeout: 1500 });
    } else {
      timerId = setTimeout(runCheck, 200);
    }
    return () => {
      cancelled = true;
      if (idleId !== undefined && typeof w.cancelIdleCallback === "function") {
        w.cancelIdleCallback(idleId);
      }
      if (timerId !== undefined) clearTimeout(timerId);
    };
  }, []);

  if (state !== "show" && state !== "applying") return null;

  const handleMakeDefault = async () => {
    setState("applying");
    setError(null);
    try {
      const result = await window.weavepdf.setAsDefaultPdfApp();
      if (result.ok) {
        setState("hidden");
      } else {
        setError(result.error ?? "Couldn't set the default app.");
        setState("show");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't set the default app.");
      setState("show");
    }
  };

  const handleLater = () => setState("hidden");

  const handleSuppress = () => {
    try {
      localStorage.setItem(SUPPRESS_FLAG, "1");
    } catch {
      // Ignore quota / private-mode errors; banner just re-appears next launch.
    }
    setState("hidden");
  };

  return (
    <div
      className="flex items-center gap-3 border-b border-[var(--panel-border)] bg-[var(--accent-soft)] px-4 py-2.5"
      data-testid="default-pdf-banner"
      role="status"
    >
      <div className="min-w-0 flex-1 text-[12px] leading-snug text-[var(--app-fg)]">
        <strong className="font-semibold">WeavePDF isn't your default PDF viewer.</strong>{" "}
        <span className="text-[var(--muted)]">
          Set it as default so PDFs open in WeavePDF when you double-click them.
        </span>
        {error && (
          <div className="mt-1 text-[11px] text-[var(--color-destructive)]" data-testid="default-pdf-banner-error">
            {error}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={handleSuppress}
          className="rounded-md px-2.5 py-1 text-[11px] text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]"
          data-testid="default-pdf-banner-suppress"
        >
          Don't show again
        </button>
        <button
          type="button"
          onClick={handleLater}
          className="rounded-md px-2.5 py-1 text-[11px] text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]"
          data-testid="default-pdf-banner-later"
        >
          Later
        </button>
        <button
          type="button"
          onClick={handleMakeDefault}
          disabled={state === "applying"}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1 text-[11px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
          data-testid="default-pdf-banner-make-default"
        >
          {state === "applying" ? "Setting…" : "Make Default"}
        </button>
        <button
          type="button"
          onClick={handleLater}
          className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]"
          aria-label="Dismiss"
        >
          <X className="h-3 w-3" strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}
