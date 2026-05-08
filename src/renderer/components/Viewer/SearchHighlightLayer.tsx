import { useUIStore } from "../../stores/ui";

type Props = {
  pageNumber: number;
  zoom: number;
  pageHeightPx: number;
};

// Paints the yellow ⌘F match highlights on a single page. Reads the global
// match list from the UI store and filters down to this page. The match the
// search cursor is currently on renders in orange so the user can see which
// of the highlights ⌘F just navigated them to.
export function SearchHighlightLayer({
  pageNumber,
  zoom,
  pageHeightPx,
}: Props) {
  const matches = useUIStore((s) => s.searchMatches);
  const cursor = useUIStore((s) => s.searchCursor);
  const pageMatches = matches.filter((m) => m.pageNumber === pageNumber);
  if (pageMatches.length === 0) return null;
  const currentGlobalIndex = matches[cursor]?.globalIndex ?? -1;

  return (
    <div className="pointer-events-none absolute inset-0 z-[30]">
      {pageMatches.map((m) => {
        const isCurrent = m.globalIndex === currentGlobalIndex;
        // PDF Y=0 is at the bottom; convert to CSS top-down origin.
        // extraLeftCssPx is added in CSS-pixel space (zoom-independent) so
        // pending-edit highlights line up with the rendered HTML wrapper
        // padding (px-0.5 = 2 CSS px) regardless of current zoom.
        const left = m.xPt * zoom + (m.extraLeftCssPx ?? 0);
        const top = pageHeightPx - (m.yPt + m.heightPt) * zoom;
        const width = m.widthPt * zoom;
        const height = m.heightPt * zoom;
        return (
          <div
            key={m.globalIndex}
            style={{
              position: "absolute",
              left,
              top,
              width,
              height,
              background: isCurrent ? "rgba(255, 145, 0, 0.55)" : "rgba(255, 230, 0, 0.45)",
              border: isCurrent ? "1px solid rgba(255, 100, 0, 0.85)" : "none",
              borderRadius: 2,
              mixBlendMode: "multiply",
            }}
            data-testid="search-highlight"
            data-current={isCurrent || undefined}
          />
        );
      })}
    </div>
  );
}
