/**
 * V1.0125: one stacking order for every pending element on a page.
 *
 * Before this, the screen and the saved file each had their own (different)
 * hard-coded order: the viewer painted text, then images, then shapes (so a
 * whiteout always sat above every text box — new text typed "on top" of a
 * whiteout was invisible), while the bake drew shapes, then images, then text
 * (so text the user had whited out came BACK in the saved file). Adam's
 * Scotiabank form shipped with "Condo / 485,000 / 2026/10/08" visible in
 * Preview that he had whited out in WeavePDF.
 *
 * Now every element carries a `z`. New elements get the next global sequence
 * number (so they land on top), the context menu's Arrange items rewrite it,
 * and BOTH the viewer (CSS z-index) and the bake (draw order) read the same
 * `orderLayers` result. The two can no longer disagree.
 *
 * Pure functions only — no store, no DOM — so they're unit-testable.
 */

export type LayerKind = "text" | "image" | "shape";

/** The fields this module needs from a pending edit. */
export type Layerable = { id: string; page: number; z?: number; createdAt?: number };

export type LayerEntry<T extends Layerable = Layerable> = {
  kind: LayerKind;
  edit: T;
};

export type LayerArrays<TT extends Layerable, TI extends Layerable, TS extends Layerable> = {
  text: TT[];
  image: TI[];
  shape: TS[];
};

/** Tie-break when two elements share a z (only legacy data can): keep the
 *  pre-V1.0125 BAKE order (shape < image < text), because that is what such a
 *  file actually shows on its pages. */
const KIND_RANK: Record<LayerKind, number> = { shape: 0, image: 1, text: 2 };

export function effectiveZ(edit: Layerable): number {
  if (typeof edit.z === "number" && Number.isFinite(edit.z)) return edit.z;
  if (typeof edit.createdAt === "number" && Number.isFinite(edit.createdAt)) return edit.createdAt;
  return 0;
}

/**
 * Every pending element (optionally only one page's), bottom-most first.
 * This is the single source of truth for both paint order and bake order.
 */
export function orderLayers<TT extends Layerable, TI extends Layerable, TS extends Layerable>(
  arrays: LayerArrays<TT, TI, TS>,
  page?: number,
): Array<LayerEntry<TT> & { kind: "text" } | LayerEntry<TI> & { kind: "image" } | LayerEntry<TS> & { kind: "shape" }> {
  type Out = LayerEntry<TT> & { kind: "text" } | LayerEntry<TI> & { kind: "image" } | LayerEntry<TS> & { kind: "shape" };
  const all: Array<{ entry: Out; index: number }> = [];
  let i = 0;
  for (const edit of arrays.shape) if (page == null || edit.page === page) all.push({ entry: { kind: "shape", edit }, index: i++ });
  for (const edit of arrays.image) if (page == null || edit.page === page) all.push({ entry: { kind: "image", edit }, index: i++ });
  for (const edit of arrays.text) if (page == null || edit.page === page) all.push({ entry: { kind: "text", edit }, index: i++ });
  all.sort((a, b) => {
    const dz = effectiveZ(a.entry.edit) - effectiveZ(b.entry.edit);
    if (dz !== 0) return dz;
    const dk = KIND_RANK[a.entry.kind] - KIND_RANK[b.entry.kind];
    if (dk !== 0) return dk;
    return a.index - b.index;
  });
  return all.map((x) => x.entry);
}

/** id → 1-based stacking rank on one page (1 = bottom). Used as the CSS
 *  z-index inside the page's pending-element stacking context. */
export function layerRanks(arrays: LayerArrays<Layerable, Layerable, Layerable>, page: number): Map<string, number> {
  const ranks = new Map<string, number>();
  orderLayers(arrays, page).forEach((entry, i) => ranks.set(entry.edit.id, i + 1));
  return ranks;
}

/** Bake order for a whole document: by page, then bottom-most first. Page
 *  order doesn't affect the result (pages are independent) but keeps each
 *  page's draws contiguous. */
export function bakeOrder<TT extends Layerable, TI extends Layerable, TS extends Layerable>(
  arrays: LayerArrays<TT, TI, TS>,
) {
  const pages = new Set<number>();
  for (const e of [...arrays.text, ...arrays.image, ...arrays.shape]) pages.add(e.page);
  return [...pages].sort((a, b) => a - b).flatMap((p) => orderLayers(arrays, p));
}

export type LayerOp = "front" | "forward" | "backward" | "back";

/**
 * New z values for an Arrange command. Returns id → z for every element whose
 * z must change (empty when the move is a no-op, e.g. "forward" on the top
 * element). `topZ` must be a fresh value above every existing z (the store
 * passes its next global sequence number) so "Bring to Front" also stays
 * below anything created later.
 */
export function computeLayerMove(
  arrays: LayerArrays<Layerable, Layerable, Layerable>,
  id: string,
  op: LayerOp,
  topZ: number,
): Map<string, number> {
  const out = new Map<string, number>();
  const target = [...arrays.text, ...arrays.image, ...arrays.shape].find((e) => e.id === id);
  if (!target) return out;
  const order = orderLayers(arrays, target.page).map((e) => e.edit);
  const idx = order.findIndex((e) => e.id === id);
  if (idx < 0) return out;
  const last = order.length - 1;

  if (op === "front") {
    if (idx === last) return out;
    out.set(id, Math.max(topZ, effectiveZ(order[last]) + 1));
    return out;
  }
  if (op === "back") {
    if (idx === 0) return out;
    out.set(id, effectiveZ(order[0]) - 1);
    return out;
  }
  const otherIdx = op === "forward" ? idx + 1 : idx - 1;
  if (otherIdx < 0 || otherIdx > last) return out;
  // Swap positions. Rewrite the whole page with distinct consecutive z's so
  // a swap is well-defined even when legacy data has ties.
  const swapped = [...order];
  [swapped[idx], swapped[otherIdx]] = [swapped[otherIdx], swapped[idx]];
  const base = effectiveZ(order[0]);
  swapped.forEach((e, i) => {
    const z = base + i;
    if (effectiveZ(e) !== z || e.z == null) out.set(e.id, z);
  });
  return out;
}

/** Which Arrange commands would change anything (to grey out the rest). */
export function availableLayerMoves(
  arrays: LayerArrays<Layerable, Layerable, Layerable>,
  id: string,
): { up: boolean; down: boolean } {
  const target = [...arrays.text, ...arrays.image, ...arrays.shape].find((e) => e.id === id);
  if (!target) return { up: false, down: false };
  const order = orderLayers(arrays, target.page);
  const idx = order.findIndex((e) => e.edit.id === id);
  return { up: idx >= 0 && idx < order.length - 1, down: idx > 0 };
}

/**
 * Restore-time z assignment for elements read back from a saved file's
 * WeavePDF metadata. Files saved by V1.0125+ carry `z` on every element, so
 * their order is reproduced exactly. Older files carry none — and their pages
 * were baked shapes → images → text — so they are restored in THAT order,
 * which is what the file really shows. Restoring them in any other order
 * would make the screen disagree with the file the moment it is reopened.
 *
 * Returns z values 1..n (bottom first) in the input arrays' own shape.
 */
export function restoreZ(meta: {
  text: Array<{ z?: number }>;
  image: Array<{ z?: number }>;
  shape: Array<{ z?: number }>;
}): { text: number[]; image: number[]; shape: number[] } {
  const all = [...meta.text, ...meta.image, ...meta.shape];
  const allHaveZ = all.length > 0 && all.every((e) => typeof e.z === "number" && Number.isFinite(e.z));
  type Item = { kind: LayerKind; index: number; key: number };
  const items: Item[] = [];
  let legacy = 0;
  // Legacy order: shapes, then images, then text — the old bake order.
  meta.shape.forEach((e, index) => items.push({ kind: "shape", index, key: allHaveZ ? (e.z as number) : legacy++ }));
  meta.image.forEach((e, index) => items.push({ kind: "image", index, key: allHaveZ ? (e.z as number) : legacy++ }));
  meta.text.forEach((e, index) => items.push({ kind: "text", index, key: allHaveZ ? (e.z as number) : legacy++ }));
  const sorted = [...items].sort((a, b) => a.key - b.key || KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.index - b.index);
  const out = {
    text: new Array<number>(meta.text.length),
    image: new Array<number>(meta.image.length),
    shape: new Array<number>(meta.shape.length),
  };
  sorted.forEach((it, i) => {
    out[it.kind][it.index] = i + 1;
  });
  return out;
}

// ─── Buried elements ────────────────────────────────────────────────────

type Box = { x: number; y: number; w: number; h: number };

/** Loose PDF-space bounding box of a pending element, from its stored fields
 *  only (no DOM). Text width is estimated unless the edit carries the bake
 *  bbox (`whiteout`), which restored / Edit-Text boxes always do. */
export function approxBox(kind: LayerKind, e: Record<string, unknown>): Box | null {
  const n = (k: string) => (typeof e[k] === "number" ? (e[k] as number) : NaN);
  if (kind === "text") {
    const wo = e.whiteout as { x: number; y: number; width: number; height: number } | undefined;
    if (wo) return { x: wo.x, y: wo.y, w: wo.width, h: wo.height };
    const size = n("size") || 12;
    const lines = String(e.text ?? "").split("\n");
    const longest = Math.max(1, ...lines.map((l) => l.length));
    const w = Number.isFinite(n("widthPt")) ? n("widthPt") : longest * size * 0.55;
    const top = n("yPt") + size * 0.85;
    const bottom = n("yPt") - (lines.length - 1) * size * 1.2 - size * 0.3;
    return { x: n("xPt"), y: bottom, w, h: top - bottom };
  }
  if (kind === "image") return { x: n("xPt"), y: n("yPt"), w: n("widthPt"), h: n("heightPt") };
  switch (e.kind) {
    case "line":
    case "arrow": {
      const x = Math.min(n("fromX"), n("toX"));
      const y = Math.min(n("fromY"), n("toY"));
      return { x, y, w: Math.abs(n("toX") - n("fromX")), h: Math.abs(n("toY") - n("fromY")) };
    }
    case "freehand": {
      const pts = (e.points as Array<{ x: number; y: number }>) ?? [];
      if (pts.length === 0) return null;
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    case "sticky":
      return { x: n("xPt"), y: n("yPt") - 20, w: 20, h: 20 };
    default:
      return { x: n("xPt"), y: n("yPt"), w: n("widthPt"), h: n("heightPt") };
  }
}

function coveredFraction(inner: Box, outer: Box): number {
  const w = Math.max(0, Math.min(inner.x + inner.w, outer.x + outer.w) - Math.max(inner.x, outer.x));
  const h = Math.max(0, Math.min(inner.y + inner.h, outer.y + outer.h) - Math.max(inner.y, outer.y));
  const area = Math.max(inner.w, 0.5) * Math.max(inner.h, 0.5);
  return (w * h) / area;
}

/**
 * Elements that sit (mostly) UNDER an opaque whiteout/redact box higher in
 * the stack. They're invisible, so they must not catch clicks: Adam whites
 * out "Condo" and clicks there with the Text tool to type something new —
 * the hidden text box underneath must not swallow that click. A buried
 * element is reachable again by sending the whiteout backward.
 */
export function buriedIds(arrays: LayerArrays<Layerable, Layerable, Layerable>, page: number, threshold = 0.6): Set<string> {
  const order = orderLayers(arrays, page);
  const out = new Set<string>();
  const covers: Box[] = [];
  // Walk top → bottom, accumulating the opaque boxes seen so far.
  for (let i = order.length - 1; i >= 0; i--) {
    const { kind, edit } = order[i];
    const box = approxBox(kind, edit as unknown as Record<string, unknown>);
    if (box && covers.some((c) => coveredFraction(box, c) >= threshold)) out.add(edit.id);
    const sk = (edit as unknown as { kind?: string }).kind;
    if (kind === "shape" && (sk === "whiteout" || sk === "redact") && box) covers.push(box);
  }
  return out;
}
