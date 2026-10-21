/**
 * V1.0126: one undo timeline across the two kinds of change a tab records.
 *
 * A tab keeps two history stacks: `history` (whole-document bytes — page
 * deletes, rotations, watermarks…) and `pendingHistory` (snapshots of the
 * editable elements — text boxes, images, shapes). Before V1.0126 ⌘Z always
 * drained the ELEMENT stack first, whatever happened last, and when that was
 * empty it fell back to deleting the newest element outright. So:
 *  - add a text box, then delete a page, then ⌘Z → the text box vanished and
 *    the page stayed deleted;
 *  - reopen a WeavePDF file (its elements come back as overlays), ⌘Z → your
 *    saved elements were deleted one by one.
 *
 * Now every recorded step also pushes a mark onto `undoOrder`: "pending",
 * "bytes", or "both" (a page operation that moved the elements too). ⌘Z pops
 * the newest mark and undoes exactly that.
 */

export type UndoMark = "pending" | "bytes" | "both";

/**
 * Pick what ⌘Z (or ⌘⇧Z) should undo. Marks whose stack has since been emptied
 * (capped, or cleared by a save) are skipped. With no marks left, nothing is
 * undone — in particular, elements restored from a saved file are never
 * deleted by undo.
 */
export function pickStep(
  order: UndoMark[],
  hasPending: boolean,
  hasBytes: boolean,
): { mark: UndoMark; rest: UndoMark[] } | null {
  const rest = [...order];
  while (rest.length > 0) {
    const mark = rest.pop()!;
    if (mark === "pending" && hasPending) return { mark, rest };
    if (mark === "bytes" && hasBytes) return { mark, rest };
    if (mark === "both") {
      if (hasPending && hasBytes) return { mark, rest };
      if (hasBytes) return { mark: "bytes", rest };
      if (hasPending) return { mark: "pending", rest };
    }
  }
  return null;
}

/** Keep the mark list from growing without bound (the stacks are capped too). */
export function pushMark(order: UndoMark[], mark: UndoMark, cap = 60): UndoMark[] {
  return [...order, mark].slice(-cap);
}

/**
 * Where the "saved" state sits on the timeline. A new step taken after
 * undoing past the save point makes the saved state unreachable (null).
 */
export function cleanDepthAfterPush(cleanDepth: number | null, depthBeforePush: number): number | null {
  if (cleanDepth === null) return null;
  return depthBeforePush < cleanDepth ? null : cleanDepth;
}

/**
 * Record a new step. Same as pushMark + cleanDepthAfterPush, but when the cap
 * drops the OLDEST mark the save point moves down with it — otherwise, after
 * ~60 steps, `cleanDepth` drifted and undo/redo could report unsaved work as
 * saved.
 */
export function pushStep(
  order: UndoMark[],
  cleanDepth: number | null,
  mark: UndoMark,
  cap = 60,
): { order: UndoMark[]; cleanDepth: number | null } {
  let depth = cleanDepthAfterPush(cleanDepth, order.length);
  const next = [...order, mark];
  while (next.length > cap) {
    next.shift();
    if (depth !== null) depth = depth - 1 < 0 ? null : depth - 1;
  }
  return { order: next, cleanDepth: depth };
}

/**
 * After a save clears the page history, element steps recorded BEFORE the
 * newest page-changing step ("bytes" / "both") describe elements on the OLD
 * pages — undoing into them after a save put elements on pages that no longer
 * exist (and every later save then threw). Keep only the element steps since
 * that last page change. Returns the marks to keep; the caller keeps the same
 * number of newest element snapshots.
 */
export function marksAfterSave(order: UndoMark[]): UndoMark[] {
  let lastPage = -1;
  order.forEach((m, i) => {
    if (m !== "pending") lastPage = i;
  });
  return order.slice(lastPage + 1);
}
