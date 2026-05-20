import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useDocumentStore, type PendingShapeEdit } from "../../stores/document";
import { useUIStore } from "../../stores/ui";
import { resolveCrossPageTopLeft } from "../../lib/cross-page-drag";

type Props = {
  pageNumber: number;
  zoom: number;
  pageHeightPx: number;
  /** V1.0068: page dims in PDF points. With the global Margins toggle,
   *  drag-move clamps so the shape's bounding box stays inside the
   *  printable rectangle. */
  pageWidthPt: number;
  pageHeightPt: number;
};

const MIN_SIZE_PT = 8;
const PAGE_MARGIN_PT = 36;

export function PendingShapeLayer({ pageNumber, zoom, pageHeightPx, pageWidthPt, pageHeightPt }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const marginsEnabled = useUIStore((s) => s.marginsEnabled);
  if (!activeTab) return null;
  const shapes = activeTab.pendingShapeEdits.filter((e) => e.page === pageNumber);
  if (shapes.length === 0) return null;
  return (
    <>
      {shapes.map((shape) => (
        <PendingShape
          key={shape.id}
          shape={shape}
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

type ShapeProps = {
  shape: PendingShapeEdit;
  zoom: number;
  pageHeightPx: number;
  tabId: string;
  pageWidthPt: number;
  pageHeightPt: number;
  marginsEnabled: boolean;
};

function PendingShape(props: ShapeProps) {
  const { shape } = props;
  switch (shape.kind) {
    case "rect":
    case "ellipse":
    case "highlight":
    case "whiteout":
    case "redact":
      return <BoxShape {...props} shape={shape} />;
    case "line":
    case "arrow":
      return <LineShape {...props} shape={shape} />;
    case "freehand":
      return <FreehandShape {...props} shape={shape} />;
    case "sticky":
      return <StickyShape {...props} shape={shape} />;
  }
}

// ─── Box-model shapes (rect / ellipse / highlight / whiteout / redact) ───

type BoxKind = Extract<PendingShapeEdit, { kind: "rect" | "ellipse" | "highlight" | "whiteout" | "redact" }>;

function BoxShape({ shape, zoom, pageHeightPx, tabId, pageWidthPt, pageHeightPt, marginsEnabled }: ShapeProps & { shape: BoxKind }) {
  const updateShape = useDocumentStore((s) => s.updatePendingShapeEdit);
  const removeShape = useDocumentStore((s) => s.removePendingShapeEdit);
  const pushUndoStep = useDocumentStore((s) => s.pushUndoStep);
  const selected = useUIStore((s) => s.selectedPendingShapeId === shape.id);
  const setSelectedId = useUIStore((s) => s.setSelectedPendingShape);

  const leftPx = shape.xPt * zoom;
  const topPx = pageHeightPx - (shape.yPt + shape.heightPt) * zoom;
  const widthPx = shape.widthPt * zoom;
  const heightPx = shape.heightPt * zoom;

  const addPendingShapeEdit = useDocumentStore((s) => s.addPendingShapeEdit);
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
    /** V1.0070: option-drag clone target. */
    dragShapeId: string;
    cleanup?: () => void;
  } | null>(null);

  const finishDrag = useCallback((pointerId?: number, captureTarget?: HTMLElement | null) => {
    const s = dragState.current;
    if (!s) return;
    s.cleanup?.();
    dragState.current = null;
    if (pointerId != null && captureTarget) {
      try {
        captureTarget.releasePointerCapture(pointerId);
      } catch {
        /* already released */
      }
    }
  }, []);

  const applyPointerMove = useCallback(
    (clientX: number, clientY: number, shiftKey: boolean) => {
      const s = dragState.current;
      if (!s) return;
      const dxPt = (clientX - s.startClientX) / zoom;
      const dyPt = (clientY - s.startClientY) / zoom;
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
        let newY = s.startYPt - dyPt;
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
        // V1.0070: option-drag targets the clone via dragShapeId.
        updateShape(tabId, s.dragShapeId, { page: nextPage, xPt: newX, yPt: newY });
        return;
      }
      let newX = s.startXPt;
      let newY = s.startYPt;
      let newW = s.startWPt;
      let newH = s.startHPt;
      if (s.mode === "nw") {
        newX = s.startXPt + dxPt; newW = s.startWPt - dxPt; newH = s.startHPt - dyPt;
      } else if (s.mode === "ne") {
        newW = s.startWPt + dxPt; newH = s.startHPt - dyPt;
      } else if (s.mode === "sw") {
        newX = s.startXPt + dxPt; newW = s.startWPt - dxPt;
        newY = s.startYPt - dyPt; newH = s.startHPt + dyPt;
      } else if (s.mode === "se") {
        newW = s.startWPt + dxPt;
        newY = s.startYPt - dyPt; newH = s.startHPt + dyPt;
      }
      // V1.0057: Shift locks aspect ratio. Mirrors PendingImageLayer's
      // V1.0023 behavior — pick whichever delta is larger (width or height),
      // then derive the other from the start ratio so corners scale
      // proportionally. The anchor (opposite corner) stays put, so we
      // recompute `newX` / `newY` from the resolved size.
      if (shiftKey) {
        const aspect = s.startWPt / s.startHPt;
        const wScale = newW / s.startWPt;
        const hScale = newH / s.startHPt;
        if (Math.abs(wScale - 1) > Math.abs(hScale - 1)) {
          newH = newW / aspect;
        } else {
          newW = newH * aspect;
        }
        // Re-pin so the dragged corner moves; the opposite corner stays.
        if (s.mode === "nw") {
          newX = s.startXPt + (s.startWPt - newW);
          newY = s.startYPt;
        } else if (s.mode === "ne") {
          newX = s.startXPt;
          newY = s.startYPt;
        } else if (s.mode === "sw") {
          newX = s.startXPt + (s.startWPt - newW);
          newY = s.startYPt - (newH - s.startHPt);
        } else if (s.mode === "se") {
          newX = s.startXPt;
          newY = s.startYPt - (newH - s.startHPt);
        }
      }
      if (newW < MIN_SIZE_PT || newH < MIN_SIZE_PT) return;
      updateShape(tabId, shape.id, { xPt: newX, yPt: newY, widthPt: newW, heightPt: newH });
    },
    [zoom, updateShape, tabId, shape.id, marginsEnabled, pageWidthPt, pageHeightPt],
  );

  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>, mode: "move" | "nw" | "ne" | "sw" | "se") => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      pushUndoStep(tabId);
      let dragShapeId = shape.id;
      if (mode === "move" && e.altKey) {
        const { id: _unused, ...rest } = shape;
        void _unused;
        dragShapeId = addPendingShapeEdit(tabId, rest);
        setSelectedId(dragShapeId);
      } else {
        setSelectedId(shape.id);
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
        startXPt: shape.xPt,
        startYPt: shape.yPt,
        startWPt: shape.widthPt,
        startHPt: shape.heightPt,
        currentPage: shape.page,
        pointerOffsetXPx: e.clientX - rect.left,
        pointerOffsetYPx: e.clientY - rect.top,
        dragShapeId,
        cleanup: () => {
          window.removeEventListener("pointermove", handleWindowMove, true);
          window.removeEventListener("pointerup", handleWindowUp, true);
          window.removeEventListener("pointercancel", handleWindowUp, true);
        },
      };
      target.setPointerCapture(e.pointerId);
    },
    [shape, setSelectedId, pushUndoStep, tabId, addPendingShapeEdit, applyPointerMove, finishDrag],
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

  useShapeKeyboard(selected, shape.id, tabId, {
    onNudge: (dx, dy) => updateShape(tabId, shape.id, { xPt: shape.xPt + dx, yPt: shape.yPt + dy }),
    onDelete: () => { removeShape(tabId, shape.id); setSelectedId(null); },
    onEscape: () => setSelectedId(null),
  });

  const openLinkForShape = useCallback((clientX: number, clientY: number) => {
    useUIStore.getState().setPendingLink({
      page: shape.page,
      rect: { x: shape.xPt, y: shape.yPt, width: shape.widthPt, height: shape.heightPt },
      screenX: clientX,
      screenY: clientY,
    });
  }, [shape.page, shape.xPt, shape.yPt, shape.widthPt, shape.heightPt]);

  const onContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedId(shape.id);
    useUIStore.getState().openContextMenu(e.clientX, e.clientY, [
      ...(shape.kind === "highlight"
        ? [
            {
              kind: "item" as const,
              label: "Add link…",
              onClick: () => openLinkForShape(e.clientX, e.clientY),
            },
            { kind: "separator" as const },
          ]
        : []),
      {
        kind: "item",
        label: "Delete",
        danger: true,
        onClick: () => {
          removeShape(tabId, shape.id);
          setSelectedId(null);
        },
      },
    ]);
  }, [openLinkForShape, removeShape, setSelectedId, shape.id, shape.kind, tabId]);

  // Visual style by kind.
  const fill =
    shape.kind === "highlight" ? "rgba(255, 230, 0, 0.4)"
      : shape.kind === "whiteout" ? "rgba(255, 255, 255, 0.95)"
      : shape.kind === "redact" ? "rgba(0, 0, 0, 0.95)"
      : "transparent";
  const strokeColor =
    shape.kind === "rect" || shape.kind === "ellipse"
      ? `rgb(${(shape.color.r * 255).toFixed(0)},${(shape.color.g * 255).toFixed(0)},${(shape.color.b * 255).toFixed(0)})`
      : "transparent";
  const strokeWidth =
    shape.kind === "rect" || shape.kind === "ellipse" ? shape.thickness * zoom : 0;

  return (
    <div
      className="absolute z-20"
      style={{ left: leftPx, top: topPx, width: widthPx, height: heightPx }}
      data-testid="pending-shape"
      data-pending-element="shape"
      data-shape-kind={shape.kind}
      data-shape-id={shape.id}
      data-page-number={shape.page}
      onPointerDown={(e) => { e.stopPropagation(); setSelectedId(shape.id); startDrag(e, "move"); }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={onContextMenu}
    >
      <div
        className={
          "h-full w-full select-none " +
          (selected ? "outline outline-2 outline-[var(--color-accent)]" : "hover:ring-2 hover:ring-[var(--color-accent)]/40")
        }
        style={{
          cursor: "move",
          background: fill,
          border: strokeWidth ? `${strokeWidth}px solid ${strokeColor}` : undefined,
          borderRadius: shape.kind === "ellipse" ? "50%" : 0,
          boxSizing: "border-box",
        }}
      />
      {selected && (
        <>
          <Handle pos="nw" onDown={(e) => startDrag(e, "nw")} onMove={onPointerMove} onUp={onPointerUp} />
          <Handle pos="ne" onDown={(e) => startDrag(e, "ne")} onMove={onPointerMove} onUp={onPointerUp} />
          <Handle pos="sw" onDown={(e) => startDrag(e, "sw")} onMove={onPointerMove} onUp={onPointerUp} />
          <Handle pos="se" onDown={(e) => startDrag(e, "se")} onMove={onPointerMove} onUp={onPointerUp} />
          <DeleteChip onClick={() => { removeShape(tabId, shape.id); setSelectedId(null); }} />
        </>
      )}
    </div>
  );
}

// ─── Line / Arrow ────────────────────────────────────────────────────────

type LineKind = Extract<PendingShapeEdit, { kind: "line" | "arrow" }>;

function LineShape({ shape, zoom, pageHeightPx, tabId, pageWidthPt, pageHeightPt, marginsEnabled }: ShapeProps & { shape: LineKind }) {
  const updateShape = useDocumentStore((s) => s.updatePendingShapeEdit);
  const removeShape = useDocumentStore((s) => s.removePendingShapeEdit);
  const pushUndoStep = useDocumentStore((s) => s.pushUndoStep);
  const selected = useUIStore((s) => s.selectedPendingShapeId === shape.id);
  const setSelectedId = useUIStore((s) => s.setSelectedPendingShape);

  // Bounding box for hit-testing + handle placement.
  const minX = Math.min(shape.fromX, shape.toX);
  const maxX = Math.max(shape.fromX, shape.toX);
  const minY = Math.min(shape.fromY, shape.toY);
  const maxY = Math.max(shape.fromY, shape.toY);
  const padPt = Math.max(8, shape.thickness * 2); // keep endpoints clickable
  const leftPx = (minX - padPt) * zoom;
  const topPx = pageHeightPx - (maxY + padPt) * zoom;
  const widthPx = (maxX - minX + padPt * 2) * zoom;
  const heightPx = (maxY - minY + padPt * 2) * zoom;

  // Local SVG coords (relative to the overlay div's top-left).
  const svgFromX = (shape.fromX - (minX - padPt)) * zoom;
  const svgFromY = (maxY + padPt - shape.fromY) * zoom;
  const svgToX = (shape.toX - (minX - padPt)) * zoom;
  const svgToY = (maxY + padPt - shape.toY) * zoom;

  const dragState = useRef<{
    mode: "move" | "from" | "to";
    startClientX: number;
    startClientY: number;
    startFromX: number;
    startFromY: number;
    startToX: number;
    startToY: number;
    currentPage: number;
    pointerOffsetXPx: number;
    pointerOffsetYPx: number;
    startBoxLeftPt: number;
    startBoxTopYPt: number;
    startBoxWidthPt: number;
    startBoxHeightPt: number;
    cleanup?: () => void;
  } | null>(null);

  const finishDrag = useCallback((pointerId?: number, captureTarget?: HTMLElement | null) => {
    const s = dragState.current;
    if (!s) return;
    s.cleanup?.();
    dragState.current = null;
    if (pointerId != null && captureTarget) {
      try { captureTarget.releasePointerCapture(pointerId); } catch { /* already released */ }
    }
  }, []);

  const applyPointerMove = useCallback(
    (clientX: number, clientY: number) => {
      const s = dragState.current;
      if (!s) return;
      const dxPt = (clientX - s.startClientX) / zoom;
      const dyPt = (clientY - s.startClientY) / zoom;
      if (s.mode === "move") {
        let txX = dxPt, txY = -dyPt;
        let nextPage = s.currentPage;
        const target = resolveCrossPageTopLeft({
          currentPage: s.currentPage,
          clientX,
          clientY,
          zoom,
          pointerOffsetXPx: s.pointerOffsetXPx,
          pointerOffsetYPx: s.pointerOffsetYPx,
          widthPt: s.startBoxWidthPt,
          heightPt: s.startBoxHeightPt,
          marginsEnabled,
        });
        if (target) {
          txX = target.xPt - s.startBoxLeftPt;
          txY = (target.pageHeightPt - target.topPt) - s.startBoxTopYPt;
          nextPage = target.page;
        } else {
          // V1.0069: always clamp to the page-edge or margin rectangle.
          const m = marginsEnabled ? PAGE_MARGIN_PT : 0;
          const minX = Math.min(s.startFromX, s.startToX);
          const maxX = Math.max(s.startFromX, s.startToX);
          const minY = Math.min(s.startFromY, s.startToY);
          const maxY = Math.max(s.startFromY, s.startToY);
          txX = Math.max(m - minX, Math.min(pageWidthPt - m - maxX, txX));
          txY = Math.max(m - minY, Math.min(pageHeightPt - m - maxY, txY));
        }
        s.currentPage = nextPage;
        updateShape(tabId, shape.id, {
          page: nextPage,
          fromX: s.startFromX + txX, fromY: s.startFromY + txY,
          toX: s.startToX + txX, toY: s.startToY + txY,
        });
      } else if (s.mode === "from") {
        updateShape(tabId, shape.id, {
          fromX: s.startFromX + dxPt, fromY: s.startFromY - dyPt,
        });
      } else {
        updateShape(tabId, shape.id, {
          toX: s.startToX + dxPt, toY: s.startToY - dyPt,
        });
      }
    },
    [zoom, updateShape, tabId, shape.id, marginsEnabled, pageWidthPt, pageHeightPt],
  );

  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>, mode: "move" | "from" | "to") => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      pushUndoStep(tabId);
      const target = e.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      const boxLeftPt = minX - padPt;
      const boxTopYPt = maxY + padPt;
      const boxWidthPt = maxX - minX + padPt * 2;
      const boxHeightPt = maxY - minY + padPt * 2;
      const handleWindowMove = (ev: PointerEvent) => {
        if (!dragState.current) return;
        ev.preventDefault();
        applyPointerMove(ev.clientX, ev.clientY);
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
        startFromX: shape.fromX, startFromY: shape.fromY,
        startToX: shape.toX, startToY: shape.toY,
        currentPage: shape.page,
        pointerOffsetXPx: e.clientX - rect.left,
        pointerOffsetYPx: e.clientY - rect.top,
        startBoxLeftPt: boxLeftPt,
        startBoxTopYPt: boxTopYPt,
        startBoxWidthPt: boxWidthPt,
        startBoxHeightPt: boxHeightPt,
        cleanup: () => {
          window.removeEventListener("pointermove", handleWindowMove, true);
          window.removeEventListener("pointerup", handleWindowUp, true);
          window.removeEventListener("pointercancel", handleWindowUp, true);
        },
      };
      target.setPointerCapture(e.pointerId);
      setSelectedId(shape.id);
    },
    [
      shape.fromX,
      shape.fromY,
      shape.toX,
      shape.toY,
      shape.page,
      shape.id,
      minX,
      maxX,
      minY,
      maxY,
      padPt,
      setSelectedId,
      pushUndoStep,
      tabId,
      applyPointerMove,
      finishDrag,
    ],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      applyPointerMove(e.clientX, e.clientY);
    },
    [applyPointerMove],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    finishDrag(e.pointerId, e.currentTarget as HTMLElement);
  }, [finishDrag]);

  useShapeKeyboard(selected, shape.id, tabId, {
    onNudge: (dx, dy) => updateShape(tabId, shape.id, {
      fromX: shape.fromX + dx, fromY: shape.fromY + dy,
      toX: shape.toX + dx, toY: shape.toY + dy,
    }),
    onDelete: () => { removeShape(tabId, shape.id); setSelectedId(null); },
    onEscape: () => setSelectedId(null),
  });

  const strokeColor = `rgb(${(shape.color.r * 255).toFixed(0)},${(shape.color.g * 255).toFixed(0)},${(shape.color.b * 255).toFixed(0)})`;
  const strokeWidth = shape.thickness * zoom;

  return (
    <div
      className="absolute z-20"
      style={{ left: leftPx, top: topPx, width: widthPx, height: heightPx }}
      data-testid="pending-shape"
      data-pending-element="shape"
      data-shape-kind={shape.kind}
      data-shape-id={shape.id}
      data-page-number={shape.page}
      onPointerDown={(e) => { e.stopPropagation(); setSelectedId(shape.id); startDrag(e, "move"); }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <svg width="100%" height="100%" style={{ overflow: "visible", pointerEvents: "none" }}>
        {shape.kind === "arrow" && (
          <defs>
            <marker
              id={`arrow-${shape.id}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
              markerUnits="strokeWidth"
            >
              <path d="M0,0 L10,5 L0,10 z" fill={strokeColor} />
            </marker>
          </defs>
        )}
        <line
          x1={svgFromX} y1={svgFromY} x2={svgToX} y2={svgToY}
          stroke={strokeColor} strokeWidth={strokeWidth} strokeLinecap="round"
          markerEnd={shape.kind === "arrow" ? `url(#arrow-${shape.id})` : undefined}
        />
        {/* Thicker invisible line for easier selection. */}
        <line
          x1={svgFromX} y1={svgFromY} x2={svgToX} y2={svgToY}
          stroke="transparent" strokeWidth={Math.max(strokeWidth + 6, 10)}
          style={{ pointerEvents: "stroke" }}
        />
        {selected && (
          <>
            <circle cx={svgFromX} cy={svgFromY} r={5} fill="var(--color-accent)" stroke="white" strokeWidth={1.5} style={{ cursor: "crosshair" }} />
            <circle cx={svgToX} cy={svgToY} r={5} fill="var(--color-accent)" stroke="white" strokeWidth={1.5} style={{ cursor: "crosshair" }} />
          </>
        )}
      </svg>
      {selected && (
        <>
          {/* Endpoint hitboxes — sit on top of the SVG circles for pointer grabbing. */}
          <div
            className="absolute h-4 w-4 rounded-full"
            style={{ left: svgFromX - 8, top: svgFromY - 8, cursor: "crosshair" }}
            onPointerDown={(e) => startDrag(e, "from")}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
          <div
            className="absolute h-4 w-4 rounded-full"
            style={{ left: svgToX - 8, top: svgToY - 8, cursor: "crosshair" }}
            onPointerDown={(e) => startDrag(e, "to")}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
          <DeleteChip
            onClick={() => { removeShape(tabId, shape.id); setSelectedId(null); }}
            style={{ left: (svgFromX + svgToX) / 2 + 10, top: Math.min(svgFromY, svgToY) - 18 }}
          />
        </>
      )}
    </div>
  );
}

// ─── Freehand draw ───────────────────────────────────────────────────────

type FreehandKind = Extract<PendingShapeEdit, { kind: "freehand" }>;

function FreehandShape({ shape, zoom, pageHeightPx, tabId, pageWidthPt, pageHeightPt, marginsEnabled }: ShapeProps & { shape: FreehandKind }) {
  const updateShape = useDocumentStore((s) => s.updatePendingShapeEdit);
  const removeShape = useDocumentStore((s) => s.removePendingShapeEdit);
  const pushUndoStep = useDocumentStore((s) => s.pushUndoStep);
  const selected = useUIStore((s) => s.selectedPendingShapeId === shape.id);
  const setSelectedId = useUIStore((s) => s.setSelectedPendingShape);

  // Compute bounding box over all points.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of shape.points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (shape.points.length === 0) return null;
  const padPt = Math.max(8, shape.thickness * 2);
  const leftPx = (minX - padPt) * zoom;
  const topPx = pageHeightPx - (maxY + padPt) * zoom;
  const widthPx = (maxX - minX + padPt * 2) * zoom;
  const heightPx = (maxY - minY + padPt * 2) * zoom;

  const pathD = shape.points
    .map((p, i) => {
      const sx = (p.x - (minX - padPt)) * zoom;
      const sy = (maxY + padPt - p.y) * zoom;
      return `${i === 0 ? "M" : "L"} ${sx} ${sy}`;
    })
    .join(" ");

  const dragState = useRef<{
    startClientX: number;
    startClientY: number;
    startPoints: Array<{ x: number; y: number }>;
    currentPage: number;
    pointerOffsetXPx: number;
    pointerOffsetYPx: number;
    startBoxLeftPt: number;
    startBoxTopYPt: number;
    startBoxWidthPt: number;
    startBoxHeightPt: number;
    cleanup?: () => void;
  } | null>(null);

  const finishDrag = useCallback((pointerId?: number, captureTarget?: HTMLElement | null) => {
    const s = dragState.current;
    if (!s) return;
    s.cleanup?.();
    dragState.current = null;
    if (pointerId != null && captureTarget) {
      try { captureTarget.releasePointerCapture(pointerId); } catch { /* already released */ }
    }
  }, []);

  const applyPointerMove = useCallback(
    (clientX: number, clientY: number) => {
      const s = dragState.current;
      if (!s) return;
      const dxPt = (clientX - s.startClientX) / zoom;
      const dyPt = (clientY - s.startClientY) / zoom;
      let txX = dxPt, txY = -dyPt;
      let nextPage = s.currentPage;
      const target = resolveCrossPageTopLeft({
        currentPage: s.currentPage,
        clientX,
        clientY,
        zoom,
        pointerOffsetXPx: s.pointerOffsetXPx,
        pointerOffsetYPx: s.pointerOffsetYPx,
        widthPt: s.startBoxWidthPt,
        heightPt: s.startBoxHeightPt,
        marginsEnabled,
      });
      if (target) {
        txX = target.xPt - s.startBoxLeftPt;
        txY = (target.pageHeightPt - target.topPt) - s.startBoxTopYPt;
        nextPage = target.page;
      } else if (s.startPoints.length > 0) {
        // V1.0069: always clamp to the page-edge or margin rectangle.
        const m = marginsEnabled ? PAGE_MARGIN_PT : 0;
        let mnX = Infinity, mxX = -Infinity, mnY = Infinity, mxY = -Infinity;
        for (const p of s.startPoints) {
          if (p.x < mnX) mnX = p.x;
          if (p.x > mxX) mxX = p.x;
          if (p.y < mnY) mnY = p.y;
          if (p.y > mxY) mxY = p.y;
        }
        txX = Math.max(m - mnX, Math.min(pageWidthPt - m - mxX, txX));
        txY = Math.max(m - mnY, Math.min(pageHeightPt - m - mxY, txY));
      }
      s.currentPage = nextPage;
      updateShape(tabId, shape.id, {
        page: nextPage,
        points: s.startPoints.map((p) => ({ x: p.x + txX, y: p.y + txY })),
      });
    },
    [zoom, updateShape, tabId, shape.id, marginsEnabled, pageWidthPt, pageHeightPt],
  );

  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      pushUndoStep(tabId);
      const target = e.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      const boxLeftPt = minX - padPt;
      const boxTopYPt = maxY + padPt;
      const boxWidthPt = maxX - minX + padPt * 2;
      const boxHeightPt = maxY - minY + padPt * 2;
      const handleWindowMove = (ev: PointerEvent) => {
        if (!dragState.current) return;
        ev.preventDefault();
        applyPointerMove(ev.clientX, ev.clientY);
      };
      const handleWindowUp = (ev: PointerEvent) => finishDrag(ev.pointerId, target);
      window.addEventListener("pointermove", handleWindowMove, { capture: true });
      window.addEventListener("pointerup", handleWindowUp, { capture: true, once: true });
      window.addEventListener("pointercancel", handleWindowUp, { capture: true, once: true });
      dragState.current = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startPoints: shape.points.map((p) => ({ ...p })),
        currentPage: shape.page,
        pointerOffsetXPx: e.clientX - rect.left,
        pointerOffsetYPx: e.clientY - rect.top,
        startBoxLeftPt: boxLeftPt,
        startBoxTopYPt: boxTopYPt,
        startBoxWidthPt: boxWidthPt,
        startBoxHeightPt: boxHeightPt,
        cleanup: () => {
          window.removeEventListener("pointermove", handleWindowMove, true);
          window.removeEventListener("pointerup", handleWindowUp, true);
          window.removeEventListener("pointercancel", handleWindowUp, true);
        },
      };
      target.setPointerCapture(e.pointerId);
      setSelectedId(shape.id);
    },
    [
      shape.points,
      shape.page,
      shape.id,
      minX,
      maxX,
      minY,
      maxY,
      padPt,
      setSelectedId,
      pushUndoStep,
      tabId,
      applyPointerMove,
      finishDrag,
    ],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      applyPointerMove(e.clientX, e.clientY);
    },
    [applyPointerMove],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    finishDrag(e.pointerId, e.currentTarget as HTMLElement);
  }, [finishDrag]);

  useShapeKeyboard(selected, shape.id, tabId, {
    onNudge: (dx, dy) => updateShape(tabId, shape.id, {
      points: shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
    }),
    onDelete: () => { removeShape(tabId, shape.id); setSelectedId(null); },
    onEscape: () => setSelectedId(null),
  });

  const strokeColor = `rgb(${(shape.color.r * 255).toFixed(0)},${(shape.color.g * 255).toFixed(0)},${(shape.color.b * 255).toFixed(0)})`;
  const strokeWidth = shape.thickness * zoom;

  return (
    <div
      className="absolute z-20"
      style={{ left: leftPx, top: topPx, width: widthPx, height: heightPx }}
      data-testid="pending-shape"
      data-pending-element="shape"
      data-shape-kind={shape.kind}
      data-shape-id={shape.id}
      data-page-number={shape.page}
      onPointerDown={startDrag}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <svg width="100%" height="100%" style={{ overflow: "visible", pointerEvents: "none" }}>
        <path d={pathD} stroke={strokeColor} strokeWidth={strokeWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <path d={pathD} stroke="transparent" strokeWidth={Math.max(strokeWidth + 8, 12)} fill="none" style={{ pointerEvents: "stroke" }} />
      </svg>
      {selected && (
        <div
          className="pointer-events-none absolute inset-0 outline outline-2 outline-dashed outline-[var(--color-accent)]/60"
        />
      )}
      {selected && (
        <DeleteChip onClick={() => { removeShape(tabId, shape.id); setSelectedId(null); }} />
      )}
    </div>
  );
}

// ─── Sticky note ────────────────────────────────────────────────────────

type StickyKind = Extract<PendingShapeEdit, { kind: "sticky" }>;

function StickyShape({ shape, zoom, pageHeightPx, tabId, pageWidthPt, pageHeightPt, marginsEnabled }: ShapeProps & { shape: StickyKind }) {
  const updateShape = useDocumentStore((s) => s.updatePendingShapeEdit);
  const removeShape = useDocumentStore((s) => s.removePendingShapeEdit);
  const pushUndoStep = useDocumentStore((s) => s.pushUndoStep);
  const selected = useUIStore((s) => s.selectedPendingShapeId === shape.id);
  const setSelectedId = useUIStore((s) => s.setSelectedPendingShape);
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState(shape.text);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editing) requestAnimationFrame(() => textareaRef.current?.focus());
  }, [editing]);

  // Sticky marker is a 16x16 pt yellow square at (xPt, yPt) top-left.
  const MARKER_W = 16;
  const MARKER_H = 16;
  const leftPx = shape.xPt * zoom;
  const topPx = pageHeightPx - (shape.yPt + MARKER_H) * zoom;

  const dragState = useRef<{
    startClientX: number;
    startClientY: number;
    startXPt: number;
    startYPt: number;
    currentPage: number;
    pointerOffsetXPx: number;
    pointerOffsetYPx: number;
    cleanup?: () => void;
  } | null>(null);

  const finishDrag = useCallback((pointerId?: number, captureTarget?: HTMLElement | null) => {
    const s = dragState.current;
    if (!s) return;
    s.cleanup?.();
    dragState.current = null;
    if (pointerId != null && captureTarget) {
      try { captureTarget.releasePointerCapture(pointerId); } catch { /* already released */ }
    }
  }, []);

  const applyPointerMove = useCallback(
    (clientX: number, clientY: number) => {
      const s = dragState.current;
      if (!s) return;
      const target = resolveCrossPageTopLeft({
        currentPage: s.currentPage,
        clientX,
        clientY,
        zoom,
        pointerOffsetXPx: s.pointerOffsetXPx,
        pointerOffsetYPx: s.pointerOffsetYPx,
        widthPt: MARKER_W,
        heightPt: MARKER_H,
        marginsEnabled,
      });
      let newX = s.startXPt + (clientX - s.startClientX) / zoom;
      let newY = s.startYPt - (clientY - s.startClientY) / zoom;
      let nextPage = s.currentPage;
      if (target) {
        newX = target.xPt;
        newY = target.yPt;
        nextPage = target.page;
      } else {
        // V1.0069: always clamp to the page-edge or margin rectangle.
        const m = marginsEnabled ? PAGE_MARGIN_PT : 0;
        newX = Math.max(m, Math.min(pageWidthPt - m - MARKER_W, newX));
        newY = Math.max(m, Math.min(pageHeightPt - m - MARKER_H, newY));
      }
      s.currentPage = nextPage;
      updateShape(tabId, shape.id, { page: nextPage, xPt: newX, yPt: newY });
    },
    [zoom, updateShape, tabId, shape.id, marginsEnabled, pageWidthPt, pageHeightPt],
  );

  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || editing) return;
      e.preventDefault();
      e.stopPropagation();
      pushUndoStep(tabId);
      const target = e.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      const handleWindowMove = (ev: PointerEvent) => {
        if (!dragState.current) return;
        ev.preventDefault();
        applyPointerMove(ev.clientX, ev.clientY);
      };
      const handleWindowUp = (ev: PointerEvent) => finishDrag(ev.pointerId, target);
      window.addEventListener("pointermove", handleWindowMove, { capture: true });
      window.addEventListener("pointerup", handleWindowUp, { capture: true, once: true });
      window.addEventListener("pointercancel", handleWindowUp, { capture: true, once: true });
      dragState.current = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startXPt: shape.xPt,
        startYPt: shape.yPt,
        currentPage: shape.page,
        pointerOffsetXPx: e.clientX - rect.left,
        pointerOffsetYPx: e.clientY - rect.top,
        cleanup: () => {
          window.removeEventListener("pointermove", handleWindowMove, true);
          window.removeEventListener("pointerup", handleWindowUp, true);
          window.removeEventListener("pointercancel", handleWindowUp, true);
        },
      };
      target.setPointerCapture(e.pointerId);
      setSelectedId(shape.id);
    },
    [shape.xPt, shape.yPt, shape.page, shape.id, setSelectedId, editing, pushUndoStep, tabId, applyPointerMove, finishDrag],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      applyPointerMove(e.clientX, e.clientY);
    },
    [applyPointerMove],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    finishDrag(e.pointerId, e.currentTarget as HTMLElement);
  }, [finishDrag]);

  useShapeKeyboard(selected && !editing, shape.id, tabId, {
    onNudge: (dx, dy) => updateShape(tabId, shape.id, { xPt: shape.xPt + dx, yPt: shape.yPt + dy }),
    onDelete: () => { removeShape(tabId, shape.id); setSelectedId(null); },
    onEscape: () => setSelectedId(null),
  });

  return (
    <div
      className="absolute z-20"
      style={{ left: leftPx, top: topPx, width: MARKER_W * zoom, height: MARKER_H * zoom }}
      data-testid="pending-shape"
      data-pending-element="shape"
      data-shape-kind="sticky"
      data-shape-id={shape.id}
      data-page-number={shape.page}
      onPointerDown={startDrag}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={() => { setDraftText(shape.text); setEditing(true); }}
    >
      <div
        className={
          "h-full w-full " +
          (selected ? "outline outline-2 outline-[var(--color-accent)]" : "ring-1 ring-[#e5b81c] hover:ring-2")
        }
        style={{ background: "#fff7c2", cursor: editing ? "text" : "move" }}
        title="Drag to move · Double-click to edit note"
      />
      {selected && !editing && (
        <div
          className="pointer-events-none absolute left-full ml-1 top-0 min-w-[140px] max-w-[240px] rounded border border-[#e5b81c] bg-[#fff7c2] p-1.5 text-[11px] leading-snug text-[#3a2d00]"
          style={{ transform: `scale(${1 / zoom})`, transformOrigin: "left top" }}
        >
          {shape.text}
        </div>
      )}
      {editing && (
        <div
          className="absolute left-full ml-1 top-0 flex flex-col gap-1 rounded-md border border-[#f5c21e] bg-[#fff7c2] p-2 shadow-lg"
          style={{ minWidth: 180, transform: `scale(${1 / zoom})`, transformOrigin: "left top" }}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <textarea
            ref={textareaRef}
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                updateShape(tabId, shape.id, { text: draftText });
                setEditing(false);
              } else if (e.key === "Escape") {
                setEditing(false);
                setDraftText(shape.text);
              }
            }}
            onBlur={() => { updateShape(tabId, shape.id, { text: draftText }); setEditing(false); }}
            rows={3}
            className="min-h-[60px] w-full resize-y border-0 bg-transparent px-0 text-[12px] leading-snug text-[#3a2d00] focus:outline-none"
          />
          <span className="text-[10px] text-[#8a6f00]">⌘↵ saves · Esc cancels</span>
        </div>
      )}
      {selected && !editing && (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            removeShape(tabId, shape.id);
            setSelectedId(null);
          }}
          className="absolute -right-6 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--panel-bg-raised)] text-[var(--muted)] shadow-md hover:text-[var(--color-destructive)]"
          aria-label="Delete sticky note"
          style={{ transform: `scale(${1 / zoom})`, transformOrigin: "right top" }}
        >
          <X className="h-3 w-3" strokeWidth={2.5} />
        </button>
      )}
    </div>
  );
}

// ─── Shared handle + chip + keyboard hook ───────────────────────────────

function Handle({
  pos,
  onDown,
  onMove,
  onUp,
}: {
  pos: "nw" | "ne" | "sw" | "se";
  onDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onUp: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const className =
    pos === "nw" ? "left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize"
    : pos === "ne" ? "right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize"
    : pos === "sw" ? "left-0 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize"
    : "right-0 bottom-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize";
  return (
    <div
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      className={`absolute h-3 w-3 rounded-sm border border-white bg-[var(--color-accent)] shadow-sm ${className}`}
      data-handle={pos}
    />
  );
}

function DeleteChip({
  onClick,
  style,
}: {
  onClick: () => void;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="absolute -right-7 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--panel-bg-raised)] text-[var(--muted)] shadow-md hover:text-[var(--color-destructive)]"
      aria-label="Delete"
      style={style}
    >
      <X className="h-3 w-3" strokeWidth={2.5} />
    </button>
  );
}

function useShapeKeyboard(
  active: boolean,
  _shapeId: string,
  tabId: string,
  handlers: {
    onNudge: (dx: number, dy: number) => void;
    onDelete: () => void;
    onEscape: () => void;
  },
) {
  const pushUndoStep = useDocumentStore((s) => s.pushUndoStep);
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      if (e.key === "ArrowUp") { e.preventDefault(); pushUndoStep(tabId); handlers.onNudge(0, step); }
      else if (e.key === "ArrowDown") { e.preventDefault(); pushUndoStep(tabId); handlers.onNudge(0, -step); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); pushUndoStep(tabId); handlers.onNudge(-step, 0); }
      else if (e.key === "ArrowRight") { e.preventDefault(); pushUndoStep(tabId); handlers.onNudge(step, 0); }
      else if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); handlers.onDelete(); }
      else if (e.key === "Escape") handlers.onEscape();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [active, handlers, pushUndoStep, tabId]);
}
