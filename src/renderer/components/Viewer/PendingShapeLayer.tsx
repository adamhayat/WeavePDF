import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useDocumentStore, type PendingShapeEdit } from "../../stores/document";
import { useUIStore } from "../../stores/ui";

type Props = {
  pageNumber: number;
  zoom: number;
  pageHeightPx: number;
};

const MIN_SIZE_PT = 8;

export function PendingShapeLayer({ pageNumber, zoom, pageHeightPx }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
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

function BoxShape({ shape, zoom, pageHeightPx, tabId }: ShapeProps & { shape: BoxKind }) {
  const updateShape = useDocumentStore((s) => s.updatePendingShapeEdit);
  const removeShape = useDocumentStore((s) => s.removePendingShapeEdit);
  const selected = useUIStore((s) => s.selectedPendingShapeId === shape.id);
  const setSelectedId = useUIStore((s) => s.setSelectedPendingShape);

  const leftPx = shape.xPt * zoom;
  const topPx = pageHeightPx - (shape.yPt + shape.heightPt) * zoom;
  const widthPx = shape.widthPt * zoom;
  const heightPx = shape.heightPt * zoom;

  const dragState = useRef<{
    mode: "move" | "nw" | "ne" | "sw" | "se";
    startClientX: number;
    startClientY: number;
    startXPt: number;
    startYPt: number;
    startWPt: number;
    startHPt: number;
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
        startXPt: shape.xPt,
        startYPt: shape.yPt,
        startWPt: shape.widthPt,
        startHPt: shape.heightPt,
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setSelectedId(shape.id);
    },
    [shape.xPt, shape.yPt, shape.widthPt, shape.heightPt, shape.id, setSelectedId],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const s = dragState.current;
      if (!s) return;
      const dxPt = (e.clientX - s.startClientX) / zoom;
      const dyPt = (e.clientY - s.startClientY) / zoom;
      if (s.mode === "move") {
        updateShape(tabId, shape.id, { xPt: s.startXPt + dxPt, yPt: s.startYPt - dyPt });
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
      if (newW < MIN_SIZE_PT || newH < MIN_SIZE_PT) return;
      updateShape(tabId, shape.id, { xPt: newX, yPt: newY, widthPt: newW, heightPt: newH });
    },
    [zoom, updateShape, tabId, shape.id],
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

  useShapeKeyboard(selected, shape.id, tabId, {
    onNudge: (dx, dy) => updateShape(tabId, shape.id, { xPt: shape.xPt + dx, yPt: shape.yPt + dy }),
    onDelete: () => { removeShape(tabId, shape.id); setSelectedId(null); },
    onEscape: () => setSelectedId(null),
  });

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
      data-shape-kind={shape.kind}
      data-shape-id={shape.id}
      onPointerDown={(e) => { setSelectedId(shape.id); startDrag(e, "move"); }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
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

function LineShape({ shape, zoom, pageHeightPx, tabId }: ShapeProps & { shape: LineKind }) {
  const updateShape = useDocumentStore((s) => s.updatePendingShapeEdit);
  const removeShape = useDocumentStore((s) => s.removePendingShapeEdit);
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
  } | null>(null);

  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>, mode: "move" | "from" | "to") => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      dragState.current = {
        mode,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startFromX: shape.fromX, startFromY: shape.fromY,
        startToX: shape.toX, startToY: shape.toY,
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setSelectedId(shape.id);
    },
    [shape.fromX, shape.fromY, shape.toX, shape.toY, shape.id, setSelectedId],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const s = dragState.current;
      if (!s) return;
      const dxPt = (e.clientX - s.startClientX) / zoom;
      const dyPt = (e.clientY - s.startClientY) / zoom;
      if (s.mode === "move") {
        updateShape(tabId, shape.id, {
          fromX: s.startFromX + dxPt, fromY: s.startFromY - dyPt,
          toX: s.startToX + dxPt, toY: s.startToY - dyPt,
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
    [zoom, updateShape, tabId, shape.id],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!dragState.current) return;
    dragState.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* */ }
  }, []);

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
      data-shape-kind={shape.kind}
      data-shape-id={shape.id}
      onPointerDown={(e) => { setSelectedId(shape.id); startDrag(e, "move"); }}
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

function FreehandShape({ shape, zoom, pageHeightPx, tabId }: ShapeProps & { shape: FreehandKind }) {
  const updateShape = useDocumentStore((s) => s.updatePendingShapeEdit);
  const removeShape = useDocumentStore((s) => s.removePendingShapeEdit);
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
  } | null>(null);

  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      dragState.current = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startPoints: shape.points.map((p) => ({ ...p })),
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setSelectedId(shape.id);
    },
    [shape.points, shape.id, setSelectedId],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const s = dragState.current;
      if (!s) return;
      const dxPt = (e.clientX - s.startClientX) / zoom;
      const dyPt = (e.clientY - s.startClientY) / zoom;
      updateShape(tabId, shape.id, {
        points: s.startPoints.map((p) => ({ x: p.x + dxPt, y: p.y - dyPt })),
      });
    },
    [zoom, updateShape, tabId, shape.id],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!dragState.current) return;
    dragState.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* */ }
  }, []);

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
      data-shape-kind={shape.kind}
      data-shape-id={shape.id}
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

function StickyShape({ shape, zoom, pageHeightPx, tabId }: ShapeProps & { shape: StickyKind }) {
  const updateShape = useDocumentStore((s) => s.updatePendingShapeEdit);
  const removeShape = useDocumentStore((s) => s.removePendingShapeEdit);
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
  } | null>(null);

  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || editing) return;
      e.preventDefault();
      e.stopPropagation();
      dragState.current = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startXPt: shape.xPt,
        startYPt: shape.yPt,
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setSelectedId(shape.id);
    },
    [shape.xPt, shape.yPt, shape.id, setSelectedId, editing],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const s = dragState.current;
      if (!s) return;
      updateShape(tabId, shape.id, {
        xPt: s.startXPt + (e.clientX - s.startClientX) / zoom,
        yPt: s.startYPt - (e.clientY - s.startClientY) / zoom,
      });
    },
    [zoom, updateShape, tabId, shape.id],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!dragState.current) return;
    dragState.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* */ }
  }, []);

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
      data-shape-kind="sticky"
      data-shape-id={shape.id}
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
  _tabId: string,
  handlers: {
    onNudge: (dx: number, dy: number) => void;
    onDelete: () => void;
    onEscape: () => void;
  },
) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      if (e.key === "ArrowUp") { e.preventDefault(); handlers.onNudge(0, step); }
      else if (e.key === "ArrowDown") { e.preventDefault(); handlers.onNudge(0, -step); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); handlers.onNudge(-step, 0); }
      else if (e.key === "ArrowRight") { e.preventDefault(); handlers.onNudge(step, 0); }
      else if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); handlers.onDelete(); }
      else if (e.key === "Escape") handlers.onEscape();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [active, handlers]);
}
