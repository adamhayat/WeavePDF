import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, Crop, Check, RotateCw, FlipHorizontal2, FlipVertical2, Replace, Square, Layers2 } from "lucide-react";
import { useDocumentStore, type PendingImageEdit } from "../../stores/document";
import { useUIStore } from "../../stores/ui";
import { arrangeMenuItems, usePageBuried, usePageLayerRanks } from "./layering";
import { bytesToBlob } from "../../../shared/buffers";
import { beginGroupMove, endGroupMove, followGroupMove } from "../../lib/group-move";
import { resolveCrossPageTopLeft } from "../../lib/cross-page-drag";

type Props = {
  pageNumber: number;
  zoom: number;
  pageHeightPx: number;
  /** V1.0068: page dimensions in PDF points + global Margins toggle.
   *  Used to clamp drag-move so the image stays within the active margin
   *  rectangle when margins are enabled. */
  pageWidthPt: number;
  pageHeightPt: number;
};

export function PendingImageLayer({ pageNumber, zoom, pageHeightPx, pageWidthPt, pageHeightPt }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const marginsEnabled = useUIStore((s) => s.marginsEnabled);
  const ranks = usePageLayerRanks(pageNumber);
  const buried = usePageBuried(pageNumber);
  if (!activeTab) return null;

  const edits = activeTab.pendingImageEdits.filter((e) => e.page === pageNumber);
  if (edits.length === 0) return null;

  return (
    <>
      {edits.map((edit) => (
        <PendingImage
          key={edit.id}
          edit={edit}
          zoom={zoom}
          pageHeightPx={pageHeightPx}
          tabId={activeTab.id}
          pageWidthPt={pageWidthPt}
          pageHeightPt={pageHeightPt}
          marginsEnabled={marginsEnabled}
          layer={ranks.get(edit.id) ?? 1}
          buried={buried.has(edit.id)}
        />
      ))}
    </>
  );
}

type PendingImageProps = {
  edit: PendingImageEdit;
  zoom: number;
  pageHeightPx: number;
  tabId: string;
  pageWidthPt: number;
  pageHeightPt: number;
  marginsEnabled: boolean;
  /** V1.0125: stacking rank on the page (CSS z-index) — see layering.ts. */
  layer: number;
  /** V1.0125: hidden under a whiteout/redact above it — takes no clicks. */
  buried: boolean;
};

const MIN_SIZE_PT = 16;
const PAGE_MARGIN_PT = 36;

function PendingImage({
  edit,
  zoom,
  pageHeightPx,
  tabId,
  pageWidthPt,
  pageHeightPt,
  marginsEnabled,
  layer,
  buried,
}: PendingImageProps) {
  const updateEdit = useDocumentStore((s) => s.updatePendingImageEdit);
  const removeEdit = useDocumentStore((s) => s.removePendingImageEdit);
  const pushUndoStep = useDocumentStore((s) => s.pushUndoStep);
  // V1.0134: selected = the primary OR a member of a shift-click group.
  const selected = useUIStore((s) => s.selectedPendingImageId === edit.id || s.groupSelectedIds.includes(edit.id));
  const setSelectedId = useUIStore((s) => s.setSelectedPendingImage);
  // Crop sub-mode: user draws a rect on the image, Apply crops the bytes
  // and resizes the overlay; Cancel exits without changes.
  const [cropping, setCropping] = useState(false);
  const [cropRect, setCropRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const cropStart = useRef<{ x: number; y: number } | null>(null);

  const objectUrl = useMemo(
    () => URL.createObjectURL(bytesToBlob(edit.bytes, edit.mime)),
    [edit.bytes, edit.mime],
  );

  useEffect(() => {
    return () => URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  // Position: pdf-lib (x, y) is the bottom-left corner. Convert to top-left DOM.
  const leftPx = edit.xPt * zoom;
  const topPx = pageHeightPx - (edit.yPt + edit.heightPt) * zoom;
  const widthPx = edit.widthPt * zoom;
  const heightPx = edit.heightPt * zoom;

  const addPendingImageEdit = useDocumentStore((s) => s.addPendingImageEdit);
  const dragState = useRef<{
    mode: "move" | "nw" | "ne" | "sw" | "se";
    startClientX: number;
    startClientY: number;
    startXPt: number;
    startYPt: number;
    startWPt: number;
    startHPt: number;
    currentPage: number;
    pointerOffsetXPx: number;
    pointerOffsetYPx: number;
    aspect: number;
    /** V1.0070: option-drag clone target (defaults to edit.id). */
    dragEditId: string;
    cleanup?: () => void;
  } | null>(null);

  const finishDrag = useCallback((pointerId?: number, captureTarget?: HTMLElement | null) => {
    const s = dragState.current;
    if (!s) return;
    s.cleanup?.();
    endGroupMove(edit.id);
    dragState.current = null;
    if (pointerId != null && captureTarget) {
      try {
        captureTarget.releasePointerCapture(pointerId);
      } catch {
        /* already released */
      }
    }
  }, [edit.id]);

  const applyPointerMove = useCallback(
    (clientX: number, clientY: number, shiftKey: boolean) => {
      const s = dragState.current;
      if (!s) return;
      const dxPt = (clientX - s.startClientX) / zoom;
      const dyPt = (clientY - s.startClientY) / zoom;
      // Shift locks aspect ratio for corner handles.
      const lockAspect = shiftKey;

      if (s.mode === "move") {
        const target = resolveCrossPageTopLeft({
          currentPage: s.currentPage,
          clientX,
          clientY,
          zoom,
          pointerOffsetXPx: s.pointerOffsetXPx,
          pointerOffsetYPx: s.pointerOffsetYPx,
          widthPt: s.startWPt,
          heightPt: s.startHPt,
          marginsEnabled,
        });
        let newX = s.startXPt + dxPt;
        let newY = s.startYPt - dyPt; // Y flips
        let nextPage = s.currentPage;
        if (target) {
          newX = target.xPt;
          newY = target.yPt;
          nextPage = target.page;
        } else {
          const m = marginsEnabled ? PAGE_MARGIN_PT : 0;
          newX = Math.max(m, Math.min(pageWidthPt - m - s.startWPt, newX));
          newY = Math.max(m, Math.min(pageHeightPt - m - s.startHPt, newY));
        }
        s.currentPage = nextPage;
        // V1.0070: option-drag targets the clone via dragEditId.
        updateEdit(tabId, s.dragEditId, { page: nextPage, xPt: newX, yPt: newY });
        followGroupMove(s.dragEditId, { x: newX, y: newY });
        return;
      }

      // Resize handles. DOM corner → PDF-space corner:
      //   nw = top-left DOM = upper-left of box; PDF y + h changes, x changes
      //   ne = top-right DOM; PDF y + h changes, w changes
      //   sw = bottom-left DOM = PDF y & x change, w changes
      //   se = bottom-right DOM = PDF w & h change (y stays)
      let newX = s.startXPt;
      let newY = s.startYPt;
      let newW = s.startWPt;
      let newH = s.startHPt;

      if (s.mode === "nw") {
        newX = s.startXPt + dxPt;
        newW = s.startWPt - dxPt;
        newH = s.startHPt - dyPt;
      } else if (s.mode === "ne") {
        newW = s.startWPt + dxPt;
        newH = s.startHPt - dyPt;
      } else if (s.mode === "sw") {
        newX = s.startXPt + dxPt;
        newW = s.startWPt - dxPt;
        newY = s.startYPt - dyPt;
        newH = s.startHPt + dyPt;
      } else if (s.mode === "se") {
        newW = s.startWPt + dxPt;
        newY = s.startYPt - dyPt;
        newH = s.startHPt + dyPt;
      }

      if (lockAspect) {
        // Preserve aspect ratio based on width, adjusting height and
        // nudging y so the corner anchor stays put.
        const ratio = s.aspect;
        const prevH = newH;
        newH = newW / ratio;
        // If the move anchored the top of the box (nw/ne), pull y to
        // compensate for the height delta so top edge stays fixed.
        if (s.mode === "sw" || s.mode === "se") {
          newY -= newH - prevH;
        }
      }

      if (newW < MIN_SIZE_PT || newH < MIN_SIZE_PT) return;

      updateEdit(tabId, edit.id, {
        xPt: newX,
        yPt: newY,
        widthPt: newW,
        heightPt: newH,
      });
    },
    [zoom, updateEdit, tabId, edit.id, marginsEnabled, pageWidthPt, pageHeightPt],
  );

  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>, mode: "move" | "nw" | "ne" | "sw" | "se") => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      pushUndoStep(tabId);
      // V1.0070: option-drag duplicates ONLY for the move mode (cloning
      // mid-resize is confusing). Resize handles always target the
      // original edit.
      let dragEditId = edit.id;
      if (mode === "move" && e.altKey) {
        // V1.0125: the clone is a NEW element — it gets its own (top) layer.
        const { id: _unused, createdAt: _c, z: _z, ...rest } = edit;
        void _unused; void _c; void _z;
        dragEditId = addPendingImageEdit(tabId, rest);
        setSelectedId(dragEditId);
      }
      const target = e.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      const handleWindowMove = (ev: PointerEvent) => {
        if (!dragState.current) return;
        ev.preventDefault();
        applyPointerMove(ev.clientX, ev.clientY, ev.shiftKey);
      };
      const handleWindowUp = (ev: PointerEvent) => finishDrag(ev.pointerId, target);
      if (mode === "move") {
        window.addEventListener("pointermove", handleWindowMove, { capture: true });
        window.addEventListener("pointerup", handleWindowUp, { capture: true, once: true });
        window.addEventListener("pointercancel", handleWindowUp, { capture: true, once: true });
      }
      dragState.current = {
        mode,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startXPt: edit.xPt,
        startYPt: edit.yPt,
        startWPt: edit.widthPt,
        startHPt: edit.heightPt,
        currentPage: edit.page,
        pointerOffsetXPx: e.clientX - rect.left,
        pointerOffsetYPx: e.clientY - rect.top,
        aspect: edit.widthPt / edit.heightPt,
        dragEditId,
        cleanup: () => {
          window.removeEventListener("pointermove", handleWindowMove, true);
          window.removeEventListener("pointerup", handleWindowUp, true);
          window.removeEventListener("pointercancel", handleWindowUp, true);
        },
      };
      target.setPointerCapture(e.pointerId);
      // setSelectedId is handled above for option-drag; for normal drag,
      // select the original.
      if (!e.altKey || mode !== "move") setSelectedId(edit.id);
      // V1.0134: the other members of a multi-selection follow this drag.
      if (mode === "move" && !e.altKey) beginGroupMove(tabId, edit.id);
    },
    [edit, setSelectedId, pushUndoStep, tabId, addPendingImageEdit, applyPointerMove, finishDrag],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      applyPointerMove(e.clientX, e.clientY, e.shiftKey);
    },
    [applyPointerMove],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    finishDrag(e.pointerId, e.currentTarget as HTMLElement);
  }, [finishDrag]);

  // Keyboard: arrow nudge (1pt, Shift = 10pt), Delete/Backspace to remove.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) {
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        pushUndoStep(tabId);
        updateEdit(tabId, edit.id, { yPt: edit.yPt + step });
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        pushUndoStep(tabId);
        updateEdit(tabId, edit.id, { yPt: edit.yPt - step });
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        pushUndoStep(tabId);
        updateEdit(tabId, edit.id, { xPt: edit.xPt - step });
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        pushUndoStep(tabId);
        updateEdit(tabId, edit.id, { xPt: edit.xPt + step });
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        removeEdit(tabId, edit.id);
        setSelectedId(null);
      } else if (e.key === "Escape") {
        setSelectedId(null);
      }
    };
    // Capture phase on window so we run before react-hotkeys-hook's document
    // listener (which would otherwise page-nav on arrow keys).
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [selected, edit.xPt, edit.yPt, edit.id, tabId, updateEdit, removeEdit, setSelectedId, pushUndoStep]);

  const cropPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    cropStart.current = { x, y };
    setCropRect({ x, y, w: 0, h: 0 });
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
  };
  const cropPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!cropStart.current) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const cx = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const cy = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    setCropRect({
      x: Math.min(cropStart.current.x, cx),
      y: Math.min(cropStart.current.y, cy),
      w: Math.abs(cx - cropStart.current.x),
      h: Math.abs(cy - cropStart.current.y),
    });
  };
  const cropPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!cropStart.current) return;
    cropStart.current = null;
    try {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  const applyCrop = async () => {
    if (!cropRect || cropRect.w < 4 || cropRect.h < 4) {
      setCropping(false);
      setCropRect(null);
      return;
    }
    // cropRect is in the overlay's CSS pixels (widthPx × heightPx). Convert
    // to a fraction of the overlay, then to natural image pixels for canvas.
    const url = URL.createObjectURL(bytesToBlob(edit.bytes, edit.mime));
    try {
      const img = new Image();
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("crop: image decode failed"));
        img.src = url;
      });
      const naturalW = img.naturalWidth;
      const naturalH = img.naturalHeight;
      const sx = (cropRect.x / widthPx) * naturalW;
      const sy = (cropRect.y / heightPx) * naturalH;
      const sw = (cropRect.w / widthPx) * naturalW;
      const sh = (cropRect.h / heightPx) * naturalH;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sw));
      canvas.height = Math.max(1, Math.round(sh));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas 2d context unavailable");
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      const outBlob = await new Promise<Blob>((res, rej) => {
        canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png");
      });
      const newBytes = new Uint8Array(await outBlob.arrayBuffer());

      // Reposition + resize the overlay so the crop stays visually in place:
      // the cropped region's top-left in PDF coords becomes the new anchor.
      const fracX = cropRect.x / widthPx;
      const fracY = cropRect.y / heightPx;
      const fracW = cropRect.w / widthPx;
      const fracH = cropRect.h / heightPx;
      const newWidthPt = edit.widthPt * fracW;
      const newHeightPt = edit.heightPt * fracH;
      const newXPt = edit.xPt + edit.widthPt * fracX;
      // yPt is the bottom-left in PDF coords; the crop anchors from the top
      // visually, so subtract (fracY + fracH) from height and add to base.
      const newYPt = edit.yPt + edit.heightPt * (1 - fracY - fracH);

      updateEdit(tabId, edit.id, {
        bytes: newBytes,
        mime: "image/png",
        widthPt: newWidthPt,
        heightPt: newHeightPt,
        xPt: newXPt,
        yPt: newYPt,
      });
    } finally {
      URL.revokeObjectURL(url);
      setCropping(false);
      setCropRect(null);
    }
  };

  // V1.0057: right-click → "Align to page" + Delete.
  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const align = useDocumentStore.getState().alignPendingElement;
    useUIStore.getState().openContextMenu(e.clientX, e.clientY, [
      { kind: "item", label: "Align to left margin", onClick: () => void align(tabId, "image", edit.id, "left") },
      { kind: "item", label: "Center horizontally", onClick: () => void align(tabId, "image", edit.id, "center-h") },
      { kind: "item", label: "Align to right margin", onClick: () => void align(tabId, "image", edit.id, "right") },
      { kind: "separator" },
      { kind: "item", label: "Align to top margin", onClick: () => void align(tabId, "image", edit.id, "top") },
      { kind: "item", label: "Center vertically", onClick: () => void align(tabId, "image", edit.id, "center-v") },
      { kind: "item", label: "Align to bottom margin", onClick: () => void align(tabId, "image", edit.id, "bottom") },
      { kind: "separator" },
      ...arrangeMenuItems(tabId, edit.id),
      { kind: "separator" },
      {
        kind: "item",
        label: "Delete",
        danger: true,
        onClick: () => {
          removeEdit(tabId, edit.id);
          setSelectedId(null);
        },
      },
    ]);
  };

  return (
    <div
      className="absolute"
      style={{ left: leftPx, top: topPx, width: widthPx, height: heightPx, zIndex: layer, pointerEvents: buried ? "none" : "auto" }}
      data-testid="pending-image"
      data-buried={buried || undefined}
      data-layer={layer}
      data-edit-id={edit.id}
      data-pending-element="image"
      data-page-number={edit.page}
      onPointerDown={
        cropping
          ? cropPointerDown
          : (e) => {
              // Stop propagation so Viewer's background-click deselect
              // doesn't immediately undo the selection we're about to make.
              e.stopPropagation();
              // V1.0134: shift-click adds to / drops from the multi-selection.
              if (e.shiftKey && !e.altKey) {
                useUIStore.getState().toggleGroupSelect("image", edit.id);
                return;
              }
              setSelectedId(edit.id);
              startDrag(e, "move");
            }
      }
      onPointerMove={cropping ? cropPointerMove : onPointerMove}
      onPointerUp={cropping ? cropPointerUp : onPointerUp}
      onContextMenu={onContextMenu}
    >
      <img
        src={objectUrl}
        alt=""
        draggable={false}
        className={
          "h-full w-full select-none " +
          (cropping
            ? "outline outline-2 outline-dashed outline-[var(--color-accent)]"
            : selected
              ? "outline outline-2 outline-[var(--color-accent)]"
              : "hover:ring-2 hover:ring-[var(--color-accent)]/40")
        }
        style={{
          cursor: cropping ? "crosshair" : "move",
          // V1.0090: live preview of image format options. CSS rotation
          // direction matches pdf-lib's bake direction visually (both CW
          // positive), so a user-facing "rotation" value is consistent
          // between preview and printed output. Flip via scaleX/scaleY
          // sign-flip; opacity is straight-through.
          opacity: edit.opacity ?? 1,
          transform: [
            edit.rotation ? `rotate(${edit.rotation}deg)` : null,
            edit.flipH ? "scaleX(-1)" : null,
            edit.flipV ? "scaleY(-1)" : null,
          ].filter(Boolean).join(" ") || undefined,
          // V1.0091: live border + drop-shadow preview. Width in PDF
          // points scales 1:1 with the rendered px since pendingImage
          // positions are zoom-aware; the visible thickness matches the
          // bake. Drop shadow flips the Y sign because CSS box-shadow
          // uses screen-down-positive Y while pdf-lib uses screen-up-
          // positive Y — both store the same negated value internally.
          border: edit.border
            ? `${edit.border.widthPt * zoom}px solid rgb(${Math.round(edit.border.color.r * 255)}, ${Math.round(edit.border.color.g * 255)}, ${Math.round(edit.border.color.b * 255)})`
            : undefined,
          boxSizing: edit.border ? "border-box" : undefined,
          filter: edit.dropShadow
            ? `drop-shadow(${edit.dropShadow.offsetXPt * zoom}px ${(-edit.dropShadow.offsetYPt) * zoom}px ${edit.dropShadow.blurPt * zoom}px rgba(${Math.round(edit.dropShadow.color.r * 255)}, ${Math.round(edit.dropShadow.color.g * 255)}, ${Math.round(edit.dropShadow.color.b * 255)}, ${edit.dropShadow.opacity}))`
            : undefined,
        }}
      />
      {cropping && cropRect && cropRect.w > 0 && cropRect.h > 0 && (
        <>
          <div
            className="pointer-events-none absolute inset-0 bg-black/40"
            style={{
              clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 ${cropRect.y}px, ${cropRect.x}px ${cropRect.y}px, ${cropRect.x}px ${cropRect.y + cropRect.h}px, ${cropRect.x + cropRect.w}px ${cropRect.y + cropRect.h}px, ${cropRect.x + cropRect.w}px ${cropRect.y}px, 0 ${cropRect.y}px)`,
            }}
          />
          <div
            className="pointer-events-none absolute border-2 border-[var(--color-accent)]"
            style={{
              left: cropRect.x,
              top: cropRect.y,
              width: cropRect.w,
              height: cropRect.h,
            }}
          />
        </>
      )}
      {selected && !cropping && (
        <>
          {/* V1.0090: floating image format toolbar. Anchored above the
              image, mirroring the V1.0075 pending-text format bar.
              Hosts the agent's must-haves: rotation (90° step), flip
              H, flip V, opacity slider, replace. Crop already lives as
              its own button on the side; kept there for back-compat
              with users who learned the V1.0xx UX. z-50 sits above all
              page-overlay elements per the V1.0090 fix in
              PendingTextLayer. */}
          <div
            data-testid="pending-image-format-bar"
            className="absolute -top-9 left-1/2 z-50 flex h-7 -translate-x-1/2 items-center gap-1 rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg-raised)] px-1.5 shadow-md"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                pushUndoStep(tabId);
                const next = ((edit.rotation ?? 0) + 90) % 360;
                updateEdit(tabId, edit.id, { rotation: next });
              }}
              className="flex h-5 w-5 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]"
              title="Rotate 90° clockwise"
              data-testid="image-rotate"
            >
              <RotateCw className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                pushUndoStep(tabId);
                updateEdit(tabId, edit.id, { flipH: !edit.flipH });
              }}
              className={
                "flex h-5 w-5 items-center justify-center rounded " +
                (edit.flipH ? "text-[var(--color-accent)]" : "text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]")
              }
              title="Flip horizontal"
              data-testid="image-flip-h"
            >
              <FlipHorizontal2 className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                pushUndoStep(tabId);
                updateEdit(tabId, edit.id, { flipV: !edit.flipV });
              }}
              className={
                "flex h-5 w-5 items-center justify-center rounded " +
                (edit.flipV ? "text-[var(--color-accent)]" : "text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]")
              }
              title="Flip vertical"
              data-testid="image-flip-v"
            >
              <FlipVertical2 className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
            <div className="mx-0.5 h-3.5 w-px bg-[var(--panel-border)]" />
            <span className="text-[10px] text-[var(--muted)]">Opacity</span>
            <input
              type="range"
              min={10}
              max={100}
              step={1}
              value={Math.round((edit.opacity ?? 1) * 100)}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => {
                updateEdit(tabId, edit.id, { opacity: Number(e.target.value) / 100 });
              }}
              className="h-4 w-20 accent-[var(--color-accent)]"
              data-testid="image-opacity"
              title="Opacity"
            />
            <div className="mx-0.5 h-3.5 w-px bg-[var(--panel-border)]" />
            {/* V1.0091: Border toggle. Click to toggle a default 1pt
                black border. Re-clicking removes the border. Custom
                width / color is a follow-up. */}
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                pushUndoStep(tabId);
                if (edit.border) {
                  updateEdit(tabId, edit.id, { border: undefined });
                } else {
                  updateEdit(tabId, edit.id, {
                    border: { widthPt: 1, color: { r: 0.05, g: 0.05, b: 0.1 } },
                  });
                }
              }}
              className={
                "flex h-5 w-5 items-center justify-center rounded " +
                (edit.border ? "text-[var(--color-accent)]" : "text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]")
              }
              title="Toggle 1pt border"
              data-testid="image-border"
            >
              <Square className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
            {/* V1.0091: Drop-shadow toggle. Click to toggle a default
                soft-shadow preset (3pt offset down-right, 4pt blur,
                40% black). Re-clicking removes the shadow. */}
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                pushUndoStep(tabId);
                if (edit.dropShadow) {
                  updateEdit(tabId, edit.id, { dropShadow: undefined });
                } else {
                  updateEdit(tabId, edit.id, {
                    dropShadow: {
                      offsetXPt: 3,
                      // PDF Y goes UP; user-visual convention: shadow
                      // drops DOWN. Negate offsetY so the toolbar's
                      // default looks like a natural drop-shadow.
                      offsetYPt: -3,
                      blurPt: 4,
                      opacity: 0.4,
                      color: { r: 0, g: 0, b: 0 },
                    },
                  });
                }
              }}
              className={
                "flex h-5 w-5 items-center justify-center rounded " +
                (edit.dropShadow ? "text-[var(--color-accent)]" : "text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]")
              }
              title="Toggle drop shadow"
              data-testid="image-shadow"
            >
              <Layers2 className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
            <div className="mx-0.5 h-3.5 w-px bg-[var(--panel-border)]" />
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={async (e) => {
                e.stopPropagation();
                // Replace: open file picker, swap bytes in place. Keeps
                // position + size + format options unchanged.
                const result = await window.weavepdf.openFileDialog({
                  title: "Replace image",
                  filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
                  multi: false,
                });
                if (result.canceled || result.files.length === 0) return;
                const file = result.files[0];
                const isPng = file.name.toLowerCase().endsWith(".png");
                pushUndoStep(tabId);
                updateEdit(tabId, edit.id, {
                  bytes: new Uint8Array(file.data),
                  mime: isPng ? "image/png" : "image/jpeg",
                });
              }}
              className="flex h-5 items-center gap-1 rounded px-1.5 text-[10px] text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]"
              title="Replace image…"
              data-testid="image-replace"
            >
              <Replace className="h-3 w-3" strokeWidth={2} />
              <span>Replace</span>
            </button>
          </div>
          <ResizeHandle pos="nw" onDown={(e) => startDrag(e, "nw")} onMove={onPointerMove} onUp={onPointerUp} />
          <ResizeHandle pos="ne" onDown={(e) => startDrag(e, "ne")} onMove={onPointerMove} onUp={onPointerUp} />
          <ResizeHandle pos="sw" onDown={(e) => startDrag(e, "sw")} onMove={onPointerMove} onUp={onPointerUp} />
          <ResizeHandle pos="se" onDown={(e) => startDrag(e, "se")} onMove={onPointerMove} onUp={onPointerUp} />
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setCropping(true);
              setCropRect(null);
            }}
            className="absolute -left-7 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--panel-bg-raised)] text-[var(--muted)] shadow-md hover:text-[var(--color-accent)]"
            aria-label="Crop image"
            title="Crop"
          >
            <Crop className="h-3 w-3" strokeWidth={2} />
          </button>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              removeEdit(tabId, edit.id);
              setSelectedId(null);
            }}
            className="absolute -right-7 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--panel-bg-raised)] text-[var(--muted)] shadow-md hover:text-[var(--color-destructive)]"
            aria-label="Delete image"
          >
            <X className="h-3 w-3" strokeWidth={2.5} />
          </button>
        </>
      )}
      {cropping && (
        <div className="absolute -top-10 left-0 flex items-center gap-1 rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg-raised)] p-1 shadow-lg">
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              void applyCrop();
            }}
            disabled={!cropRect || cropRect.w < 4 || cropRect.h < 4}
            className="flex items-center gap-1 rounded bg-[var(--color-accent)] px-2 py-1 text-[11px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
            title="Apply crop"
          >
            <Check className="h-3 w-3" strokeWidth={2.5} /> Apply
          </button>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setCropping(false);
              setCropRect(null);
            }}
            className="rounded px-2 py-1 text-[11px] text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

type HandlePos = "nw" | "ne" | "sw" | "se";

function ResizeHandle({
  pos,
  onDown,
  onMove,
  onUp,
}: {
  pos: HandlePos;
  onDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onUp: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const position: Record<HandlePos, string> = {
    nw: "left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize",
    ne: "right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize",
    sw: "left-0 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize",
    se: "right-0 bottom-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize",
  };
  return (
    <div
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      className={`absolute h-3 w-3 rounded-sm border border-white bg-[var(--color-accent)] shadow-sm ${position[pos]}`}
      data-handle={pos}
    />
  );
}
