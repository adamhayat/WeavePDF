import { useEffect, useState } from "react";
import { Link as LinkIcon, X } from "lucide-react";
import { useUIStore } from "../../stores/ui";
import { useDocumentStore } from "../../stores/document";
// Lazy-loaded so the pdf-lib chunk (~425 KB) doesn't pull at boot. The
// import resolves on first link-create click; pdf-lib parses then.
const loadPdfOps = () => import("../../lib/pdf-ops");

/**
 * Renders next to the rectangle a user just dragged with the Link tool.
 * Two tabs: URL (for external links) and Page (intra-document GoTo). Clicking
 * Apply bakes a real /Link annotation into the PDF via pdf-lib so the link
 * survives any export, print, or open in another reader.
 */
export function LinkPopover() {
  const pendingLink = useUIStore((s) => s.pendingLink);
  const setPendingLink = useUIStore((s) => s.setPendingLink);
  const setTool = useUIStore((s) => s.setTool);
  const activeTab = useDocumentStore((s) => s.activeTab());
  const applyEdit = useDocumentStore((s) => s.applyEdit);
  const [tab, setTab] = useState<"url" | "page">("url");
  const [url, setUrl] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (pendingLink) {
      setTab("url");
      setUrl("");
      setError(null);
      setPageNumber(Math.min(activeTab?.numPages ?? 1, pendingLink.page + 1));
    }
  }, [pendingLink, activeTab?.numPages]);

  if (!pendingLink || !activeTab?.bytes) return null;

  const close = () => setPendingLink(null);

  const apply = async () => {
    if (!activeTab.bytes) return;
    setError(null);
    setBusy(true);
    try {
      const normalized = tab === "url" ? normaliseUrl(url) : null;
      if (normalized?.error) {
        setError(normalized.error);
        setBusy(false);
        return;
      }
      const target =
        tab === "url"
          ? { kind: "url" as const, url: normalized?.url ?? "" }
          : { kind: "page" as const, pageNumber };
      if (tab === "url" && !target.url) {
        setBusy(false);
        return;
      }
      const { addLinkAnnotation } = await loadPdfOps();
      const newBytes = await addLinkAnnotation(
        activeTab.bytes,
        pendingLink.page,
        pendingLink.rect,
        target,
      );
      await applyEdit(activeTab.id, newBytes);
      setPendingLink(null);
      // Drop tool back to none so the user doesn't accidentally drag another
      // link rectangle while the popover is closing.
      setTool("none");
    } catch (err) {
      alert(`Couldn't add link: ${(err as Error).message ?? err}`);
    } finally {
      setBusy(false);
    }
  };

  // Clamp into the viewport so the popover never spills off-screen for links
  // dragged near the edge.
  const popWidth = 320;
  const popHeight = 180;
  const left = clamp(pendingLink.screenX - popWidth / 2, 8, window.innerWidth - popWidth - 8);
  const top = clamp(pendingLink.screenY, 8, window.innerHeight - popHeight - 8);

  return (
    <div
      className="fixed inset-0 z-50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="absolute w-[320px] rounded-xl border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] p-3 shadow-2xl"
        style={{ left, top }}
        data-testid="link-popover"
      >
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[12px] font-medium">
            <LinkIcon className="h-3.5 w-3.5 text-[var(--color-accent)]" strokeWidth={1.8} />
            Add link
          </div>
          <button
            type="button"
            onClick={close}
            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover-bg)]"
            aria-label="Close"
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.8} />
          </button>
        </div>
        <div className="mb-2 flex gap-1 rounded-md bg-[var(--hover-bg)] p-0.5">
          <button
            type="button"
            onClick={() => setTab("url")}
            className={`flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
              tab === "url"
                ? "bg-[var(--panel-bg-raised)] text-[var(--app-fg)] shadow-sm"
                : "text-[var(--muted)] hover:text-[var(--app-fg)]"
            }`}
          >
            URL
          </button>
          <button
            type="button"
            onClick={() => setTab("page")}
            className={`flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
              tab === "page"
                ? "bg-[var(--panel-bg-raised)] text-[var(--app-fg)] shadow-sm"
                : "text-[var(--muted)] hover:text-[var(--app-fg)]"
            }`}
          >
            Page
          </button>
        </div>
        {tab === "url" ? (
          <input
            autoFocus
            type="url"
            placeholder="https://…"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void apply();
              if (e.key === "Escape") close();
            }}
            className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--app-bg)] px-2.5 py-1.5 text-[12px] outline-none focus:border-[var(--color-accent)]"
            data-testid="link-url-input"
          />
        ) : (
          <input
            autoFocus
            type="number"
            min={1}
            max={activeTab.numPages}
            value={pageNumber}
            onChange={(e) => setPageNumber(Math.max(1, Math.min(activeTab.numPages, Number(e.target.value) || 1)))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void apply();
              if (e.key === "Escape") close();
            }}
            className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--app-bg)] px-2.5 py-1.5 text-[12px] outline-none focus:border-[var(--color-accent)]"
            data-testid="link-page-input"
          />
        )}
        {error && (
          <p className="mt-2 text-[11px] text-[var(--color-destructive)]" role="alert">
            {error}
          </p>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={close}
            className="h-7 rounded-md border border-[var(--panel-border)] px-2.5 text-[11px] text-[var(--app-fg)] hover:bg-[var(--hover-bg)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={busy || (tab === "url" && !url.trim())}
            className="h-7 rounded-md bg-[var(--color-accent)] px-2.5 text-[11px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
            data-testid="link-apply"
          >
            {busy ? "Adding…" : "Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}

function normaliseUrl(raw: string): { url: string; error: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { url: "", error: null };
  // Bare domains (no protocol) get https:// prepended so the browser doesn't
  // resolve them as a file path or relative URL.
  let candidate = trimmed;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
    // Keep explicit schemes for validation below.
  } else if (candidate.startsWith("//")) {
    candidate = `https:${candidate}`;
  } else if (candidate.startsWith("/")) {
    return { url: "", error: "Use the Page tab for internal document links." };
  } else if (candidate.includes("@") && !candidate.includes(" ")) {
    candidate = `mailto:${candidate}`;
  } else {
    candidate = `https://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) {
      return { url: "", error: "Links can only use http, https, or mailto." };
    }
    if (parsed.protocol === "mailto:" && !parsed.pathname.includes("@")) {
      return { url: "", error: "Enter a valid email address." };
    }
    return { url: parsed.toString(), error: null };
  } catch {
    return { url: "", error: "Enter a valid URL or email address." };
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
