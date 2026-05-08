import { useEffect, useRef, useState } from "react";
import { Search, X, ChevronUp, ChevronDown, Replace } from "lucide-react";
import { useDocumentStore } from "../../stores/document";
import { useUIStore, type SearchMatch } from "../../stores/ui";
import { cn } from "../../lib/cn";
// Lazy-loaded so the pdf-lib chunk doesn't pull at boot. Replace is a
// heavy edit op that only runs on click; the chunk parses then.
const loadPdfOps = () => import("../../lib/pdf-ops");

export function SearchBar() {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const applyEdit = useDocumentStore((s) => s.applyEdit);
  const setCurrentPage = useDocumentStore((s) => s.setCurrentPage);
  const query = useUIStore((s) => s.searchQuery);
  const setQuery = useUIStore((s) => s.setSearchQuery);
  const closeSearch = useUIStore((s) => s.closeSearch);
  const matches = useUIStore((s) => s.searchMatches);
  const cursor = useUIStore((s) => s.searchCursor);
  const setSearchResults = useUIStore((s) => s.setSearchResults);
  const setSearchCursor = useUIStore((s) => s.setSearchCursor);

  const inputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const [searching, setSearching] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [replaceResult, setReplaceResult] = useState<number | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Walk every page's text content, locate the query in each text item, and
  // compute its bounding rectangle in PDF point space. The rects feed into
  // SearchHighlightLayer (mounted under each PageCanvas) which paints the
  // yellow highlights. Single-item matching only — queries that span across
  // pdf.js text items are uncommon enough to defer.
  useEffect(() => {
    if (!activeTab?.pdf || !query.trim()) {
      setSearchResults([], 0);
      return;
    }
    const pdf = activeTab.pdf;
    const q = query.toLowerCase();
    let cancelled = false;
    setSearching(true);

    (async () => {
      const all: SearchMatch[] = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        if (cancelled) return;
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        for (const raw of content.items) {
          if (!("str" in raw)) continue;
          const item = raw as {
            str: string;
            transform: number[];
            width: number;
            height?: number;
          };
          const str = item.str;
          if (!str) continue;
          const lower = str.toLowerCase();
          let from = 0;
          while (true) {
            const idx = lower.indexOf(q, from);
            if (idx === -1) break;
            // Item is positioned by transform [a, b, c, d, e, f]; (e, f) is
            // the baseline origin in PDF user space. Font size approximates
            // to abs(d) (vertical scale of the transform). item.width is the
            // horizontal advance of str at that scale.
            const fontSize = Math.abs(item.transform[3] || item.transform[0]) || 12;
            const baselineX = item.transform[4];
            const baselineY = item.transform[5];
            const charWidth = item.width / Math.max(1, str.length);
            const matchX = baselineX + idx * charWidth;
            const matchWidth = q.length * charWidth;
            // Visible glyph extent runs from ~descent (15% below baseline)
            // up to ~ascent (85% above). A rect of [baseline-0.15*fs, fs*1.0]
            // covers the line cleanly without overlapping the next row.
            const rectY = baselineY - 0.15 * fontSize;
            all.push({
              globalIndex: all.length,
              pageNumber: p,
              xPt: matchX,
              yPt: rectY,
              widthPt: matchWidth,
              heightPt: fontSize,
            });
            from = idx + q.length;
          }
        }
      }
      // V1.0048: also search uncommitted pending text edits — Edit Text
      // overlays + Add Text overlays — so `1019` is findable as soon as the
      // user types it, before they save. Without this pass, ⌘F looked
      // broken on freshly-edited text because it only searches the baked
      // PDF bytes pdf.js parsed at open time.
      // V1.0049: width comes from canvas measureText (1 pt = 1 CSS px in the
      // canvas font shorthand) so the highlight rect matches the rendered
      // glyph extent instead of a 0.55 average that under-covered short
      // capital-letter words like `PIN`.
      const measureCanvas = document.createElement("canvas");
      const measureCtx = measureCanvas.getContext("2d");
      for (const edit of activeTab.pendingTextEdits) {
        if (!edit.text) continue;
        const lower = edit.text.toLowerCase();
        if (measureCtx) {
          measureCtx.font = `${edit.size}px Helvetica, sans-serif`;
        }
        let from = 0;
        while (true) {
          const idx = lower.indexOf(q, from);
          if (idx === -1) break;
          let matchX = edit.xPt;
          let matchWidth = q.length * edit.size * 0.55;
          if (measureCtx) {
            const beforeWidth = measureCtx.measureText(edit.text.slice(0, idx)).width;
            const matchTextWidth = measureCtx.measureText(edit.text.slice(idx, idx + q.length)).width;
            matchX = edit.xPt + beforeWidth;
            matchWidth = matchTextWidth;
          }
          const rectY = edit.yPt - 0.15 * edit.size;
          all.push({
            globalIndex: all.length,
            pageNumber: edit.page,
            xPt: matchX,
            yPt: rectY,
            widthPt: matchWidth,
            heightPt: edit.size,
            // PendingTextLayer wraps rendered text in a div with px-0.5
            // (2 CSS pixels) horizontal padding for the hover/selection
            // ring. The visible text sits 2 px right of edit.xPt * zoom;
            // SearchHighlightLayer adds this offset back at render time.
            extraLeftCssPx: 2,
          });
          from = idx + q.length;
        }
      }
      if (cancelled) return;
      setSearchResults(all, 0);
      setSearching(false);
      if (all.length > 0 && activeTab) {
        setCurrentPage(activeTab.id, all[0].pageNumber);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    query,
    activeTab?.id,
    activeTab?.pdf,
    // Re-run when pending edits change so newly-typed text is searchable
    // immediately. Adding/removing/replacing the array swaps its reference;
    // editing a property of the same tab leaves the array reference intact.
    activeTab?.pendingTextEdits,
    setSearchResults,
    setCurrentPage,
  ]);

  const goto = (next: number) => {
    if (matches.length === 0) return;
    const wrapped = (next + matches.length) % matches.length;
    setSearchCursor(wrapped);
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
