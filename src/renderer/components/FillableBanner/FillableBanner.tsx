import { useEffect, useRef, useState } from "react";
import { FormInput, X } from "lucide-react";
import { useDocumentStore } from "../../stores/document";
import { useUIStore } from "../../stores/ui";

// pdf-ops is a lazy chunk; we don't want to pull it just to detect form fields.
const loadPdfOps = () => import("../../lib/pdf-ops");

// V1.0035 banner: when the active tab is an AcroForm-bearing PDF, show a one-
// line prompt offering to open the FormFillModal. Discovers the existing
// fill-form UX without making the user hunt through the command palette.
//
// Detection runs once per (tab id × version) and caches the result on the
// tab's bytes hash so re-tab-switching doesn't re-scan a doc we've already
// inspected. A "Don't suggest forms again" suppression is stored in
// localStorage so users who never want this banner can mute it.
//
// "Fill form…" → opens the FormFillModal (lists fields + lets the user
// type values + writes them back into the PDF on save).

const SUPPRESS_FLAG = "weavepdf-fillable-banner-suppressed";
// Per-tab dismissals — survive tab switches but not re-opens (the user might
// want the prompt back if they re-open the doc fresh).
const dismissedKeys = new Set<string>();

type Status =
  | { kind: "hidden" }
  | { kind: "checking" }
  | { kind: "show"; fieldCount: number }
  | { kind: "muted" };

export function FillableBanner() {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const openFormFill = useUIStore((s) => s.openFormFill);
  const [status, setStatus] = useState<Status>({ kind: "hidden" });
  // Cache "this tab id has been checked at this version" so we don't re-run
  // getFormFields on every render.
  const checkedRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!activeTab?.bytes) {
      setStatus({ kind: "hidden" });
      return;
    }
    if (localStorage.getItem(SUPPRESS_FLAG) === "1") {
      setStatus({ kind: "muted" });
      return;
    }
    if (dismissedKeys.has(activeTab.draftKey)) {
      setStatus({ kind: "hidden" });
      return;
    }
    // Skip if we already checked this tab at this version.
    const prev = checkedRef.current.get(activeTab.id);
    if (prev === activeTab.version) return;

    let cancelled = false;
    setStatus({ kind: "checking" });
    void (async () => {
      try {
        const { getFormFields } = await loadPdfOps();
        const fields = await getFormFields(activeTab.bytes!);
        if (cancelled) return;
        checkedRef.current.set(activeTab.id, activeTab.version);
        if (fields.length > 0) {
          setStatus({ kind: "show", fieldCount: fields.length });
        } else {
          setStatus({ kind: "hidden" });
        }
      } catch {
        if (!cancelled) setStatus({ kind: "hidden" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab?.id, activeTab?.bytes, activeTab?.version, activeTab?.draftKey]);

  if (status.kind !== "show") return null;
  const draftKey = activeTab?.draftKey;

  const handleFill = () => {
    openFormFill();
  };
  const handleDismiss = () => {
    if (draftKey) dismissedKeys.add(draftKey);
    setStatus({ kind: "hidden" });
  };
  const handleSuppress = () => {
    try {
      localStorage.setItem(SUPPRESS_FLAG, "1");
    } catch {
      // ignore quota issues
    }
    setStatus({ kind: "muted" });
  };

  return (
    <div
      className="flex items-center gap-3 border-b border-[var(--panel-border)] bg-[var(--accent-soft)] px-4 py-2.5"
      data-testid="fillable-banner"
      role="status"
    >
      <FormInput
        className="h-4 w-4 shrink-0 text-[var(--color-accent)]"
        strokeWidth={1.8}
      />
      <div className="min-w-0 flex-1 text-[12px] leading-snug text-[var(--app-fg)]">
        <strong className="font-semibold">This is a fillable PDF.</strong>{" "}
        <span className="text-[var(--muted)]">
          {status.fieldCount === 1
            ? "1 form field detected. "
            : `${status.fieldCount} form fields detected. `}
          Click "Fill form" to enter values.
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={handleSuppress}
          className="rounded-md px-2.5 py-1 text-[11px] text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]"
          data-testid="fillable-banner-suppress"
        >
          Don't suggest again
        </button>
        <button
          type="button"
          onClick={handleFill}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1 text-[11px] font-medium text-white hover:bg-[var(--color-accent-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:ring-offset-[var(--panel-bg-raised)]"
          data-testid="fillable-banner-fill"
        >
          Fill form
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]"
          aria-label="Dismiss"
          data-testid="fillable-banner-dismiss"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}
