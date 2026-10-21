/**
 * V1.0134: group drag. When several elements are selected (shift-click) and
 * the user drags one of them, the others follow by the same delta.
 *
 * Adam: "Selecting both elements, I can only drag the image." There was no
 * multi-selection at all — the second click silently replaced the first.
 *
 * Each overlay layer keeps its own drag maths (cross-page moves, margin
 * clamps, option-drag clones). Rather than merge four drag implementations,
 * the layer that owns the dragged element reports its new anchor on every
 * move and this module translates the other members from a snapshot taken
 * at drag start — absolute from the snapshot, so followers never drift.
 */
import { useDocumentStore, type DocumentTab } from "../stores/document";
import { useUIStore } from "../stores/ui";
import { anchorOf, translateElement, type ElementRef, type Point } from "./element-geometry";

type Session = {
  tabId: string;
  anchorId: string;
  start: Point;
  members: ElementRef[];
};

let session: Session | null = null;

/** Every pending element of `tab` whose id is in `ids`, as tagged refs. */
export function resolveElementRefs(tab: Pick<DocumentTab, "pendingTextEdits" | "pendingImageEdits" | "pendingShapeEdits">, ids: Iterable<string>): ElementRef[] {
  const want = new Set(ids);
  const out: ElementRef[] = [];
  for (const edit of tab.pendingTextEdits) if (want.has(edit.id)) out.push({ kind: "text", edit });
  for (const edit of tab.pendingImageEdits) if (want.has(edit.id)) out.push({ kind: "image", edit });
  for (const edit of tab.pendingShapeEdits) if (want.has(edit.id)) out.push({ kind: "shape", edit });
  return out;
}

/** The ids of everything currently selected: the primary plus the group. */
export function selectedElementIds(): string[] {
  const ui = useUIStore.getState();
  const ids = new Set(ui.groupSelectedIds);
  for (const p of [ui.selectedPendingImageId, ui.selectedPendingTextId, ui.selectedPendingShapeId]) if (p) ids.add(p);
  return Array.from(ids);
}

/** Call at pointer-down of a move drag. Returns true when a group will follow. */
export function beginGroupMove(tabId: string, anchorId: string): boolean {
  session = null;
  const ui = useUIStore.getState();
  if (!ui.groupSelectedIds.includes(anchorId)) return false;
  const tab = useDocumentStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return false;
  const all = resolveElementRefs(tab, ui.groupSelectedIds);
  const anchor = all.find((r) => r.edit.id === anchorId);
  if (!anchor) return false;
  const members = all.filter((r) => r.edit.id !== anchorId);
  if (members.length === 0) return false;
  session = { tabId, anchorId, start: anchorOf(anchor), members };
  return true;
}

/** Call after every move update of the dragged element with its new anchor. */
export function followGroupMove(anchorId: string, now: Point): void {
  const s = session;
  if (!s || s.anchorId !== anchorId) return;
  const dx = now.x - s.start.x;
  const dy = now.y - s.start.y;
  const store = useDocumentStore.getState();
  for (const m of s.members) {
    if (m.kind === "text") {
      const moved = translateElement(m, dx, dy);
      store.updatePendingTextEdit(s.tabId, m.edit.id, moved.whiteout
        ? { xPt: moved.xPt, yPt: moved.yPt, whiteout: moved.whiteout }
        : { xPt: moved.xPt, yPt: moved.yPt });
    } else if (m.kind === "image") {
      const moved = translateElement(m, dx, dy);
      store.updatePendingImageEdit(s.tabId, m.edit.id, { xPt: moved.xPt, yPt: moved.yPt });
    } else {
      const moved = translateElement(m, dx, dy);
      if (moved.kind === "line" || moved.kind === "arrow") {
        store.updatePendingShapeEdit(s.tabId, m.edit.id, { fromX: moved.fromX, fromY: moved.fromY, toX: moved.toX, toY: moved.toY });
      } else if (moved.kind === "freehand") {
        store.updatePendingShapeEdit(s.tabId, m.edit.id, { points: moved.points });
      } else {
        store.updatePendingShapeEdit(s.tabId, m.edit.id, { xPt: moved.xPt, yPt: moved.yPt });
      }
    }
  }
}

/** Call when the drag ends (pointer up / cancel). */
export function endGroupMove(anchorId: string): void {
  if (session?.anchorId === anchorId) session = null;
}

/** Test/diagnostic hook. */
export function groupMoveActive(): boolean {
  return session != null;
}
