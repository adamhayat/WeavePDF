// V1.0123 regression pins: drawing a straight line must not be discarded.
//
// The drag-commit gate was `if (box.w < 4 || box.h < 4) return;` for EVERY
// drag tool. Line, Arrow and Measure derive their endpoints from the drag's
// start and end points and never use the box's area — so a perfectly
// horizontal underline (height ≈ 0) or a vertical rule (width ≈ 0) fell foul
// of the 4px-on-both-axes rule and vanished with no feedback. That is the
// single most ordinary thing a Line tool is used for.
import { describe, it, expect } from "vitest";
import { isDragIntentional, isLinearTool, MIN_DRAG_PX } from "../../src/renderer/lib/drag-gate";

describe("V1.0123: straight line/arrow/measure drags are kept", () => {
  for (const tool of ["line", "arrow", "measure"]) {
    it(`${tool}: a perfectly HORIZONTAL drag is intentional`, () => {
      expect(isDragIntentional(tool, { w: 200, h: 0 })).toBe(true);
    });
    it(`${tool}: a perfectly VERTICAL drag is intentional`, () => {
      expect(isDragIntentional(tool, { w: 0, h: 150 })).toBe(true);
    });
    it(`${tool}: a near-straight drag (1px wobble) is intentional`, () => {
      expect(isDragIntentional(tool, { w: 120, h: 1 })).toBe(true);
    });
    it(`${tool}: a slipped click is still rejected`, () => {
      expect(isDragIntentional(tool, { w: 2, h: 1 })).toBe(false);
      expect(isDragIntentional(tool, { w: 0, h: 0 })).toBe(false);
    });
  }

  it("area tools STILL require both axes — a 200x2 rectangle is an accident", () => {
    for (const tool of ["rect", "circle", "highlight", "whiteout", "redact", "link"]) {
      expect(isDragIntentional(tool, { w: 200, h: 2 })).toBe(false);
      expect(isDragIntentional(tool, { w: 2, h: 200 })).toBe(false);
      expect(isDragIntentional(tool, { w: 200, h: 100 })).toBe(true);
    }
  });

  it("the threshold itself is unchanged for area tools", () => {
    expect(isDragIntentional("rect", { w: MIN_DRAG_PX, h: MIN_DRAG_PX })).toBe(true);
    expect(isDragIntentional("rect", { w: MIN_DRAG_PX - 0.1, h: MIN_DRAG_PX })).toBe(false);
  });

  it("classifies exactly the three stroke tools as linear", () => {
    expect(["line", "arrow", "measure"].every(isLinearTool)).toBe(true);
    expect(["rect", "circle", "highlight", "whiteout", "redact", "draw", "link"].some(isLinearTool)).toBe(false);
  });
});
