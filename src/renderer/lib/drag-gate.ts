// V1.0123: the "was that drag intentional, or a slipped click?" gate.
//
// Extracted from PageCanvas so it can be unit-tested (PageCanvas itself pulls
// in pdf.js and can't be imported from a test). The old inline rule was
//
//     if (box.w < 4 || box.h < 4) return;
//
// which is right for AREA tools — a 200×2 "rectangle" is an accident — but
// wrong for line-like tools, which take their endpoints from the drag's start
// and end points and never use the box's area. Under the old rule a perfectly
// horizontal underline (height ≈ 0) or a vertical rule (width ≈ 0) was
// silently discarded, so the most ordinary gesture the Line tool exists for
// looked like the tool was broken.

/** Tools whose result is a stroke between two points, not a filled region. */
export const LINEAR_TOOLS = ["line", "arrow", "measure"] as const;

export const MIN_DRAG_PX = 4;

export type DragBox = { w: number; h: number };

export function isLinearTool(tool: string): boolean {
  return (LINEAR_TOOLS as readonly string[]).includes(tool);
}

/** True when the drag is big enough to be intentional. Linear tools are judged
 *  on total drag LENGTH; area tools must clear the threshold on both axes. */
export function isDragIntentional(tool: string, box: DragBox): boolean {
  if (isLinearTool(tool)) {
    return Math.hypot(box.w, box.h) >= MIN_DRAG_PX;
  }
  return box.w >= MIN_DRAG_PX && box.h >= MIN_DRAG_PX;
}
