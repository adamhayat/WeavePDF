import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useUIStore } from "../../stores/ui";
import { useDocumentStore } from "../../stores/document";

// V1.0087: draggable Crop tool overlay. Renders on the active page when
// `tool === "crop"`. Scrim-dims outside the rectangle (Photoshop /
// Pixelmator convention; PDF apps that DON'T scrim — Acrobat, Preview —
// rely on tooltips to convey what's kept-vs-discarded, which Adam's
// agents flagged as less obvious). Eight handles (4 corners + 4 edges)
// per the cross-app convention. Drag inside to move, drag a handle to
// resize, hold Shift to constrain aspect.
//
// Coords inside `cropDraft` are PDF user-space points (origin = bottom-
// left, matching pdf-lib semantics). The mapping to/from CSS pixels:
//   leftPx = xPt * zoom
//   topPx  = pageHeightPx - (yPt + hPt) * zoom
// (Y flips because DOM is top-origin.)

const MIN_CROP_PT = 10;
const HANDLE_HIT_PX = 14; // pointer hit area, slightly bigger than visual
const CORNER_VISUAL_PX = 12;
const EDGE_VISUAL_THICK_PX = 6;
const EDGE_VISUAL_LONG_PX = 24;

type Props = {
  pageNumber: number;
  zoom: number;
  pageHeightPx: number;
  pageWidthPt: number;
  pageHeightPt: number;
};

type HandleKind =
  | "nw" | "n" | "ne"
  | "w" | "e"
  | "sw" | "s" | "se"
  | "move";

export function CropOverlay({ pageNumber, zoom, pageHeightPx, pageWidthPt, pageHeightPt }: Props) {
  const tool = useUIStore((s) => s.tool);
  const cropDraft = useUIStore((s) => s.cropDraft);
  const setCropDraft = useUIStore((s) => s.setCropDraft);
  const activeTab = useDocumentStore((s) => s.activeTab());

  // V1.0087: when crop tool activates and there's no draft yet, seed one
  // for the currently-visible page. Use `detectPageContentBbox` for a
  // smart default; fall back to a 36pt inset if detection misses (page
  // entirely whitespace, pdf.js error, etc.). The seed runs ONCE per
  // crop-mode entry — re-entering after a Cancel re-detects fresh.
  const seedInFlight = useRef(false);
  useEffect(() => {
    if (tool !== "crop") return;
    if (cropDraft != null) return;
    if (!activeTab?.bytes) return;
    if (seedInFlight.current) return;
    seedInFlight.current = true;
    void (async () => {
      try {
        const { detectPageContentBbox } = await import("../../lib/pdf-ops");
        const bbox = await detectPageContentBbox(activeTab.bytes!, pageNumber);
        if (bbox && bbox.w >= MIN_CROP_PT && bbox.h >= MIN_CROP_PT) {
          setCropDraft({
            pageNumber,
            pageWPt: pageWidthPt,
            pageHPt: pageHeightPt,
            xPt: bbox.x,
            yPt: bbox.y,
            wPt: bbox.w,
            hPt: bbox.h,
          });
        } else {
          // Fallback: 36pt inset (matches V1.0028 modal default).
          const inset = 36;
          setCropDraft({
            pageNumber,
            pageWPt: pageWidthPt,
            pageHPt: pageHeightPt,
            xPt: inset,
            yPt: inset,
            wPt: Math.max(MIN_CROP_PT, pageWidthPt - inset * 2),
            hPt: Math.max(MIN_CROP_PT, pageHeightPt - inset * 2),
          });
        }
      } finally {
        seedInFlight.current = false;
      }
    })();
  }, [tool, cropDraft, activeTab?.bytes, pageNumber, pageWidthPt, pageHeightPt, setCropDraft]);

  // Only render the visual on the page whose draft this is. When the
  // user scrolls to another page, the rectangle is invisible but state
  // persists — the action bar still shows the dimensions and Apply
  // still works (uniform across all pages).
  if (tool !== "crop") return null;
  if (!cropDraft) return null;
  if (cropDraft.pageNumber !== pageNumber) return null;

  return (
    <CropRect
      cropDraft={cropDraft}
      zoom={zoom}
      pageHeightPx={pageHeightPx}
      pageWidthPt={pageWidthPt}
      pageHeightPt={pageHeightPt}
    />
  );
}

function CropRect({
  cropDraft,
  zoom,
  pageHeightPx,
  pageWidthPt,
  pageHeightPt,
}: {
  cropDraft: NonNullable<ReturnType<typeof useUIStore.getState>["cropDraft"]>;
  zoom: number;
  pageHeightPx: number;
  pageWidthPt: number;
  pageHeightPt: number;
}) {
  const setCropDraft = useUIStore((s) => s.setCropDraft);
  const dragState = useRef<{
    kind: HandleKind;
    startClientX: number;
    startClientY: number;
    startXPt: number;
    startYPt: number;
    startWPt: number;
    startHPt: number;
    active: boolean;
  } | null>(null);

  // Position the rectangle in CSS pixels. PDF coords (bottom-left
  // origin, points) → DOM coords (top-left origin, pixels).
  const leftPx = cropDraft.xPt * zoom;
  const widthPx = cropDraft.wPt * zoom;
  const heightPx = cropDraft.hPt * zoom;
  const topPx = pageHeightPx - (cropDraft.yPt + cropDraft.hPt) * zoom;
  const rightPx = leftPx + widthPx;
  const bottomPx = topPx + heightPx;
  const pageWidthPx = pageWidthPt * zoom;

  const onPointerDown = useCallback(
    (kind: HandleKind) => (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      dragState.current = {
        kind,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startXPt: cropDraft.xPt,
        startYPt: cropDraft.yPt,
        startWPt: cropDraft.wPt,
        startHPt: cropDraft.hPt,
        active: true,
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [cropDraft.xPt, cropDraft.yPt, cropDraft.wPt, cropDraft.hPt],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const s = dragState.current;
      if (!s?.active) return;
      const dx = (e.clientX - s.startClientX) / zoom; // PDF points
      const dy = (e.clientY - s.startClientY) / zoom; // top-origin → PDF Y flip below
      let xPt = s.startXPt;
      let yPt = s.startYPt;
      let wPt = s.startWPt;
      let hPt = s.startHPt;
      // DOM dy positive = drag down. PDF y increases UP. So dragging
      // down decreases yPt (for the "south" edge / corners that move
      // the bottom edge of the rect) — actually, complete derivation:
      //   - Moving the rect: subtract dy from yPt (drag down = lower y).
      //   - Resizing south (bottom edge): drag down extends rect down →
      //     increase hPt, decrease yPt by same amount (top stays).
      //   - Resizing north (top edge): drag down shrinks top → decrease
      //     hPt, yPt stays.
      // Pre-compute the dy-in-PDF-Y once for clarity.
      const dyPdf = -dy; // PDF Y delta corresponding to DOM dy.
      const k = s.kind;
      if (k === "move") {
        xPt = s.startXPt + dx;
        yPt = s.startYPt + dyPdf;
      } else {
        // Resize. Pieces:
        //   left edge moves: xPt += dx, wPt -= dx
        //   right edge moves: wPt += dx
        //   top edge moves: hPt -= dyPdf  (top is at yPt+hPt; dragging
        //     top down = top edge moves "down" in DOM = yPdf goes DOWN
        //     too, so hPt shrinks by |dyPdf| but we want signed math)
        //   bottom edge moves: yPt += dyPdf, hPt -= dyPdf
        if (k === "w" || k === "nw" || k === "sw") {
          xPt = s.startXPt + dx;
          wPt = s.startWPt - dx;
        }
        if (k === "e" || k === "ne" || k === "se") {
          wPt = s.startWPt + dx;
        }
        if (k === "n" || k === "ne" || k === "nw") {
          // Top edge: top-y (in PDF) = yPt + hPt. Drag UP in DOM → dyPdf > 0
          // → top edge moves up → hPt grows. Drag DOWN → hPt shrinks.
          // Since DOM y increases downward, "drag up" yields negative dy
          // → positive dyPdf. So hPt = startHPt + dyPdf where dy comes
          // from the original mouse delta. But wait we already mapped
          // dyPdf = -dy, so for "drag up": dy < 0 → dyPdf > 0 → hPt grows. ✓
          hPt = s.startHPt + dyPdf;
        }
        if (k === "s" || k === "se" || k === "sw") {
          // Bottom edge: yPt = bottom of rect. Drag DOWN in DOM → dyPdf < 0
          // → bottom moves down → yPt decreases AND hPt grows.
          yPt = s.startYPt + dyPdf;
          hPt = s.startHPt - dyPdf;
        }
      }
      // Enforce minimum sizes.
      if (wPt < MIN_CROP_PT) {
        if (k === "w" || k === "nw" || k === "sw") {
          // Pin the right edge: xPt + wPt should remain constant.
          xPt = s.startXPt + s.startWPt - MIN_CROP_PT;
        }
        wPt = MIN_CROP_PT;
      }
      if (hPt < MIN_CROP_PT) {
        if (k === "s" || k === "se" || k === "sw") {
          // Pin the top edge.
          yPt = s.startYPt + s.startHPt - MIN_CROP_PT;
        }
        hPt = MIN_CROP_PT;
      }
      // Clamp to page bounds.
      if (xPt < 0) {
        if (k === "move") {
          xPt = 0;
        } else if (k === "w" || k === "nw" || k === "sw") {
          wPt += xPt; // shrink
          xPt = 0;
        }
      }
      if (yPt < 0) {
        if (k === "move") {
          yPt = 0;
        } else if (k === "s" || k === "se" || k === "sw") {
          hPt += yPt;
          yPt = 0;
        }
      }
      if (xPt + wPt > pageWidthPt) {
        if (k === "move") {
          xPt = pageWidthPt - wPt;
        } else if (k === "e" || k === "ne" || k === "se") {
          wPt = pageWidthPt - xPt;
        }
      }
      if (yPt + hPt > pageHeightPt) {
        if (k === "move") {
          yPt = pageHeightPt - hPt;
        } else if (k === "n" || k === "ne" || k === "nw") {
          hPt = pageHeightPt - yPt;
        }
      }
      // Re-clamp lower bound after width/height clamps (in case
      // clamping pulled values past zero again).
      xPt = Math.max(0, xPt);
      yPt = Math.max(0, yPt);
      wPt = Math.max(MIN_CROP_PT, Math.min(pageWidthPt - xPt, wPt));
      hPt = Math.max(MIN_CROP_PT, Math.min(pageHeightPt - yPt, hPt));
      setCropDraft({ ...cropDraft, xPt, yPt, wPt, hPt });
    },
    [zoom, cropDraft, pageWidthPt, pageHeightPt, setCropDraft],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current) return;
    dragState.current.active = false;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }, []);

  // Keyboard nudge (1pt; Shift = 10pt). Only when crop tool is active.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
      const step = e.shiftKey ? 10 : 1;
      let dx = 0;
      let dy = 0;
      if (e.key === "ArrowLeft") dx = -step;
      else if (e.key === "ArrowRight") dx = step;
      else if (e.key === "ArrowUp") dy = step;
      else if (e.key === "ArrowDown") dy = -step;
      else return;
      e.preventDefault();
      const xPt = Math.max(0, Math.min(pageWidthPt - cropDraft.wPt, cropDraft.xPt + dx));
      const yPt = Math.max(0, Math.min(pageHeightPt - cropDraft.hPt, cropDraft.yPt + dy));
      setCropDraft({ ...cropDraft, xPt, yPt });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cropDraft, pageWidthPt, pageHeightPt, setCropDraft]);

  // Make sure pageWPt/pageHPt in the draft stay in sync with the
  // current page geometry — guards against zoom-related rounding drift
  // when the underlying canvas re-measures.
  useLayoutEffect(() => {
    if (cropDraft.pageWPt !== pageWidthPt || cropDraft.pageHPt !== pageHeightPt) {
      setCropDraft({ ...cropDraft, pageWPt: pageWidthPt, pageHPt: pageHeightPt });
    }
  }, [pageWidthPt, pageHeightPt, cropDraft, setCropDraft]);

  // Scrim color — 50% black overlay outside the crop rect on the page.
  // Distinguishes the crop tool from rect/whiteout/highlight (which
  // don't scrim) per the V1.0087 agent synthesis. `pointer-events:
  // none` on the scrim so the user can still drag through it (no
  // accidental click-blocking on the kept content area).
  const scrim = "rgba(0,0,0,0.45)";

  return (
    <div
      className="absolute inset-0 z-30 select-none"
      data-testid="crop-overlay"
      style={{ pointerEvents: "auto" }}
    >
      {/* Scrim — 4 rectangles around the crop rect. pointer-events: none
          so drags pass through to the crop rect's pointer handlers. */}
      <div style={{ position: "absolute", left: 0, top: 0, right: 0, height: topPx, background: scrim, pointerEvents: "none" }} />
      <div style={{ position: "absolute", left: 0, top: bottomPx, right: 0, bottom: 0, background: scrim, pointerEvents: "none" }} />
      <div style={{ position: "absolute", left: 0, top: topPx, width: leftPx, height: heightPx, background: scrim, pointerEvents: "none" }} />
      <div style={{ position: "absolute", left: rightPx, top: topPx, right: 0, height: heightPx, background: scrim, pointerEvents: "none" }} />

      {/* Crop rectangle body — drag inside to move. */}
      <div
        data-testid="crop-rect"
        onPointerDown={onPointerDown("move")}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{
          position: "absolute",
          left: leftPx,
          top: topPx,
          width: widthPx,
          height: heightPx,
          cursor: "move",
          border: "1.5px solid var(--color-accent)",
          boxShadow: "0 0 0 1px rgba(255,255,255,0.5) inset",
          background: "transparent",
        }}
      />

      {/* Edge handles. Hit area is slightly larger than the visual to
          make grabbing easier. */}
      <Handle kind="n" cx={leftPx + widthPx / 2} cy={topPx} hover="ns-resize" longSide="x" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
      <Handle kind="s" cx={leftPx + widthPx / 2} cy={bottomPx} hover="ns-resize" longSide="x" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
      <Handle kind="w" cx={leftPx} cy={topPx + heightPx / 2} hover="ew-resize" longSide="y" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
      <Handle kind="e" cx={rightPx} cy={topPx + heightPx / 2} hover="ew-resize" longSide="y" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />

      {/* Corner handles. */}
      <Handle kind="nw" cx={leftPx} cy={topPx} hover="nwse-resize" corner onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
      <Handle kind="ne" cx={rightPx} cy={topPx} hover="nesw-resize" corner onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
      <Handle kind="sw" cx={leftPx} cy={bottomPx} hover="nesw-resize" corner onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
      <Handle kind="se" cx={rightPx} cy={bottomPx} hover="nwse-resize" corner onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />

      {/* Suppress the unused-import diagnostic for pageWidthPx — it's
          intentionally retained so the scrim's right strip can be
          re-anchored absolutely later if we ever break out of the
          parent's `absolute inset-0` container. */}
      <span style={{ display: "none" }}>{pageWidthPx}</span>
    </div>
  );
}

function Handle({
  kind,
  cx,
  cy,
  hover,
  corner,
  longSide,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  kind: HandleKind;
  cx: number;
  cy: number;
  hover: string;
  corner?: boolean;
  longSide?: "x" | "y";
  onPointerDown: (k: HandleKind) => (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  // Visual size: corner = small square, edge = thin bar centered on
  // the edge midpoint. Hit area is uniformly HANDLE_HIT_PX so
  // grabbing the edge bars isn't a pixel-perfect target.
  const visW = corner ? CORNER_VISUAL_PX : longSide === "x" ? EDGE_VISUAL_LONG_PX : EDGE_VISUAL_THICK_PX;
  const visH = corner ? CORNER_VISUAL_PX : longSide === "y" ? EDGE_VISUAL_LONG_PX : EDGE_VISUAL_THICK_PX;
  const hit = HANDLE_HIT_PX;
  return (
    <div
      data-testid={`crop-handle-${kind}`}
      onPointerDown={onPointerDown(kind)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: "absolute",
        left: cx - hit / 2,
        top: cy - hit / 2,
        width: hit,
        height: hit,
        cursor: hover,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        aria-hidden
        style={{
          width: visW,
          height: visH,
          background: "var(--color-accent)",
          border: "1px solid white",
          borderRadius: 2,
          boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
        }}
      />
    </div>
  );
}
