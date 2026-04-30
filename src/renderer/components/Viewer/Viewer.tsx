import { useEffect, useMemo, useRef } from "react";
import { useDocumentStore } from "../../stores/document";
import { useUIStore } from "../../stores/ui";
import { PageCanvas } from "./PageCanvas";

export function Viewer() {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const setCurrentPage = useDocumentStore((s) => s.setCurrentPage);
  const viewMode = useUIStore((s) => s.viewMode);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // During smooth scroll triggered by programmatic nav (search, thumbnail click),
  // the IntersectionObserver sees the old page still partially visible and would
  // race-override currentPage. Suppress observer updates while this flag is true.
  const suppressObserverRef = useRef(false);

  // Scroll to the current page when it changes externally (e.g., sidebar click, search).
  useEffect(() => {
    if (!activeTab) return;
    const el = pageRefs.current.get(activeTab.currentPage);
    if (el && scrollerRef.current) {
      const container = scrollerRef.current;
      const target = el.offsetTop - 24;
      suppressObserverRef.current = true;
      container.scrollTo({ top: target, behavior: "smooth" });
      // Smooth scroll is ~400–600ms; clear the flag a bit longer than that
      // so the observer can resume tracking once the new page has settled.
      const t = window.setTimeout(() => {
        suppressObserverRef.current = false;
      }, 700);
      return () => window.clearTimeout(t);
    }
  }, [activeTab?.currentPage, activeTab?.id]);

  // Reading-order copy: pdf.js lays text spans out in content-stream order,
  // which for multi-column or form-style layouts often runs column-by-column
  // (label column, then value column) instead of left-to-right across each
  // row. Override the clipboard payload with spans sorted by their visual
  // bounding box — y first (grouped into lines by tolerance), x within line.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onCopy = (e: ClipboardEvent) => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      // Only override inside a pdf.js text layer. Otherwise let the
      // default copy (e.g. typing into an input) behave normally.
      const anchor = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement ?? null;
      const insideTextLayer = anchor?.closest(".textLayer");
      if (!insideTextLayer) return;

      const spans: Array<{ text: string; x: number; y: number; h: number }> = [];
      // Collect every text-layer span that any selection range touches.
      const allSpans = scroller.querySelectorAll<HTMLElement>(".textLayer span");
      const firstRange = sel.getRangeAt(0);
      for (const span of allSpans) {
        if (!firstRange.intersectsNode(span)) continue;
        const text = span.textContent ?? "";
        if (!text.trim()) continue;
        const rect = span.getBoundingClientRect();
        spans.push({ text, x: rect.left, y: rect.top, h: rect.height });
      }
      if (spans.length === 0) return;

      // Group into lines using half the median height as tolerance — tight
      // enough to separate adjacent lines, loose enough to forgive baseline
      // jitter inside a single run.
      const avgH = spans.reduce((acc, s) => acc + s.h, 0) / spans.length;
      const tolerance = Math.max(2, avgH * 0.5);
      type Line = { y: number; spans: typeof spans };
      const lines: Line[] = [];
      for (const s of spans.sort((a, b) => a.y - b.y)) {
        const line = lines.find((l) => Math.abs(l.y - s.y) < tolerance);
        if (line) line.spans.push(s);
        else lines.push({ y: s.y, spans: [s] });
      }
      lines.sort((a, b) => a.y - b.y);
      const text = lines
        .map((line) =>
          line.spans
            .sort((a, b) => a.x - b.x)
            .map((s) => s.text)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim(),
        )
        .filter(Boolean)
        .join("\n");
      if (!text) return;
      e.clipboardData?.setData("text/plain", text);
      e.preventDefault();
    };
    scroller.addEventListener("copy", onCopy);
    return () => scroller.removeEventListener("copy", onCopy);
  }, []);

  // Track which page is most visible and update currentPage.
  useEffect(() => {
    if (!activeTab?.pdf || !scrollerRef.current) return;
    const root = scrollerRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        if (suppressObserverRef.current) return;
        let bestPage = activeTab.currentPage;
        let bestRatio = 0;
        for (const entry of entries) {
          if (entry.intersectionRatio > bestRatio) {
            bestRatio = entry.intersectionRatio;
            const n = Number(entry.target.getAttribute("data-page"));
            if (n) bestPage = n;
          }
        }
        if (bestRatio > 0.25 && bestPage !== activeTab.currentPage) {
          setCurrentPage(activeTab.id, bestPage);
        }
      },
      { root, threshold: [0.1, 0.25, 0.5, 0.75, 1.0] },
    );
    pageRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [activeTab?.id, activeTab?.numPages, activeTab?.pdf]);

  // Group pages into rows according to viewMode:
  //   single        — one page per row
  //   spread        — pages 1+2, 3+4, 5+6, …
  //   cover-spread  — page 1 alone, then 2+3, 4+5, … (book layout)
  const rows = useMemo<number[][]>(() => {
    if (!activeTab) return [];
    const total = activeTab.numPages;
    if (viewMode === "single") {
      return Array.from({ length: total }, (_, i) => [i + 1]);
    }
    const out: number[][] = [];
    if (viewMode === "cover-spread") {
      out.push([1]);
      for (let i = 2; i <= total; i += 2) {
        out.push(i + 1 <= total ? [i, i + 1] : [i]);
      }
      return out;
    }
    // spread
    for (let i = 1; i <= total; i += 2) {
      out.push(i + 1 <= total ? [i, i + 1] : [i]);
    }
    return out;
  }, [activeTab, viewMode]);

  if (!activeTab?.pdf) return null;

  return (
    <div
      ref={scrollerRef}
      className="acr-scroll relative flex-1 overflow-auto bg-[var(--app-bg)]"
    >
      <div className="mx-auto flex w-fit flex-col items-center gap-6 px-10 py-8">
        {rows.map((pages, rowIdx) => (
          <div
            key={`row-${activeTab.id}-${rowIdx}`}
            className={pages.length === 2 ? "flex flex-row items-start gap-3" : ""}
          >
            {pages.map((p) => (
              <PageCanvas
                // V1.0039: key MUST be stable across applyEdit. Earlier we
                // included `activeTab.version` to "force a fresh canvas after
                // edits", but PageCanvas already re-runs its render effect on
                // every `pdf` prop change (deps include `pdf`), so the canvas
                // refreshes without remounting. Keying on version was making
                // every applyEdit unmount + remount the entire page subtree —
                // including AcroFormLayer's <input>s, which is why typing into
                // form field A and pressing Tab to field B caused field B to
                // miss the next keystrokes (the input element didn't exist
                // yet at that moment).
                key={`${activeTab.id}-${p}`}
                ref={(el) => {
                  if (el) pageRefs.current.set(p, el);
                  else pageRefs.current.delete(p);
                }}
                pdf={activeTab.pdf!}
                pageNumber={p}
                zoom={activeTab.zoom}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
