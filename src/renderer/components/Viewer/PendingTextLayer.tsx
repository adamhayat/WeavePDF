import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { X, Edit2, Minus, Plus, Bold, Italic, AlignLeft, AlignCenter, AlignRight, AlignJustify, Link as LinkIcon } from "lucide-react";
import { useDocumentStore, type PendingTextEdit } from "../../stores/document";
import { useUIStore } from "../../stores/ui";
import { resolveCrossPageTopLeft } from "../../lib/cross-page-drag";

const MIN_WRAP_TEXT_WIDTH_PT = 120;

type Props = {
  pageNumber: number;
  zoom: number;
  pageHeightPx: number; // rendered page height in CSS pixels
  /** V1.0064: page width in PDF points. Used together with the UI store's
   *  `marginsEnabled` to clamp each pending text overlay's rendered width
   *  so it can never extend past the active right boundary (margin or
   *  page edge), regardless of the stored `widthPt`. */
  pageWidthPt: number;
  /** V1.0068: page height in PDF points. Needed for top/bottom margin
   *  clamping of drag-move operations. */
  pageHeightPt: number;
};

export function PendingTextLayer({ pageNumber, zoom, pageHeightPx, pageWidthPt, pageHeightPt }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const marginsEnabled = useUIStore((s) => s.marginsEnabled);
  if (!activeTab) return null;

  const edits = activeTab.pendingTextEdits.filter((e) => e.page === pageNumber);
  if (edits.length === 0) return null;

  return (
    <>
      {edits.map((edit) => (
        <PendingTextWhiteout
          key={`${edit.id}-whiteout`}
          edit={edit}
          zoom={zoom}
          pageHeightPx={pageHeightPx}
        />
      ))}
      {edits.map((edit) => (
        <PendingText
          key={edit.id}
          edit={edit}
          zoom={zoom}
          pageHeightPx={pageHeightPx}
          tabId={activeTab.id}
          pageWidthPt={pageWidthPt}
          pageHeightPt={pageHeightPt}
          marginsEnabled={marginsEnabled}
        />
      ))}
    </>
  );
}

function PendingTextWhiteout({
  edit,
  zoom,
  pageHeightPx,
}: {
  edit: PendingTextEdit;
  zoom: number;
  pageHeightPx: number;
}) {
  if (!edit.whiteout) return null;
  return (
    <div
      className="pointer-events-none absolute z-[19] bg-white"
      data-testid="pending-text-whiteout"
      style={{
        left: edit.whiteout.x * zoom,
        top: pageHeightPx - (edit.whiteout.y + edit.whiteout.height) * zoom,
        width: edit.whiteout.width * zoom,
        height: edit.whiteout.height * zoom,
      }}
    />
  );
}

type PendingTextProps = {
  edit: PendingTextEdit;
  zoom: number;
  pageHeightPx: number;
  tabId: string;
  /** V1.0064: page width in PDF points + the global Margins toggle state.
   *  Used to compute the effective rendered widthPt — a hard clamp that
   *  text can't exceed regardless of the stored value. Edit Text
   *  replacements (whiteout set) skip the clamp so they stay tight to the
   *  original glyph extent. */
  pageWidthPt: number;
  pageHeightPt: number;
  marginsEnabled: boolean;
};

function PendingText({
  edit,
  zoom,
  pageHeightPx,
  tabId,
  pageWidthPt,
  pageHeightPt,
  marginsEnabled,
}: PendingTextProps) {
  const updatePendingTextEdit = useDocumentStore((s) => s.updatePendingTextEdit);
  const removePendingTextEdit = useDocumentStore((s) => s.removePendingTextEdit);
  const pushUndoStep = useDocumentStore((s) => s.pushUndoStep);
  const selected = useUIStore((s) => s.selectedPendingTextId === edit.id);
  const setSelectedId = useUIStore((s) => s.setSelectedPendingText);
  const shouldEditNow = useUIStore((s) => s.editingPendingTextId === edit.id);
  const setEditingId = useUIStore((s) => s.setEditingPendingText);
  const [isEditing, setIsEditing] = useState(false);
  const [draftText, setDraftText] = useState(edit.text);
  // V1.0062: textarea when the text has a `widthPt` (multi-line wrap mode),
  // input when it doesn't (single-line Edit-Text replacement).
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // V1.0064: effective rendered width — the hard clamp against the active
  // right boundary. Edit Text replacements (whiteout set) skip the clamp;
  // those should match the original glyph extent even if it overflows the
  // margin. Add Text overlays get their stored `widthPt` clamped down to
  // `rightBound - xPt` so they can never render past the boundary, even
  // if the stored value is larger.
  const PAGE_MARGIN = 36;
  const rightBound = marginsEnabled ? pageWidthPt - PAGE_MARGIN : pageWidthPt;
  const maxAllowedWidth = Math.max(36, rightBound - edit.xPt);
  const minWrapWidth = edit.whiteout != null
    ? 36
    : Math.min(MIN_WRAP_TEXT_WIDTH_PT, maxAllowedWidth);
  const effectiveWidthPt = edit.whiteout != null
    ? edit.widthPt ?? null
    : edit.widthPt != null
      ? Math.max(minWrapWidth, Math.min(edit.widthPt, maxAllowedWidth))
      : maxAllowedWidth;

  // Auto-enter edit mode when the Edit-Existing-Text click handler added us
  // with editingPendingTextId set. This turns "click the word I want to fix"
  // into "click, type replacement, press Enter" instead of "click, see a
  // duplicate, double-click to actually edit".
  useLayoutEffect(() => {
    if (shouldEditNow) {
      setDraftText(edit.text);
      setIsEditing(true);
      setSelectedId(edit.id);
      setEditingId(null);
    }
  }, [shouldEditNow, edit.text, edit.id, setEditingId, setSelectedId]);
  // V1.0069: tighten wrapper to the longest WRAPPED line. `inline-block +
  // max-width` sizes the box to max-width whenever natural content width
  // exceeds it (CSS shrink-to-fit), so the rendered text leaves trailing
  // whitespace inside the wrapper. We measure each line's bounding rect
  // via the Range API and pin `width` to the longest.
  //
  // V1.0077: apply to ALL alignments. Pre-V1.0077 the tightening skipped
  // center / right / justify because the wrapper width WAS the alignment
  // reference, and we wanted centering to happen across the full wrap
  // width. Adam's feedback: alignment should be relative to the actual
  // text bounds, not the outer wrap box — short lines should center
  // against the longest line, not against the dashed frame's right
  // edge. drawWrappedText now bakes the same way (longest-line ref),
  // so this render matches the eventual output.
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    if (effectiveWidthPt == null) return; // single-line text has no wrap
    if (isEditing) return; // textarea handles its own sizing
    let textNode: Text | null = null;
    for (const n of wrapper.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        textNode = n as Text;
        break;
      }
    }
    if (!textNode || textNode.data.length === 0) {
      wrapper.style.width = "";
      return;
    }
    wrapper.style.width = "";
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const rects = range.getClientRects();
    let maxW = 0;
    for (const r of rects) if (r.width > maxW) maxW = r.width;
    if (maxW > 0) {
      // V1.0076: account for wrapper's padding + border. The wrapper
      // uses Tailwind's default box-sizing: border-box, so setting
      // `style.width = maxW` (the measured TEXT width) leaves
      // content-area = maxW − padding < maxW. The text then re-wraps
      // shorter than max-width, leaving visible whitespace inside the
      // outer dashed frame. Adding the padding/border back puts the
      // content area at exactly maxW so the text fits without
      // re-wrapping. Falls back to a sensible default if computed
      // styles aren't available.
      const cs = window.getComputedStyle(wrapper);
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padR = parseFloat(cs.paddingRight) || 0;
      const borL = parseFloat(cs.borderLeftWidth) || 0;
      const borR = parseFloat(cs.borderRightWidth) || 0;
      wrapper.style.width = `${Math.ceil(maxW + padL + padR + borL + borR)}px`;
    }
  }, [
    edit.text, edit.size, edit.bold, edit.italic, edit.align,
    zoom, effectiveWidthPt, isEditing,
  ]);
  const dragState = useRef<{
    startClientX: number;
    startClientY: number;
    startXPt: number;
    startYPt: number;
    currentPage: number;
    pointerOffsetXPx: number;
    pointerOffsetYPx: number;
    widthPt: number;
    heightPt: number;
    detachedWhiteout: boolean;
    active: boolean;
    /** V1.0070: when the gesture started with Alt/Option held, we clone
     *  the edit and drag the CLONE — pointer capture stays on the
     *  original element but the move handler updates this id instead. */
    dragEditId: string;
    cleanup?: () => void;
  } | null>(null);
  const addPendingTextEdit = useDocumentStore((s) => s.addPendingTextEdit);
  const addPendingShapeEdit = useDocumentStore((s) => s.addPendingShapeEdit);

  // When entering edit mode, synchronously focus + select-all so the very
  // next keystroke replaces existing text. autoFocus runs after React's
  // commit which races against global keyboard handlers.
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // V1.0090: one-shot normalize on mount. When a saved PDF restores
  // pending edits via WeavePDFEdits metadata, the saved xPt/yPt can
  // sit slightly past the current page's margin bounds (page resized,
  // margin toggled differently, source-paper mismatch). The V1.0069
  // drag clamp fixes this on first drag — Adam: "Once you drag them
  // again they go back into the margins". This effect runs the same
  // clamp at mount so the user doesn't have to drag every restored
  // overlay. Idempotent: if coords are already inside, no-op.
  useEffect(() => {
    const m = marginsEnabled ? 36 : 0;
    const MIN_W = 36;
    const clampedX = Math.max(m, Math.min(pageWidthPt - m - MIN_W, edit.xPt));
    const clampedY = Math.max(m + edit.size, Math.min(pageHeightPt - m, edit.yPt));
    if (Math.abs(clampedX - edit.xPt) > 0.5 || Math.abs(clampedY - edit.yPt) > 0.5) {
      updatePendingTextEdit(tabId, edit.id, { xPt: clampedX, yPt: clampedY });
    }
    // Intentionally NOT including edit.xPt/yPt in deps — we want one-
    // shot normalization, not a per-render clamp loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit.id]);

  // V1.0077: textarea auto-grows to fit content. The pre-V1.0077 textarea
  // sized itself off `rows={Math.max(2, draftText.split("\n").length)}` —
  // which counts HARD newlines only, so a paragraph that visually wraps to
  // 10 lines still rendered at 2 rows. Typing a long paragraph or pasting
  // bullets felt cramped because most of the content sat below the visible
  // area. We now measure scrollHeight after every change and grow the
  // textarea to fit. The min-height keeps the box readable even when empty.
  useLayoutEffect(() => {
    if (!isEditing) return;
    const ta = inputRef.current;
    if (!ta || !(ta instanceof HTMLTextAreaElement)) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [draftText, edit.size, zoom, effectiveWidthPt, isEditing]);

  // Position — the pdf-lib drawText origin is the baseline's bottom-left, so
  // the DOM box top must sit (size * lineHeight) points above that point.
  const leftPx = edit.xPt * zoom;
  const baselineYFromTopPx = pageHeightPx - edit.yPt * zoom;
  // Approximate visual baseline with font-size * 1.2 line-box.
  const topPx = baselineYFromTopPx - edit.size * zoom * 1.0;

  const finishDrag = useCallback((pointerId?: number, captureTarget?: HTMLElement | null) => {
    const s = dragState.current;
    if (!s) return;
    s.cleanup?.();
    s.active = false;
    dragState.current = null;
    if (pointerId != null && captureTarget) {
      try {
        captureTarget.releasePointerCapture(pointerId);
      } catch {
        /* may already be released */
      }
    }
  }, []);

  const applyDragMove = useCallback(
    (clientX: number, clientY: number) => {
      const s = dragState.current;
      if (!s?.active) return;
      const target = resolveCrossPageTopLeft({
        currentPage: s.currentPage,
        clientX,
        clientY,
        zoom,
        pointerOffsetXPx: s.pointerOffsetXPx,
        pointerOffsetYPx: s.pointerOffsetYPx,
        widthPt: s.widthPt,
        heightPt: s.heightPt,
        marginsEnabled,
      });
      if (!target) {
        const dx = (clientX - s.startClientX) / zoom;
        const dy = (clientY - s.startClientY) / zoom;
        const m = marginsEnabled ? 36 : 0;
        const xPt = Math.max(m, Math.min(pageWidthPt - m - s.widthPt, s.startXPt + dx));
        const yMax = pageHeightPt - m - edit.size;
        const yMin = m - edit.size + s.heightPt;
        const yPt = Math.max(yMin, Math.min(yMax, s.startYPt - dy));
        updatePendingTextEdit(tabId, s.dragEditId, { xPt, yPt });
        return;
      }

      const patch: Partial<PendingTextEdit> = {
        page: target.page,
        xPt: target.xPt,
        yPt: target.pageHeightPt - target.topPt - edit.size,
      };
      if (target.page !== s.currentPage && edit.whiteout && !s.detachedWhiteout) {
        addPendingShapeEdit(tabId, {
          kind: "whiteout",
          page: s.currentPage,
          xPt: edit.whiteout.x,
          yPt: edit.whiteout.y,
          widthPt: edit.whiteout.width,
          heightPt: edit.whiteout.height,
        });
        patch.whiteout = undefined;
        s.detachedWhiteout = true;
      }
      s.currentPage = target.page;
      updatePendingTextEdit(tabId, s.dragEditId, patch);
    },
    [
      zoom,
      marginsEnabled,
      pageWidthPt,
      pageHeightPt,
      edit.size,
      edit.whiteout,
      updatePendingTextEdit,
      addPendingShapeEdit,
      tabId,
    ],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (isEditing) return;
      if (e.button !== 0) return;
      // V1.0070: snapshot before the drag so the entire move is one
      // undo step (intermediate pointermove updates don't snapshot).
      pushUndoStep(tabId);
      let dragEditId = edit.id;
      // V1.0070: option-drag duplicates. Clone the edit synchronously
      // so the drag moves the CLONE and the original stays put. Mac
      // convention (Finder, Pages, Sketch, Figma).
      if (e.altKey) {
        const { id: _unused, ...rest } = edit;
        void _unused;
        dragEditId = addPendingTextEdit(tabId, rest);
        setSelectedId(dragEditId);
      } else {
        setSelectedId(edit.id);
      }
      const target = e.currentTarget;
      const rect = wrapperRef.current?.getBoundingClientRect() ?? target.getBoundingClientRect();
      const handleWindowMove = (ev: PointerEvent) => {
        if (!dragState.current?.active) return;
        ev.preventDefault();
        applyDragMove(ev.clientX, ev.clientY);
      };
      const handleWindowUp = (ev: PointerEvent) => finishDrag(ev.pointerId, target);
      window.addEventListener("pointermove", handleWindowMove, { capture: true });
      window.addEventListener("pointerup", handleWindowUp, { capture: true, once: true });
      window.addEventListener("pointercancel", handleWindowUp, { capture: true, once: true });
      dragState.current = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startXPt: edit.xPt,
        startYPt: edit.yPt,
        currentPage: edit.page,
        pointerOffsetXPx: e.clientX - rect.left,
        pointerOffsetYPx: e.clientY - rect.top,
        widthPt: rect.width / zoom,
        heightPt: rect.height / zoom,
        detachedWhiteout: false,
        active: true,
        dragEditId,
        cleanup: () => {
          window.removeEventListener("pointermove", handleWindowMove, true);
          window.removeEventListener("pointerup", handleWindowUp, true);
          window.removeEventListener("pointercancel", handleWindowUp, true);
        },
      };
      target.setPointerCapture(e.pointerId);
      e.stopPropagation();
    },
    [
      edit,
      isEditing,
      setSelectedId,
      pushUndoStep,
      tabId,
      addPendingTextEdit,
      zoom,
      applyDragMove,
      finishDrag,
    ],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      applyDragMove(e.clientX, e.clientY);
    },
    [applyDragMove],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      finishDrag(e.pointerId, e.currentTarget);
    },
    [finishDrag],
  );

  // V1.0070: SE handle now resizes the WRAP FRAME (widthPt), not the
  // font size. Adam's repeated feedback after V1.0066/V1.0068/V1.0069:
  // "every time I try to resize the box to make it one line it resizes
  // all the text". The two-box model fixes this — drag the dashed
  // frame's corner to grow / shrink the writing area; the text stays
  // its current size and re-wraps inside. Font size lives in the
  // toolbar (typeable input + ± buttons + ⌘+/⌘− eventually). For
  // single-line edits (Edit Text replacements, no widthPt), the SE
  // handle is hidden entirely — there's no frame to resize.
  const resizeState = useRef<
    | {
        anchorClientX: number;
        active: boolean;
        minWidthPt: number;
        maxWidthPt: number;
      }
    | null
  >(null);
  const onResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      pushUndoStep(tabId);
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const PAGE_MARGIN = marginsEnabled ? 36 : 0;
      const rightBound = pageWidthPt - PAGE_MARGIN;
      resizeState.current = {
        anchorClientX: rect.left,
        active: true,
        minWidthPt: Math.min(MIN_WRAP_TEXT_WIDTH_PT, Math.max(36, rightBound - edit.xPt)),
        maxWidthPt: Math.max(36, rightBound - edit.xPt),
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setSelectedId(edit.id);
    },
    [edit.id, edit.xPt, marginsEnabled, pageWidthPt, setSelectedId, pushUndoStep, tabId],
  );
  const onResizePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const s = resizeState.current;
      if (!s?.active) return;
      // Cursor's X relative to wrapper left, in PDF points = new widthPt.
      const targetWidthPt = (e.clientX - s.anchorClientX) / zoom;
      const nextWidth = Math.max(
        s.minWidthPt,
        Math.min(s.maxWidthPt, targetWidthPt),
      );
      updatePendingTextEdit(tabId, edit.id, { widthPt: nextWidth });
    },
    [updatePendingTextEdit, tabId, edit.id, zoom],
  );
  const onResizePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!resizeState.current) return;
      resizeState.current.active = false;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    },
    [],
  );

  // V1.0071: SECOND resize handle — on the INNER text wrapper — that
  // scales the FONT SIZE. Adam wants both boxes adjustable: outer →
  // total writing area (widthPt, above), inner → text size (this).
  // V1.0060 proportional formula: capture the wrapper's top-left
  // anchor + cursor distance at gesture start, scale font size by
  // newDist / startDist on every move. Stable (no per-frame axis
  // flip-flop) and self-calibrating (same drag distance produces a
  // proportional change regardless of starting size).
  const fontResizeState = useRef<
    | {
        anchorClientX: number;
        anchorClientY: number;
        startDist: number;
        startSize: number;
        active: boolean;
      }
    | null
  >(null);
  const onFontResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      pushUndoStep(tabId);
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const anchorX = rect.left;
      const anchorY = rect.top;
      const dist = Math.hypot(e.clientX - anchorX, e.clientY - anchorY);
      if (dist < 1) return;
      fontResizeState.current = {
        anchorClientX: anchorX,
        anchorClientY: anchorY,
        startDist: dist,
        startSize: edit.size,
        active: true,
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setSelectedId(edit.id);
    },
    [edit.id, edit.size, setSelectedId, pushUndoStep, tabId],
  );
  const onFontResizePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const s = fontResizeState.current;
      if (!s?.active) return;
      const newDist = Math.hypot(
        e.clientX - s.anchorClientX,
        e.clientY - s.anchorClientY,
      );
      const ratio = newDist / s.startDist;
      const nextSize = Math.max(6, Math.min(144, s.startSize * ratio));
      updatePendingTextEdit(tabId, edit.id, { size: nextSize });
    },
    [updatePendingTextEdit, tabId, edit.id],
  );
  const onFontResizePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!fontResizeState.current) return;
      fontResizeState.current.active = false;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    },
    [],
  );

  const commitEdit = useCallback(() => {
    updatePendingTextEdit(tabId, edit.id, { text: draftText });
    setIsEditing(false);
    // V1.0075: do NOT clear selection here. Pre-V1.0075 a textarea blur
    // (which fires when the user clicks anywhere — including a format
    // bar button or the font-size input) deselected the overlay, which
    // unmounted the format bar before the user's click could complete.
    // Selection now persists across commit; the user explicitly clears
    // it by clicking the background or pressing Escape.
  }, [draftText, edit.id, tabId, updatePendingTextEdit]);

  // Keyboard: arrow nudge, font-size step, delete, escape — when selected and not editing.
  useEffect(() => {
    if (!selected || isEditing) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      // V1.0057: ⌘B / ⌘I toggle bold / italic on the selected text. Sidebar
      // toggle moved from ⌘B to ⌘\ (see main.ts) so this binding is free.
      // V1.0069: ⌘L / ⌘E / ⌘R / ⌘J set alignment (word-processor convention).
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        if (e.key === "b" || e.key === "B") {
          e.preventDefault();
          pushUndoStep(tabId);
          updatePendingTextEdit(tabId, edit.id, { bold: !edit.bold });
          return;
        }
        if (e.key === "i" || e.key === "I") {
          e.preventDefault();
          pushUndoStep(tabId);
          updatePendingTextEdit(tabId, edit.id, { italic: !edit.italic });
          return;
        }
        const alignKey: Record<string, "left" | "center" | "right" | "justify"> = {
          l: "left", L: "left",
          e: "center", E: "center",
          r: "right", R: "right",
          j: "justify", J: "justify",
        };
        const v = alignKey[e.key];
        if (v != null) {
          e.preventDefault();
          pushUndoStep(tabId);
          updatePendingTextEdit(tabId, edit.id, { align: v });
          return;
        }
      }
      const step = e.shiftKey ? 10 : 1;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        pushUndoStep(tabId);
        updatePendingTextEdit(tabId, edit.id, { yPt: edit.yPt + step });
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        pushUndoStep(tabId);
        updatePendingTextEdit(tabId, edit.id, { yPt: edit.yPt - step });
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        pushUndoStep(tabId);
        updatePendingTextEdit(tabId, edit.id, { xPt: edit.xPt - step });
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        pushUndoStep(tabId);
        updatePendingTextEdit(tabId, edit.id, { xPt: edit.xPt + step });
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        removePendingTextEdit(tabId, edit.id);
        setSelectedId(null);
      } else if (e.key === "Enter") {
        e.preventDefault();
        setDraftText(edit.text);
        setIsEditing(true);
      } else if (e.key === "Escape") {
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [selected, isEditing, edit.xPt, edit.yPt, edit.id, edit.text, edit.bold, edit.italic, tabId, updatePendingTextEdit, removePendingTextEdit, setSelectedId, pushUndoStep]);

  const openLinkForText = useCallback((screenX?: number, screenY?: number) => {
    const pageEl = document.querySelector<HTMLElement>(`[data-page="${edit.page}"]`);
    if (!pageEl) return;
    const input = inputRef.current;
    const text = input?.value ?? edit.text;
    let start = 0;
    let end = text.length;
    if (input && input.selectionStart != null && input.selectionEnd != null && input.selectionStart !== input.selectionEnd) {
      start = input.selectionStart;
      end = input.selectionEnd;
    } else {
      const match = text.match(/(?:https?:\/\/|www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?/i);
      if (match?.index != null) {
        start = match.index;
        end = match.index + match[0].length;
      }
    }

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const weight = edit.bold ? "700" : "400";
    const style = edit.italic ? "italic " : "";
    if (ctx) ctx.font = `${style}${weight} ${edit.size * zoom}px Helvetica, sans-serif`;
    const measure = (s: string) => (ctx ? ctx.measureText(s).width / zoom : s.length * edit.size * 0.55);
    let selectedText = text.slice(start, end);
    const selectedUrlMatch = selectedText.match(/(?:https?:\/\/|www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?/i);
    if (selectedUrlMatch?.index != null && (selectedText.includes(" ") || (start === 0 && end === text.length))) {
      start += selectedUrlMatch.index;
      end = start + selectedUrlMatch[0].length;
      selectedText = text.slice(start, end);
    }
    const selectedUrl = selectedText.match(/(?:https?:\/\/|www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?/i)?.[0];
    const prefixPt = measure(text.slice(0, start));
    const widthPt = Math.max(8, measure(selectedText));
    const heightPt = edit.size * 1.25;
    const xPt = edit.xPt + prefixPt;
    const yPt = Math.max(0, edit.yPt - edit.size * 0.25);
    const pageRect = pageEl.getBoundingClientRect();
    useUIStore.getState().setPendingLink({
      page: edit.page,
      rect: { x: xPt, y: yPt, width: widthPt, height: heightPt },
      screenX: screenX ?? pageRect.left + (xPt + widthPt / 2) * zoom,
      screenY: screenY ?? pageRect.top + (pageHeightPt - yPt) * zoom + 8,
      suggestedUrl: selectedUrl,
    });
  }, [edit, pageHeightPt, zoom]);

  // V1.0057: right-click → "Align to page" + Delete.
  // V1.0081: measure the wrapper's actual rendered content bbox (with
  // padding + border subtracted) so the alignment uses the INNER box,
  // not the wider outer dashed wrap frame. For wrap-mode text the
  // stored `widthPt` is the wrap BOUNDARY — wider than the rendered
  // glyphs when the text doesn't fill the frame, which made "Center
  // horizontally" snap to the empty-frame center instead of the
  // visible text center. The DOM-measured bbox is the actual visible
  // extent at current zoom; converting it back to PDF points gives the
  // alignment box the user expects.
  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const align = useDocumentStore.getState().alignPendingElement;
    let bboxOverride: { wPt: number; hPt: number } | undefined;
    const wrapper = wrapperRef.current;
    if (wrapper) {
      const cs = window.getComputedStyle(wrapper);
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padR = parseFloat(cs.paddingRight) || 0;
      const padT = parseFloat(cs.paddingTop) || 0;
      const padB = parseFloat(cs.paddingBottom) || 0;
      const borL = parseFloat(cs.borderLeftWidth) || 0;
      const borR = parseFloat(cs.borderRightWidth) || 0;
      const borT = parseFloat(cs.borderTopWidth) || 0;
      const borB = parseFloat(cs.borderBottomWidth) || 0;
      const rect = wrapper.getBoundingClientRect();
      const innerCssW = rect.width - padL - padR - borL - borR;
      const innerCssH = rect.height - padT - padB - borT - borB;
      bboxOverride = {
        wPt: Math.max(0, innerCssW / zoom),
        hPt: Math.max(0, innerCssH / zoom),
      };
    }
    useUIStore.getState().openContextMenu(e.clientX, e.clientY, [
      { kind: "item", label: "Align to left margin", onClick: () => void align(tabId, "text", edit.id, "left", bboxOverride) },
      { kind: "item", label: "Center horizontally", onClick: () => void align(tabId, "text", edit.id, "center-h", bboxOverride) },
      { kind: "item", label: "Align to right margin", onClick: () => void align(tabId, "text", edit.id, "right", bboxOverride) },
      { kind: "separator" },
      { kind: "item", label: "Align to top margin", onClick: () => void align(tabId, "text", edit.id, "top", bboxOverride) },
      { kind: "item", label: "Center vertically", onClick: () => void align(tabId, "text", edit.id, "center-v", bboxOverride) },
      { kind: "item", label: "Align to bottom margin", onClick: () => void align(tabId, "text", edit.id, "bottom", bboxOverride) },
      { kind: "separator" },
      { kind: "item", label: "Add link…", onClick: () => openLinkForText(e.clientX, e.clientY) },
      { kind: "separator" },
      {
        kind: "item",
        label: "Delete",
        danger: true,
        onClick: () => {
          removePendingTextEdit(tabId, edit.id);
          setSelectedId(null);
        },
      },
    ]);
  };

  return (
    <div
      className="absolute z-20 select-none"
      style={{
        left: leftPx,
        top: topPx,
        cursor: isEditing ? "text" : "move",
        // V1.0069: outer line-box adds ~2 px of baseline descent space
        // below the inline-block wrapper, extending the outer div's
        // hit area past the visible text. That extra strip intercepts
        // clicks meant for other tools (e.g. dropping a sticky right
        // below a text overlay). Collapsing line-height keeps the
        // outer's bbox exactly equal to the wrapper's.
        lineHeight: 0,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={onContextMenu}
      onDoubleClick={() => {
        setDraftText(edit.text);
        setIsEditing(true);
      }}
      data-testid="pending-text"
      data-edit-id={edit.id}
      data-pending-element="text"
      data-page-number={edit.page}
      data-x-pt={edit.xPt.toFixed(2)}
      data-y-pt={edit.yPt.toFixed(2)}
    >
      {/* V1.0070: wrap-frame box. Visible only for wrap-mode text and
          only when selected. Dashed accent border distinguishes it from
          the wrapper's solid selection ring. Frame width = effectiveWidthPt;
          height auto-stretches to the wrapper's height (top/left/bottom: 0
          + width). `pointer-events: none` lets clicks pass through to
          the text wrapper underneath; only the SE handle takes pointer
          events. Drag the handle → resize the FRAME (widthPt), not the
          font size. Two distinct controls for two distinct things. */}
      {selected && effectiveWidthPt != null && !isEditing && (
        <div
          className="pointer-events-none absolute border border-dashed border-[var(--color-accent)]/60"
          style={{ top: 0, left: 0, bottom: 0, width: effectiveWidthPt * zoom }}
          data-pending-frame="text"
        >
          <div
            role="button"
            tabIndex={-1}
            aria-label="Drag to resize the text frame width"
            title="Drag horizontally to resize the writing area · font size lives in the toolbar"
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            className="pointer-events-auto absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-ew-resize rounded-sm border border-white bg-[var(--color-accent)] shadow-sm"
            data-handle="frame-se"
          />
        </div>
      )}
      {/* V1.0075: format bar lives at the OUTER level so it's visible in
          BOTH edit mode (textarea active) and read mode. Pre-V1.0075 it
          was buried inside the read-mode `<div>` and only rendered after
          the textarea blurred — which meant clicking the "Aa ▸" pill on
          a form field (V1.0074) immediately put you in edit mode with
          NO visible format bar. Each button uses `pointerdown +
          mousedown preventDefault` to keep the input focused while
          clicking so a B/I/align toggle doesn't blur the textarea and
          commit. */}
      {selected && (
        <div
          className="absolute -top-3.5 left-8 z-50 flex h-4 items-center gap-0.5 rounded bg-[var(--panel-bg-raised)] px-1 shadow-sm"
          data-testid="pending-text-format-bar"
          // Stop drag-state from bubbling up to the outer onPointerDown,
          // but DON'T preventDefault here — the FontSizeInput inside
          // needs to receive focus normally. Each button still has its
          // own pointerdown/mousedown preventDefault to keep the
          // textarea focused while it's being clicked.
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
            onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
            onClick={(e) => {
              e.stopPropagation();
              pushUndoStep(tabId);
              updatePendingTextEdit(tabId, edit.id, {
                size: Math.max(6, edit.size - 1),
              });
            }}
            className="flex h-3 w-3 items-center justify-center text-[var(--muted)] hover:text-[var(--app-fg)]"
            aria-label="Decrease font size"
          >
            <Minus className="h-2.5 w-2.5" strokeWidth={2} />
          </button>
          <FontSizeInput
            size={edit.size}
            onCommit={(s) => {
              pushUndoStep(tabId);
              updatePendingTextEdit(tabId, edit.id, { size: s });
            }}
          />
          <button
            type="button"
            onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
            onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
            onClick={(e) => {
              e.stopPropagation();
              pushUndoStep(tabId);
              updatePendingTextEdit(tabId, edit.id, {
                size: Math.min(144, edit.size + 1),
              });
            }}
            className="flex h-3 w-3 items-center justify-center text-[var(--muted)] hover:text-[var(--app-fg)]"
            aria-label="Increase font size"
          >
            <Plus className="h-2.5 w-2.5" strokeWidth={2} />
          </button>
          <div className="mx-0.5 h-3 w-px bg-[var(--panel-border)]" />
          <button
            type="button"
            onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
            onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
            onClick={(e) => {
              e.stopPropagation();
              pushUndoStep(tabId);
              updatePendingTextEdit(tabId, edit.id, { bold: !edit.bold });
            }}
            className={
              "flex h-3 w-3 items-center justify-center " +
              (edit.bold
                ? "text-[var(--color-accent)]"
                : "text-[var(--muted)] hover:text-[var(--app-fg)]")
            }
            aria-label="Toggle bold (⌘B)"
            title="Bold · ⌘B"
            data-testid="format-bar-bold"
          >
            <Bold className="h-2.5 w-2.5" strokeWidth={2.5} />
          </button>
          <button
            type="button"
            onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
            onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
            onClick={(e) => {
              e.stopPropagation();
              pushUndoStep(tabId);
              updatePendingTextEdit(tabId, edit.id, { italic: !edit.italic });
            }}
            className={
              "flex h-3 w-3 items-center justify-center " +
              (edit.italic
                ? "text-[var(--color-accent)]"
                : "text-[var(--muted)] hover:text-[var(--app-fg)]")
            }
            aria-label="Toggle italic (⌘I)"
            title="Italic · ⌘I"
            data-testid="format-bar-italic"
          >
            <Italic className="h-2.5 w-2.5" strokeWidth={2} />
          </button>
          <button
            type="button"
            onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
            onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
            onClick={(e) => {
              e.stopPropagation();
              openLinkForText();
            }}
            className="flex h-3 w-3 items-center justify-center text-[var(--muted)] hover:text-[var(--app-fg)]"
            aria-label="Add link"
            title="Add link"
            data-testid="format-bar-link"
          >
            <LinkIcon className="h-2.5 w-2.5" strokeWidth={2} />
          </button>
          {effectiveWidthPt != null && (
            <>
              <div className="mx-0.5 h-3 w-px bg-[var(--panel-border)]" />
              {(
                [
                  { v: "left", Icon: AlignLeft, label: "Align left", key: "⌘L" },
                  { v: "center", Icon: AlignCenter, label: "Align center", key: "⌘E" },
                  { v: "right", Icon: AlignRight, label: "Align right", key: "⌘R" },
                  { v: "justify", Icon: AlignJustify, label: "Justify", key: "⌘J" },
                ] as const
              ).map(({ v, Icon, label, key }) => {
                const active = (edit.align ?? "left") === v;
                return (
                  <button
                    key={v}
                    type="button"
                    onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
                    onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
                    onClick={(e) => {
                      e.stopPropagation();
                      pushUndoStep(tabId);
                      updatePendingTextEdit(tabId, edit.id, { align: v });
                    }}
                    className={
                      "flex h-3 w-3 items-center justify-center " +
                      (active
                        ? "text-[var(--color-accent)]"
                        : "text-[var(--muted)] hover:text-[var(--app-fg)]")
                    }
                    aria-label={`${label} (${key})`}
                    title={`${label} · ${key}`}
                    data-align={v}
                  >
                    <Icon className="h-2.5 w-2.5" strokeWidth={2} />
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
      {isEditing ? (
        <div
          className="relative"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {effectiveWidthPt != null ? (
            // V1.0062: multi-line textarea for wrapping text. Enter inserts
            // a line break; ⌘↵ commits (matches the convention used by
            // Apple Notes / Apple Mail compose). Escape cancels.
            <textarea
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                e.stopPropagation();
                // V1.0090: switch to messaging-app convention (Family B per
                // research): plain Enter = commit, Shift/Option+Enter =
                // soft newline. ⌘+Enter still also commits for muscle
                // memory continuity. Adam's brief: "Enter should finish
                // editing, Shift+Enter should make a line break, that's
                // more standard like other apps".
                if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
                  e.preventDefault();
                  commitEdit();
                  e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setIsEditing(false);
                  setDraftText(edit.text);
                  e.currentTarget.blur();
                }
              }}
              rows={1}
              data-testid="pending-text-input"
              className="block resize-none overflow-hidden rounded-[2px] border border-[var(--color-accent)]/70 bg-transparent px-1 py-0.5 text-[#0b0b0e] caret-[var(--color-accent)] shadow-[0_0_0_1px_rgba(59,76,202,0.12)] focus:border-[var(--color-accent)] focus:outline-none"
              style={{
                fontSize: edit.size * zoom,
                lineHeight: 1.2,
                fontFamily: "Helvetica, sans-serif",
                fontWeight: edit.bold ? 700 : 400,
                fontStyle: edit.italic ? "italic" : "normal",
                width: effectiveWidthPt * zoom,
                // V1.0077: roomy default vertical space so paragraph editing
                // feels like a text editor, not a one-line input. Four
                // 1.2-line-height rows is enough to type a short paragraph
                // comfortably; the useLayoutEffect above grows it further
                // whenever scrollHeight > current height.
                minHeight: `${edit.size * zoom * 1.2 * 4}px`,
                wordBreak: "break-word",
                overflowWrap: "break-word",
                textAlign: edit.align ?? "left",
              }}
            />
          ) : (
            <input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitEdit();
                  e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setIsEditing(false);
                  setDraftText(edit.text);
                  e.currentTarget.blur();
                }
              }}
              data-testid="pending-text-input"
              className="block rounded-[2px] border border-[var(--color-accent)]/70 bg-transparent px-1 py-0.5 text-[#0b0b0e] caret-[var(--color-accent)] shadow-[0_0_0_1px_rgba(59,76,202,0.12)] focus:border-[var(--color-accent)] focus:outline-none"
              style={{
                fontSize: edit.size * zoom,
                fontFamily: "Helvetica, sans-serif",
                fontWeight: edit.bold ? 700 : 400,
                fontStyle: edit.italic ? "italic" : "normal",
                width: Math.max(120, draftText.length * edit.size * zoom * 0.55),
              }}
            />
          )}
        </div>
      ) : (
        <div
          ref={wrapperRef}
          className={
            "group relative rounded px-0.5 outline-none transition-colors " +
            // V1.0068: single chunky ring-2 selection treatment now that the
            // wrapper hugs the rendered text in both modes (inline-block +
            // maxWidth). Same visual for wrap-mode and single-line.
            (selected
              ? "ring-2 ring-[var(--color-accent)]"
              : "hover:ring-1 hover:ring-[var(--color-accent)]/40")
          }
          style={{
            fontSize: edit.size * zoom,
            // V1.0062: 1.2 line-height matches the same `* 1.2` factor
            // `drawWrappedText` uses for vertical line spacing at commit
            // time, so the on-screen wrap mirrors what gets baked.
            lineHeight: effectiveWidthPt != null ? 1.2 : 1,
            fontFamily: "Helvetica, sans-serif",
            // V1.0057: bold / italic toggled via ⌘B / ⌘I + the B/I buttons.
            // Mirrors how pdf-lib's matchStandardFont will pick the variant
            // at commit time (e.g. Helvetica → Helvetica-BoldOblique).
            fontWeight: edit.bold ? 700 : 400,
            fontStyle: edit.italic ? "italic" : "normal",
            color: "#0b0b0e",
            // V1.0068: wrapper hugs the rendered text — inline-block sizes
            // to the longest wrapped line; maxWidth enforces the wrap
            // boundary. V1.0069: a useLayoutEffect below measures the
            // wrapped line rects via Range API and pins `width` to the
            // longest line — `inline-block + max-width` alone sizes to
            // max-width when content exceeds it, leaving whitespace
            // between the rendered text and the wrapper's right edge.
            // V1.0069: `align` toggles CSS text-align so the on-screen
            // wrap matches what `drawWrappedText` will bake at commit.
            whiteSpace: effectiveWidthPt != null ? "pre-wrap" : "pre",
            wordBreak: effectiveWidthPt != null ? "break-word" : undefined,
            overflowWrap: effectiveWidthPt != null ? "break-word" : undefined,
            display: effectiveWidthPt != null ? "inline-block" : undefined,
            maxWidth: effectiveWidthPt != null ? effectiveWidthPt * zoom : undefined,
            textAlign: effectiveWidthPt != null ? (edit.align ?? "left") : undefined,
          }}
          title="Drag to move · Double-click to edit · ⌘B bold · ⌘I italic"
        >
          {edit.text}
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setDraftText(edit.text);
              setIsEditing(true);
            }}
            className={
              "absolute -top-3.5 left-0 h-4 items-center gap-0.5 rounded bg-[var(--panel-bg-raised)] px-1 text-[10px] text-[var(--muted)] shadow-sm " +
              (selected ? "flex" : "hidden group-hover:flex")
            }
            aria-label="Edit text"
          >
            <Edit2 className="h-2.5 w-2.5" strokeWidth={2} />
          </button>
          {/* V1.0075: format bar moved to the OUTER level (visible in both
              edit + read mode). Kept Edit pencil / Delete X / SE handle
              inside the read-mode wrapper since they only make sense
              there. */}
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              removePendingTextEdit(tabId, edit.id);
              setSelectedId(null);
            }}
            className={
              "absolute -top-3.5 right-0 h-4 items-center justify-center rounded bg-[var(--panel-bg-raised)] px-1 text-[10px] text-[var(--muted)] shadow-sm hover:text-[var(--color-destructive)] " +
              (selected ? "flex" : "hidden group-hover:flex")
            }
            aria-label="Remove text"
          >
            <X className="h-2.5 w-2.5" strokeWidth={2} />
          </button>
          {/* V1.0071: INNER SE handle — scales font size proportionally.
              Visually distinct from the outer frame handle: smaller
              (h-2.5 w-2.5), no white border, sits flush at the wrapper's
              bottom-right corner. The OUTER handle (data-handle="frame-se")
              is the larger blue square outside the wrap area; this one
              hugs the text. */}
          {selected && (
            <div
              role="button"
              tabIndex={-1}
              aria-label="Drag to resize font size"
              title="Drag to resize the text · the writing area handle is on the dashed frame"
              onPointerDown={onFontResizePointerDown}
              onPointerMove={onFontResizePointerMove}
              onPointerUp={onFontResizePointerUp}
              className="absolute -bottom-1 -right-1 h-2.5 w-2.5 cursor-nwse-resize rounded-sm bg-[var(--color-accent)] ring-1 ring-white shadow-sm"
              data-handle="font-se"
            />
          )}
        </div>
      )}
    </div>
  );
}

// V1.0070: typeable font-size input. Replaces the old read-only "14" span
// so users can type a size directly (Word / Pages convention) instead of
// click-spamming +/−. Local draft state lets the user backspace freely;
// onBlur or Enter commits with clamping to [6, 144]; Esc reverts.
function FontSizeInput({
  size,
  onCommit,
}: {
  size: number;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState<string>(() => String(Math.round(size)));
  // Re-sync when the upstream size changes (e.g., +/− buttons clicked).
  useEffect(() => {
    setDraft(String(Math.round(size)));
  }, [size]);
  const commit = () => {
    const n = Number.parseFloat(draft);
    if (!Number.isFinite(n)) {
      setDraft(String(Math.round(size)));
      return;
    }
    const clamped = Math.max(6, Math.min(144, n));
    if (Math.abs(clamped - size) < 0.01) {
      setDraft(String(Math.round(clamped)));
      return;
    }
    onCommit(clamped);
    setDraft(String(Math.round(clamped)));
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      value={draft}
      onChange={(e) => setDraft(e.target.value.replace(/[^\d.]/g, ""))}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          (e.currentTarget as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDraft(String(Math.round(size)));
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => (e.target as HTMLInputElement).select()}
      className="w-6 bg-transparent text-center text-[9px] tabular-nums text-[var(--muted)] focus:text-[var(--app-fg)] focus:outline-none"
      aria-label="Font size"
      title="Type a font size (6–144)"
      data-testid="font-size-input"
    />
  );
}
