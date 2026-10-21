// V1.0128: geometry for "Full page" at 2/4/6/9 pages per sheet.
// Adam (2026-10-13): "Why wouldn't full page work with multiple sheets? It
// could work here." Full page now trims every printed page's white margins
// to ONE shared content box (the union across pages, so all tiles keep the
// same scale) before the n-up layout, so the content fills its tile.
// Pure — the pixel scan lives in pdf-ops `trimPagesToContentForPrint`.

/** Content box in viewport points, origin at the page's TOP-LEFT (pdf.js
 *  viewport / canvas convention). */
export type ViewBox = { x: number; y: number; w: number; h: number };
/** A PDF box in user space (bottom-left origin), as pdf-lib returns it. */
export type PdfBox = { x: number; y: number; width: number; height: number };

/** Smallest box containing every page's content; null when no page has any. */
export function unionViewBoxes(boxes: Array<ViewBox | null>): ViewBox | null {
  const real = boxes.filter((b): b is ViewBox => !!b && b.w > 0 && b.h > 0);
  if (real.length === 0) return null;
  const x0 = Math.min(...real.map((b) => b.x));
  const y0 = Math.min(...real.map((b) => b.y));
  const x1 = Math.max(...real.map((b) => b.x + b.w));
  const y1 = Math.max(...real.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Map a top-left viewport box onto an UNROTATED page's crop box (pdf.js
 *  renders the crop box, so viewport (0,0) is the crop box's top-left).
 *  Clamped to the crop box. Returns null if nothing usable remains or if the
 *  trim would save less than 1% (not worth rebuilding the page). */
export function viewBoxToPdfBox(v: ViewBox, crop: PdfBox): PdfBox | null {
  const left = Math.max(0, v.x);
  const top = Math.max(0, v.y);
  const right = Math.min(crop.width, v.x + v.w);
  const bottom = Math.min(crop.height, v.y + v.h);
  const width = right - left;
  const height = bottom - top;
  if (width < 10 || height < 10) return null;
  if (width * height > crop.width * crop.height * 0.99) return null;
  return { x: crop.x + left, y: crop.y + crop.height - bottom, width, height };
}
