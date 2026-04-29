import { useEffect, useRef, useState } from "react";
import { Search, X, ChevronUp, ChevronDown, Replace } from "lucide-react";
import { useDocumentStore } from "../../stores/document";
import { useUIStore } from "../../stores/ui";
import { cn } from "../../lib/cn";
// Lazy-loaded so the pdf-lib chunk doesn't pull at boot. Replace is a
// heavy edit op that only runs on click; the chunk parses then.
const loadPdfOps = () => import("../../lib/pdf-ops");

type Match = { pageNumber: number; matchIndex: number; matchCount: number };

export function SearchBar() {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const applyEdit = useDocumentStore((s) => s.applyEdit);
  const setCurrentPage = useDocumentStore((s) => s.setCurrentPage);
  const query = useUIStore((s) => s.searchQuery);
  const setQuery = useUIStore((s) => s.setSearchQuery);
  const closeSearch = useUIStore((s) => s.closeSearch);

  const inputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const [matches, setMatches] = useState<Match[]>([]);
  const [cursor, setCursor] = useState(0);
  const [searching, setSearching] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [replaceResult, setReplaceResult] = useState<number | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Naive search: walk every page's text content, collect matches.
  // Phase 0 quality — good enough for short/mid docs; will upgrade to
  // incremental streaming in Phase 4 if we see perf issues on 300+ pg PDFs.
  useEffect(() => {
    if (!activeTab?.pdf || !query.trim()) {
      setMatches([]);
      setCursor(0);
      return;
    }
    const pdf = activeTab.pdf;
    const q = query.toLowerCase();
    let cancelled = false;
    setSearching(true);

    (async () => {
      const all: Match[] = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        if (cancelled) return;
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        const text = content.items
          .map((i) => ("str" in i ? i.str : ""))
          .join(" ")
          .toLowerCase();
        let from = 0;
        let count = 0;
        while (true) {
          const idx = text.indexOf(q, from);
          if (idx === -1) break;
          count++;
          from = idx + q.length;
        }
        for (let i = 0; i < count; i++) {
          all.push({ pageNumber: p, matchIndex: i, matchCount: count });
        }
      }
      if (cancelled) return;
      setMatches(all);
      setCursor(0);
      setSearching(false);
      if (all.length > 0 && activeTab) {
        setCurrentPage(activeTab.id, all[0].pageNumber);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [query, activeTab?.id, activeTab?.pdf]);

  const goto = (next: number) => {
    if (matches.length === 0) return;
    const wrapped = (next + matches.length) % matches.length;
    setCursor(wrapped);
    if (activeTab) setCurrentPage(activeTab.id, matches[wrapped].pageNumber);
  };

  const replaceAll = async () => {
    if (!activeTab?.bytes || !query.trim() || replacing) return;
    setReplacing(true);
    setReplaceResult(null);
    try {
      // Commit pending text/image edits first so they're included in the
      // search space (otherwise adding a Pending text containing the query
      // would be ignored, then baked unchanged on save).
      await useDocumentStore.getState().commitAllPending(activeTab.id);
      const fresh = useDocumentStore.getState().tabs.find((t) => t.id === activeTab.id);
      if (!fresh?.bytes) return;
      const { replaceAllText } = await loadPdfOps();
      const r = await replaceAllText(fresh.bytes, query, replacement);
      await applyEdit(fresh.id, r.bytes);
      setReplaceResult(r.replaced);
    } catch (err) {
      alert(`Replace failed: ${(err as Error).message ?? err}`);
    } finally {
      setReplacing(false);
    }
  };

  return (
    <div className="absolute right-6 top-4 z-20 flex flex-col gap-1 rounded-lg border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] p-1 shadow-lg backdrop-blur">
      <div className="flex items-center gap-1">
      <div className="flex h-8 items-center gap-2 rounded-md px-2">
        <Search className="h-3.5 w-3.5 text-[var(--muted)]" strokeWidth={2} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              goto(e.shiftKey ? cursor - 1 : cursor + 1);
            } else if (e.key === "Escape") {
              closeSearch();
            }
          }}
          placeholder="Find in document"
          className="w-[240px] bg-transparent text-[13px] text-[var(--app-fg)] placeholder:text-[var(--subtle)] focus:outline-none"
        />
        <span
          className={cn(
            "tnum shrink-0 text-[11px]",
            matches.length === 0 ? "text-[var(--subtle)]" : "text-[var(--muted)]",
          )}
        >
          {searching
            ? "…"
            : matches.length === 0
              ? query.trim()
                ? "No results"
                : ""
              : `${cursor + 1} of ${matches.length}`}
        </span>
      </div>
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => goto(cursor - 1)}
          disabled={matches.length === 0}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)] disabled:opacity-40"
          aria-label="Previous match"
          title="Previous match  ⇧⏎"
        >
          <ChevronUp className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={() => goto(cursor + 1)}
          disabled={matches.length === 0}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)] disabled:opacity-40"
          aria-label="Next match"
          title="Next match  ⏎"
        >
          <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={() => setReplaceOpen(!replaceOpen)}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
            replaceOpen
              ? "bg-[var(--hover-bg)] text-[var(--app-fg)]"
              : "text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]",
          )}
          aria-label="Toggle replace"
          title="Find + Replace"
          data-testid="toggle-replace"
        >
          <Replace className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={closeSearch}
          className="ml-1 flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]"
          aria-label="Close search"
          title="Close  Esc"
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>
      </div>
      {replaceOpen && (
        <div className="flex items-center gap-1 border-t border-[var(--panel-border)] pt-1">
          <div className="flex h-8 flex-1 items-center gap-2 rounded-md px-2">
            <Replace className="h-3.5 w-3.5 text-[var(--muted)]" strokeWidth={2} />
            <input
              ref={replaceInputRef}
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  void replaceAll();
                } else if (e.key === "Escape") {
                  closeSearch();
                }
              }}
              placeholder="Replace with…"
              className="w-[200px] bg-transparent text-[13px] text-[var(--app-fg)] placeholder:text-[var(--subtle)] focus:outline-none"
              data-testid="replace-input"
            />
            {replaceResult !== null && (
              <span className="tnum shrink-0 text-[11px] text-[var(--color-success)]">
                {replaceResult} replaced
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => void replaceAll()}
            disabled={!query.trim() || matches.length === 0 || replacing}
            className="h-7 rounded-md bg-[var(--color-accent)] px-2 text-[11px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
            data-testid="replace-all"
          >
            {replacing ? "…" : `Replace all`}
          </button>
        </div>
      )}
    </div>
  );
}
