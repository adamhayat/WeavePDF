import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, Crop, Check } from "lucide-react";
import { useDocumentStore, type PendingImageEdit } from "../../stores/document";
import { useUIStore } from "../../stores/ui";
import { bytesToBlob } from "../../../shared/buffers";

type Props = {
  pageNumber: number;
  zoom: number;
  pageHeightPx: number;
};

export function PendingImageLayer({ pageNumber, zoom, pageHeightPx }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
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
};

const MIN_SIZE_PT = 16;

function PendingImage({ edit, zoom, pageHeightPx, tabId }: PendingImageProps) {
  const updateEdit = useDocumentStore((s) => s.updatePendingImageEdit);
  const removeEdit = useDocumentStore((s) => s.removePendingImageEdit);
  const selected = useUIStore((s) => s.selectedPendingImageId === edit.id);
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

  const dragState = useRef<{
    mode: "move" | "nw" | "ne" | "sw" | "se";
    startClientX: number;
    startClientY: number;
    startXPt: number;
    startYPt: number;
    startWPt: number;
    startHPt: number;
    aspect: number;
  } | null>(null);

  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>, mode: "move" | "nw" | "ne" | "sw" | "se") => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      dragState.current = {
        mode,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startXPt: edit.xPt,
        startYPt: edit.yPt,
        startWPt: edit.widthPt,
        startHPt: edit.heightPt,
        aspect: edit.widthPt / edit.heightPt,
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setSelectedId(edit.id);
    },
    [edit.xPt, edit.yPt, edit.widthPt, edit.heightPt, edit.id, setSelectedId],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const s = dragState.current;
      if (!s) return;
      const dxPt = (e.clientX - s.startClientX) / zoom;
      const dyPt = (e.clientY - s.startClientY) / zoom;
      // Shift locks aspect ratio for corner handles.
      const lockAspect = e.shiftKey;

      if (s.mode === "move") {
        updateEdit(tabId, edit.id, {
          xPt: s.startXPt + dxPt,
          yPt: s.startYPt - dyPt, // Y flips
        });
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
    [zoom, updateEdit, tabId, edit.id],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!dragState.current) return;
    dragState.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }, []);

  // Keyboard: arrow nudge (1pt, Shift = 10pt), Delete/Backspace to remove.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        updateEdit(tabId, edit.id, { yPt: edit.yPt + step });
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        updateEdit(tabId, edit.id, { yPt: edit.yPt - step });
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        updateEdit(tabId, edit.id, { xPt: edit.xPt - step });
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
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
  }, [selected, edit.xPt, edit.yPt, edit.id, tabId, updateEdit, removeEdit, setSelectedId]);

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

  return (
    <div
      className="absolute z-20"
      style={{ left: leftPx, top: topPx, width: widthPx, height: heightPx }}
      data-testid="pending-image"
      data-edit-id={edit.id}
      data-pending-element="image"
      onPointerDown={
        cropping
          ? cropPointerDown
          : (e) => {
              // Stop propagation so Viewer's background-click deselect
              // doesn't immediately undo the selection we're about to make.
              e.stopPropagation();
              setSelectedId(edit.id);
              startDrag(e, "move");
            }
      }
      onPointerMove={cropping ? cropPointerMove : onPointerMove}
      onPointerUp={cropping ? cropPointerUp : onPointerUp}
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
        style={{ cursor: cropping ? "crosshair" : "move" }}
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

