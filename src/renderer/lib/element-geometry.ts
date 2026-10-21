/**
 * V1.0134: position maths shared by group drag, ⌘C/⌘V and the arrow-key
 * nudge — one place that knows where every kind of pending element keeps
 * its coordinates. Pure functions, no store, no DOM.
 */
import type { PendingImageEdit, PendingShapeEdit, PendingTextEdit } from "../stores/document";
import { approxBox } from "./layers";

export type ElementRef =
  | { kind: "text"; edit: PendingTextEdit }
  | { kind: "image"; edit: PendingImageEdit }
  | { kind: "shape"; edit: PendingShapeEdit };

export type Point = { x: number; y: number };

/** The point a drag/nudge of this element moves. Lines use their start,
 *  freehand strokes their first point — any single stable point works
 *  because followers only ever receive a delta. */
export function anchorOf(el: ElementRef): Point {
  const e = el.edit as Record<string, unknown>;
  if (el.kind === "shape") {
    const s = el.edit;
    if (s.kind === "line" || s.kind === "arrow") return { x: s.fromX, y: s.fromY };
    if (s.kind === "freehand") return s.points[0] ? { x: s.points[0].x, y: s.points[0].y } : { x: 0, y: 0 };
  }
  return { x: Number(e.xPt) || 0, y: Number(e.yPt) || 0 };
}

/** A copy of the element moved by (dx, dy) points. Every coordinate the
 *  element carries moves together — a text box's whiteout cover, a line's
 *  both ends, every freehand point. */
export function translateElement<T extends ElementRef>(el: T, dx: number, dy: number): T["edit"] {
  if (dx === 0 && dy === 0) return el.edit;
  if (el.kind === "text") {
    const e = el.edit;
    return {
      ...e,
      xPt: e.xPt + dx,
      yPt: e.yPt + dy,
      whiteout: e.whiteout ? { ...e.whiteout, x: e.whiteout.x + dx, y: e.whiteout.y + dy } : e.whiteout,
    };
  }
  if (el.kind === "image") {
    const e = el.edit;
    return { ...e, xPt: e.xPt + dx, yPt: e.yPt + dy };
  }
  const s = el.edit;
  switch (s.kind) {
    case "line":
    case "arrow":
      return { ...s, fromX: s.fromX + dx, fromY: s.fromY + dy, toX: s.toX + dx, toY: s.toY + dy };
    case "freehand":
      return { ...s, points: s.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    default:
      return { ...s, xPt: s.xPt + dx, yPt: s.yPt + dy };
  }
}

/** The fields the store mints itself. Stripped before an element is re-added
 *  (paste, clone) so `addPending*Edit`'s `...edit` spread can't resurrect the
 *  source's id or put the copy under its original in the stacking order. */
export function stripIdentity<T extends { id: string; createdAt?: number; z?: number }>(edit: T): Omit<T, "id" | "createdAt" | "z"> {
  const { id: _id, createdAt: _c, z: _z, ...rest } = edit;
  void _id; void _c; void _z;
  return rest;
}

/** Shrink (dx, dy) so the element's loose bounding box stays inside the
 *  page (minus `margin`). A translation that would push it off the right
 *  edge is reduced, never reversed. */
export function clampTranslationToPage(
  el: ElementRef,
  dx: number,
  dy: number,
  pageW: number,
  pageH: number,
  margin = 0,
): Point {
  const box = approxBox(el.kind, el.edit as Record<string, unknown>);
  if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y)) return { x: dx, y: dy };
  const w = Number.isFinite(box.w) ? box.w : 0;
  const h = Number.isFinite(box.h) ? box.h : 0;
  const minX = margin;
  const maxX = Math.max(minX, pageW - margin - w);
  const minY = margin;
  const maxY = Math.max(minY, pageH - margin - h);
  const targetX = Math.max(minX, Math.min(maxX, box.x + dx));
  const targetY = Math.max(minY, Math.min(maxY, box.y + dy));
  return { x: targetX - box.x, y: targetY - box.y };
}
