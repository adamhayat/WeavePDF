/**
 * V1.0132: one page-step rule for every "next / previous page" key
 * (↑ ↓ ← → PageUp PageDown and the View menu items).
 *
 * Returns the page to land on, clamped to the document, and whether the
 * sidebar's selection should move with it. The selection follows only when
 * exactly one page is selected — the normal state after clicking a thumbnail —
 * so the highlight tracks the page you're on. A multi-page selection (built
 * with ⌘/⇧-click for a delete or rotate) is never disturbed by browsing, and
 * an empty selection stays empty.
 */
export function pageStep(
  currentPage: number,
  numPages: number,
  selectedCount: number,
  delta: 1 | -1,
): { page: number; moveSelection: boolean } {
  const page = Math.max(1, Math.min(numPages, currentPage + delta));
  return { page, moveSelection: selectedCount === 1 };
}
