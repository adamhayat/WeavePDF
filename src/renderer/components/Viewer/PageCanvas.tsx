import { forwardRef, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "../../lib/pdfjs";
import { pdfjsLib } from "../../lib/pdfjs";
import { useUIStore } from "../../stores/ui";
import { useDocumentStore } from "../../stores/document";
import { TextPromptOverlay } from "./TextPromptOverlay";
import { StickyPromptOverlay } from "./StickyPromptOverlay";
import { PendingTextLayer } from "./PendingTextLayer";
import { PendingImageLayer } from "./PendingImageLayer";
import { PendingShapeLayer } from "./PendingShapeLayer";
import { AcroFormLayer } from "./AcroFormLayer";
import { SearchHighlightLayer } from "./SearchHighlightLayer";
import { bytesToBlob } from "../../../shared/buffers";
import type { OcrBox } from "../../../shared/ipc";

// V1.0052: OCR results cached per (tab × edit-version × page). Survives
// PageCanvas remounts within a session — multiple page components share one
// cache. The version-in-key invalidates naturally after every applyEdit so
// edits to one page don't poison cached boxes on another. ocrInFlight blocks
// re-prompts while a slow OCR call is still resolving.
const ocrCache = new Map<string, OcrBox[]>();
const ocrInFlight = new Set<string>();

type Props = {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
};

export const PageCanvas = forwardRef<HTMLDivElement, Props>(function PageCanvas(
  { pdf, pageNumber, zoom },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [pageSize, setPageSize] = useState<{ w: number; h: number } | null>(null); // in PDF points
  const [visible, setVisible] = useState(false);
  // V1.0046: track whether the canvas has been painted at least once. Until
  // it has, we suppress the white page background + drop shadow so dark-mode
  // users don't see a stark white rectangle "flash" between tab open and
  // pdf.js's first render. See the wrapper div below.
  const [painted, setPainted] = useState(false);

  const tool = useUIStore((s) => s.tool);
  const setTool = useUIStore((s) => s.setTool);
  const setTextPrompt = useUIStore((s) => s.setTextPrompt);
  const addPendingTextEdit = useDocumentStore((s) => s.addPendingTextEdit);
  const [dragBox, setDragBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  // For the freeform pen, we accumulate CSS-pixel points during the drag.
  const [penPath, setPenPath] = useState<{ x: number; y: number }[]>([]);

  const setRefs = (el: HTMLDivElement | null) => {
    containerRef.current = el;
    if (typeof ref === "function") {
      ref(el);
    } else if (ref) {
      (ref as { current: HTMLDivElement | null }).current = el;
    }
  };

  useEffect(() => {
    let cancelled = false;
    pdf.getPage(pageNumber).then((page) => {
      if (cancelled) return;
      const vp = page.getViewport({ scale: zoom });
      const baseVp = page.getViewport({ scale: 1 });
      setDims({ w: vp.width, h: vp.height });
      setPageSize({ w: baseVp.width, h: baseVp.height });
    });
    return () => {
      cancelled = true;
    };
  }, [pdf, pageNumber, zoom]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setVisible(true);
      },
      { rootMargin: "800px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !dims) return;
    const canvas = canvasRef.current;
    const textLayerDiv = textLayerRef.current;
    if (!canvas || !textLayerDiv) return;

    let cancelled = false;
    let renderTask: ReturnType<import("pdfjs-dist").PDFPageProxy["render"]> | null = null;

    (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale: zoom });
      const dpr = window.devicePixelRatio || 1;

      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      renderTask = page.render({ canvasContext: ctx, viewport });
      try {
        await renderTask.promise;
      } catch {
        return;
      }
      if (cancelled) return;
      // First paint complete — reveal the white page background + shadow.
      setPainted(true);

      textLayerDiv.replaceChildren();
      textLayerDiv.style.setProperty("--scale-factor", String(zoom));

      const PdfTextLayer = (pdfjsLib as unknown as {
        TextLayer?: new (args: {
          textContentSource: ReturnType<
            import("pdfjs-dist").PDFPageProxy["streamTextContent"]
          >;
          container: HTMLElement;
          viewport: ReturnType<import("pdfjs-dist").PDFPageProxy["getViewport"]>;
        }) => { render: () => Promise<void>; cancel?: () => void };
      }).TextLayer;

      if (PdfTextLayer) {
        const textLayer = new PdfTextLayer({
          textContentSource: page.streamTextContent(),
          container: textLayerDiv,
          viewport,
        });
        try {
          await textLayer.render();
        } catch {
          /* text layer is decorative */
        }
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [visible, pdf, pageNumber, zoom, dims]);

  const handleInteractionClick = async (e: React.MouseEvent<HTMLDivElement>) => {
    if (
      !pageSize ||
      tool === "none" ||
      tool === "highlight" ||
      tool === "whiteout" ||
      tool === "rect" ||
      tool === "circle" ||
      tool === "line" ||
      tool === "arrow" ||
      tool === "draw" ||
      tool === "editText" ||
      tool === "crop"
    ) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    // CSS pixels on screen → PDF points. At zoom=1, 1 CSS px = 1 point.
    // Y flips because PDF origin is bottom-left.
    const pdfX = clickX / zoom;
    const pdfYFromBottom = pageSize.h - clickY / zoom;

    if (tool === "text") {
      setTextPrompt({ page: pageNumber, x: pdfX, y: pdfYFromBottom });
      setTool("none");
      return;
    }

    if (tool === "sticky") {
      // Open the inline sticky prompt at the click position. Commit happens
      // from StickyPromptOverlay on ⌘↵, which also resets the tool.
      useUIStore.getState().setStickyPrompt({
        page: pageNumber,
        xPt: pdfX,
        yPt: pdfYFromBottom,
      });
      return;
    }

    if (tool === "image") {
      const pendingImage = useUIStore.getState().pendingImage;
      if (!pendingImage) {
        setTool("none");
        return;
      }
      const activeTab = useDocumentStore.getState().activeTab();
      if (!activeTab) return;
      // Decode for intrinsic dims so we can preserve aspect at placement.
      const img = new Image();
      const loaded = new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Image load failed"));
      });
      const blob = bytesToBlob(pendingImage.bytes, pendingImage.mime);
      const url = URL.createObjectURL(blob);
      img.src = url;
      try {
        await loaded;
      } finally {
        URL.revokeObjectURL(url);
      }
      const targetW = 240;
      const targetH = targetW * (img.naturalHeight / img.naturalWidth);
      // Route through the same pending-image pipeline as paste-to-PDF so the
      // placed image is draggable + resizable + croppable until save.
      const newId = useDocumentStore.getState().addPendingImageEdit(activeTab.id, {
        page: pageNumber,
        xPt: pdfX,
        yPt: pdfYFromBottom - targetH,
        widthPt: targetW,
        heightPt: targetH,
        bytes: pendingImage.bytes,
        mime: pendingImage.mime,
      });
      useUIStore.getState().setSelectedPendingImage(newId);
      useUIStore.setState({ pendingImage: null });
      setTool("none");
      return;
    }

    if (tool === "signature") {
      const activeTab = useDocumentStore.getState().activeTab();
      if (!activeTab) return;
      const dataUrl = await window.weavepdf.signature.get();
      if (!dataUrl) return;
      // Handlers must be attached BEFORE src for data URLs — otherwise the
      // image can load + fire onload before we can listen.
      const img = new Image();
      const loaded = new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Signature image load failed"));
      });
      img.src = dataUrl;
      try {
        await loaded;
      } catch {
        return;
      }
      const sigW = 180; // points
      const sigH = sigW * (img.naturalHeight / img.naturalWidth);
      const bytes = await dataUrlToBytes(dataUrl);
      // Place as a pending overlay so the user can drag, resize, and nudge
      // the signature before committing — same UX as pasted images.
      const newId = useDocumentStore.getState().addPendingImageEdit(activeTab.id, {
        page: pageNumber,
        xPt: pdfX,
        yPt: pdfYFromBottom - sigH, // click = top-left of signature
        widthPt: sigW,
        heightPt: sigH,
        bytes,
        mime: "image/png",
      });
      useUIStore.getState().setSelectedPendingImage(newId);
      setTool("none");
    }
  };

  const isDragTool =
    tool === "highlight" ||
    tool === "whiteout" ||
    tool === "rect" ||
    tool === "circle" ||
    tool === "line" ||
    tool === "arrow" ||
    tool === "draw" ||
    tool === "redact" ||
    tool === "link" ||
    tool === "measure";
  // Carrying-an-item cursor for click-to-place tools ("copy" shows a small +
  // glyph on macOS, the universal "drop me here" affordance). Crosshair for
  // drag-to-draw tools (highlight/whiteout/shapes/redact/freehand). Text
  // cursor for the Add Text tool, which opens an inline input on click.
  const cursor =
    tool === "signature" || tool === "image"
      ? "copy"
      : tool === "text"
        ? "text"
        : tool === "sticky"
          ? "cell"
          : isDragTool
            ? "crosshair"
            : undefined;
  const toolActive = (tool !== "none") && (tool !== "editText");

  const pointerDownDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragTool) return;
    e.stopPropagation();
    // V1.0042: pointer-down on the tool overlay also drops any prior pending
    // selection. Without this, clicking on the page while a drag tool is
    // active wouldn't reach Viewer's background pointer-down (it stops
    // propagation here), so handles on a previously-placed image/text/shape
    // would stay visible until the user pressed Escape or switched tabs.
    useUIStore.getState().clearAllPendingSelections();
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    dragStart.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (tool === "draw") {
      setPenPath([dragStart.current]);
    } else {
      setDragBox({ x: dragStart.current.x, y: dragStart.current.y, w: 0, h: 0 });
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const pointerMoveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStart.current || !isDragTool) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    if (tool === "draw") {
      setPenPath((pts) => [...pts, { x: cx, y: cy }]);
      return;
    }
    const x = Math.min(cx, dragStart.current.x);
    const y = Math.min(cy, dragStart.current.y);
    const w = Math.abs(cx - dragStart.current.x);
    const h = Math.abs(cy - dragStart.current.y);
    setDragBox({ x, y, w, h });
  };

  const pointerUpDrag = async (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStart.current || !isDragTool || !pageSize) {
      dragStart.current = null;
      setDragBox(null);
      setPenPath([]);
      return;
    }
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }

    // ─── Freeform pen path ───
    if (tool === "draw") {
      const pts = penPath;
      dragStart.current = null;
      setPenPath([]);
      if (pts.length < 3) return;
      const activeTab = useDocumentStore.getState().activeTab();
      if (!activeTab) return;
      const pdfPts = pts.map((p) => ({
        x: p.x / zoom,
        y: pageSize.h - p.y / zoom,
      }));
      const ui = useUIStore.getState();
      const newId = useDocumentStore.getState().addPendingShapeEdit(activeTab.id, {
        kind: "freehand",
        page: pageNumber,
        points: pdfPts,
        color: ui.annotationColor,
        thickness: ui.strokeWidth,
      });
      useUIStore.getState().setSelectedPendingShape(newId);
      return;
    }

    if (!dragBox) {
      dragStart.current = null;
      return;
    }
    const box = dragBox;
    const rawStart = dragStart.current;
    dragStart.current = null;
    setDragBox(null);
    // Ignore tiny accidental drags (single-click).
    if (box.w < 4 || box.h < 4) return;
    // CSS → PDF points (Y flips).
    const region = {
      x: box.x / zoom,
      y: pageSize.h - (box.y + box.h) / zoom,
      width: box.w / zoom,
      height: box.h / zoom,
    };
    const activeTab = useDocumentStore.getState().activeTab();
    if (!activeTab) return;
    const ui = useUIStore.getState();
    const color = ui.annotationColor;
    const thickness = ui.strokeWidth;

    // Every drag tool routes through a PendingShapeEdit so the user can move,
    // resize, or delete the shape before committing on save.
    const addShape = useDocumentStore.getState().addPendingShapeEdit;
    const setSelected = useUIStore.getState().setSelectedPendingShape;
    let newId: string | null = null;
    if (tool === "highlight") {
      newId = addShape(activeTab.id, {
        kind: "highlight", page: pageNumber,
        xPt: region.x, yPt: region.y, widthPt: region.width, heightPt: region.height,
      });
    } else if (tool === "whiteout") {
      newId = addShape(activeTab.id, {
        kind: "whiteout", page: pageNumber,
        xPt: region.x, yPt: region.y, widthPt: region.width, heightPt: region.height,
      });
    } else if (tool === "redact") {
      newId = addShape(activeTab.id, {
        kind: "redact", page: pageNumber,
        xPt: region.x, yPt: region.y, widthPt: region.width, heightPt: region.height,
      });
    } else if (tool === "rect") {
      newId = addShape(activeTab.id, {
        kind: "rect", page: pageNumber,
        xPt: region.x, yPt: region.y, widthPt: region.width, heightPt: region.height,
        color, thickness,
      });
    } else if (tool === "circle") {
      newId = addShape(activeTab.id, {
        kind: "ellipse", page: pageNumber,
        xPt: region.x, yPt: region.y, widthPt: region.width, heightPt: region.height,
        color, thickness,
      });
    } else if (tool === "line" || tool === "arrow") {
      if (!rawStart) return;
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      const endCssX = e.clientX - rect.left;
      const endCssY = e.clientY - rect.top;
      const fromX = rawStart.x / zoom;
      const fromY = pageSize.h - rawStart.y / zoom;
      const toX = endCssX / zoom;
      const toY = pageSize.h - endCssY / zoom;
      newId = addShape(activeTab.id, {
        kind: tool, page: pageNumber,
        fromX, fromY, toX, toY, color, thickness,
      });
    } else if (tool === "link") {
      // Stash the rectangle and surface the LinkPopover; user picks URL or
      // page target there. Don't add a shape — links bake straight into the
      // PDF as a real /Link annotation, not a visible overlay.
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      ui.setPendingLink({
        page: pageNumber,
        rect: region,
        screenX: rect.left + box.x + box.w / 2,
        screenY: rect.top + box.y + box.h + 8,
      });
      return;
    } else if (tool === "measure") {
      // Distance measurement: stamp a thin line + a midpoint label like
      // "5.20 in" using the configured scale (or raw points if uncalibrated).
      if (!rawStart) return;
      const rectEl = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      const endCssX = e.clientX - rectEl.left;
      const endCssY = e.clientY - rectEl.top;
      const fromX = rawStart.x / zoom;
      const fromY = pageSize.h - rawStart.y / zoom;
      const toX = endCssX / zoom;
      const toY = pageSize.h - endCssY / zoom;
      const dx = toX - fromX;
      const dy = toY - fromY;
      const distancePts = Math.hypot(dx, dy);
      const scale = ui.measureScale;
      const value = scale ? distancePts * scale.unitsPerPoint : distancePts;
      const unit = scale?.unit ?? "pt";
      const label = `${value.toFixed(2)} ${unit}`;
      const measureColor = { r: 0.85, g: 0.1, b: 0.55 }; // hot pink — distinct
      const lineId = addShape(activeTab.id, {
        kind: "line", page: pageNumber,
        fromX, fromY, toX, toY,
        color: measureColor, thickness: 1.2,
      });
      // Stamp the label as a pending text edit at the midpoint, slightly
      // offset perpendicular to the line so it's not on top.
      const midX = (fromX + toX) / 2;
      const midY = (fromY + toY) / 2;
      const len = Math.max(distancePts, 1);
      const offsetX = (-dy / len) * 8;
      const offsetY = (dx / len) * 8;
      useDocumentStore.getState().addPendingTextEdit(activeTab.id, {
        page: pageNumber,
        xPt: midX + offsetX,
        yPt: midY + offsetY,
        size: 9,
        text: label,
      });
      if (lineId) setSelected(lineId);
      return;
    }
    if (newId) setSelected(newId);
    // Keep the tool active so users can make multiple shapes in a row.
  };

  // V1.0052: Edit Text on image-only PDFs via Apple Vision OCR. When the
  // user clicks on a page with no pdf.js text spans, render the page canvas
  // to PNG, run OCR (cached per page+version), find the box nearest the
  // click, and seed a pending text edit using OCR's text + position + size.
  // Same whiteout-and-retype flow as the text-layer path — just a different
  // source for the original-text rectangle.
  const runOcrFallback = async (e: React.MouseEvent<HTMLDivElement>) => {
    if (!pageSize || !containerRef.current || !canvasRef.current) return;
    const activeTab = useDocumentStore.getState().activeTab();
    if (!activeTab) return;

    const cacheKey = `${activeTab.id}-${activeTab.version}-${pageNumber}`;
    if (ocrInFlight.has(cacheKey)) return;
    let boxes = ocrCache.get(cacheKey);
    if (!boxes) {
      const ok = window.confirm(
        "No editable text on this page.\n\nRun OCR to make scanned text editable? (~2s)",
      );
      if (!ok) return;
      const ocrAvailable = await window.weavepdf.ocr.available();
      if (!ocrAvailable) {
        alert(
          "OCR helper isn't built. Reinstall WeavePDF to enable scanned-text editing.",
        );
        return;
      }
      ocrInFlight.add(cacheKey);
      try {
        const blob = await new Promise<Blob | null>((res) =>
          canvasRef.current!.toBlob((b) => res(b), "image/png"),
        );
        if (!blob) {
          alert("Couldn't read this page's image.");
          return;
        }
        const pngBytes = await blob.arrayBuffer();
        boxes = await window.weavepdf.ocr.runImage(pngBytes);
        if (boxes.length === 0) {
          alert("No text detected on this page.");
          return;
        }
        ocrCache.set(cacheKey, boxes);
      } finally {
        ocrInFlight.delete(cacheKey);
      }
    }

    // Click position in normalized image space, bottom-left origin to match
    // Apple Vision boundingBox.
    const pageRect = containerRef.current.getBoundingClientRect();
    const clickX = (e.clientX - pageRect.left) / pageRect.width;
    const clickYTop = (e.clientY - pageRect.top) / pageRect.height;
    const clickYBottom = 1 - clickYTop;

    // Containment first (the user clicked directly on a glyph), nearest-by-
    // center as fallback within ~5% of the page so far-misclicks bail out
    // instead of grabbing some random box across the page.
    let chosen: OcrBox | null = null;
    for (const b of boxes) {
      if (
        clickX >= b.x &&
        clickX <= b.x + b.w &&
        clickYBottom >= b.y &&
        clickYBottom <= b.y + b.h
      ) {
        chosen = b;
        break;
      }
    }
    if (!chosen) {
      let bestDist = Infinity;
      for (const b of boxes) {
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        const d = (cx - clickX) ** 2 + (cy - clickYBottom) ** 2;
        if (d < bestDist) {
          bestDist = d;
          chosen = b;
        }
      }
      if (!chosen || bestDist > 0.0025) {
        alert("No text near that point. Click closer to visible text.");
        return;
      }
    }

    // OCR boxes are normalized 0..1 with bottom-left origin — same
    // convention as PDF user space. Multiply by page-point dimensions to
    // land in PDF coords directly.
    const xPt = chosen.x * pageSize.w;
    const yPtBaseline = chosen.y * pageSize.h;
    const widthPt = chosen.w * pageSize.w;
    const heightPt = chosen.h * pageSize.h;
    // OCR box height ≈ font size in points (visible glyph extent including
    // descenders). Good enough — exact font fidelity is deferred per
    // Critical Rule #3 anyway.
    const fontSizePt = heightPt;
    // Same V1.0049 bearing nudge as the pdf.js path: pdf-lib's drawText
    // baseline-origin includes the new font's left side bearing, which would
    // push glyph 0 right of the OCR box's left edge.
    const bearingNudge = fontSizePt * 0.06;
    const xPtAdjusted = Math.max(0, xPt - bearingNudge);

    const newId = addPendingTextEdit(activeTab.id, {
      page: pageNumber,
      xPt: xPtAdjusted,
      yPt: yPtBaseline,
      size: fontSizePt,
      // OCR doesn't tell us the original font family — default to Helvetica.
      // True font fidelity needs font extraction + re-embedding (deferred).
      fontName: "Helvetica",
      text: chosen.text,
      whiteout: {
        x: xPt - 0.5,
        y: yPtBaseline - 0.5,
        width: widthPt + 1,
        height: heightPt + 1,
      },
    });
    useUIStore.getState().setSelectedPendingText(newId);
    useUIStore.getState().setEditingPendingText(newId);
    setTool("none");
  };

  // Click-to-edit on existing text: when the edit-text tool is active,
  // intercept clicks on the text layer spans, read their position + font
  // size, and stage a PendingTextEdit that will whiteout the original
  // region and draw the user's new text in its place.
  const onTextLayerClick = async (e: React.MouseEvent<HTMLDivElement>) => {
    if (tool !== "editText" || !pageSize) return;
    if (!containerRef.current) return;
    const span = (e.target as HTMLElement).closest("span") as HTMLElement | null;
    if (!span) {
      // V1.0052: image-only page → run OCR and pick the box nearest the click.
      // Only fires when pdf.js has zero text spans on this page, so a misclick
      // between paragraphs on a normal text-PDF stays a no-op (matches
      // pre-V1.0052 behavior).
      const layerHasText = textLayerRef.current?.querySelector("span") != null;
      if (layerHasText) return;
      e.preventDefault();
      e.stopPropagation();
      await runOcrFallback(e);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const pageRect = containerRef.current.getBoundingClientRect();
    const spanRect = span.getBoundingClientRect();
    const leftCss = spanRect.left - pageRect.left;
    const topCss = spanRect.top - pageRect.top;
    const widthCss = spanRect.width;
    const heightCss = spanRect.height;
    // Convert CSS → PDF points (Y flips).
    const xPt = leftCss / zoom;
    const yPtBaseline = pageSize.h - (topCss + heightCss) / zoom;
    const widthPt = widthCss / zoom;
    const heightPt = heightCss / zoom;
    const text = span.textContent ?? "";
    if (!text) return;
    // Match the original font family + weight + style to a pdf-lib standard
    // font so the replacement doesn't always collapse to Helvetica regular.
    const style = window.getComputedStyle(span);
    const { matchStandardFont } = await import("../../lib/pdf-ops");
    const weight = parseInt(style.fontWeight, 10);
    const isBold = Number.isFinite(weight) ? weight >= 600 : /bold/i.test(style.fontWeight);
    const isItalic = /italic|oblique/i.test(style.fontStyle);
    const fontName = matchStandardFont(style.fontFamily, isBold, isItalic);
    // V1.0048: pdf.js's TextLayer paints each item at its real font size in
    // CSS pixels (`style.fontSize`). Reading that and dividing by zoom gives
    // an exact PDF-point value — the previous `heightPt * 0.85` was a guess
    // off the bounding box, which produced a smaller-looking replacement
    // than the original (visible side-by-side in dense table rows).
    const fontSizePx = parseFloat(style.fontSize);
    const fontSizePt = Number.isFinite(fontSizePx) && fontSizePx > 0 ? fontSizePx / zoom : heightPt * 0.85;
    // V1.0049: pdf.js's TextLayer span left edge corresponds to the visible
    // glyph start (which includes the *original* font's left side bearing).
    // pdf-lib draws starting at the baseline origin and lets the new font's
    // own left side bearing push the first glyph right — net effect is the
    // replacement appears shifted ~0.05–0.10 fontSize to the right of the
    // original. Subtract a small empirical offset so the replacement lands
    // closer to where the original text was visible. Imperfect (true font
    // fidelity needs font extraction + re-embedding per Critical Rule #3),
    // but visually it removes the user-visible drift on common edits.
    const bearingNudge = fontSizePt * 0.06;
    const xPtAdjusted = Math.max(0, xPt - bearingNudge);
    const activeTab = useDocumentStore.getState().activeTab();
    if (!activeTab) return;
    const newId = addPendingTextEdit(activeTab.id, {
      page: pageNumber,
      xPt: xPtAdjusted,
      yPt: yPtBaseline,
      size: fontSizePt,
      text,
      fontName,
      whiteout: {
        // V1.0050: keep the whiteout tight to the bounding box — the prior
        // `(+1, +2, +2, +4)` padding ate into adjacent table-cell borders
        // when the original text sat close to a border. The pdf.js
        // bounding box already covers the visible glyph extent; a small
        // 0.5pt margin catches sub-pixel anti-aliasing without eating
        // anything meaningful.
        x: xPt - 0.5,
        y: yPtBaseline - 0.5,
        width: widthPt + 1,
        height: heightPt + 1,
      },
    });
    // Open the pending text immediately in edit mode — the original span's
    // text is pre-filled + selected so a single keystroke replaces it.
    useUIStore.getState().setSelectedPendingText(newId);
    useUIStore.getState().setEditingPendingText(newId);
    setTool("none");
  };

  const onContextMenu = async (e: React.MouseEvent<HTMLDivElement>) => {
    if (!pageSize) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const pdfX = clickX / zoom;
    const pdfYFromBottom = pageSize.h - clickY / zoom;

    const openCtx = useUIStore.getState().openContextMenu;
    const doPaste = async () => {
      try {
        const clipboardItems = await navigator.clipboard.read();
        for (const it of clipboardItems) {
          // Prefer image.
          for (const type of it.types) {
            if (type.startsWith("image/")) {
              const blob = await it.getType(type);
              const bytes = new Uint8Array(await blob.arrayBuffer());
              const mime: "image/png" | "image/jpeg" =
                type === "image/jpeg" || type === "image/jpg" ? "image/jpeg" : "image/png";
              const url = URL.createObjectURL(blob);
              const img = new Image();
              await new Promise<void>((res, rej) => {
                img.onload = () => res();
                img.onerror = () => rej(new Error("paste: decode failed"));
                img.src = url;
              });
              URL.revokeObjectURL(url);
              const maxW = Math.min(240, pageSize.w * 0.5);
              const w = Math.min(maxW, img.naturalWidth);
              const h = w * (img.naturalHeight / img.naturalWidth);
              useDocumentStore.getState().addPendingImageEdit(
                useDocumentStore.getState().activeTab()!.id,
                {
                  page: pageNumber,
                  xPt: pdfX - w / 2,
                  yPt: pdfYFromBottom - h / 2,
                  widthPt: w,
                  heightPt: h,
                  bytes,
                  mime,
                },
              );
              return;
            }
          }
        }
        // Fallback: text.
        const text = await navigator.clipboard.readText();
        if (text?.trim()) {
          useDocumentStore.getState().addPendingTextEdit(
            useDocumentStore.getState().activeTab()!.id,
            {
              page: pageNumber,
              xPt: pdfX,
              yPt: pdfYFromBottom,
              size: 12,
              text: text.trim(),
            },
          );
        }
      } catch {
        // Clipboard permission denied or empty — no-op.
      }
    };

    const copyPageText = async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        const tc = await page.getTextContent();
        type Item = { str: string; x: number; y: number; h: number };
        const items: Item[] = [];
        for (const raw of tc.items) {
          const it = raw as { str: string; transform: number[]; width?: number; height?: number };
          if (!it.str) continue;
          items.push({
            str: it.str,
            x: it.transform[4],
            y: it.transform[5],
            h: Math.abs(it.transform[0]) || it.height || 12,
          });
        }
        items.sort((a, b) => b.y - a.y || a.x - b.x);
        const avgH = items.reduce((acc, i) => acc + i.h, 0) / Math.max(1, items.length);
        const tolerance = Math.max(2, avgH * 0.5);
        type Line = { y: number; items: Item[] };
        const lines: Line[] = [];
        for (const i of items) {
          const line = lines.find((l) => Math.abs(l.y - i.y) < tolerance);
          if (line) line.items.push(i);
          else lines.push({ y: i.y, items: [i] });
        }
        const text = lines
          .map((l) =>
            l.items
              .sort((a, b) => a.x - b.x)
              .map((i) => i.str)
              .join(" ")
              .replace(/\s+/g, " ")
              .trim(),
          )
          .filter(Boolean)
          .join("\n");
        await navigator.clipboard.writeText(text);
      } catch {
        /* permission denied or empty */
      }
    };

    const copyPageAsImage = async () => {
      try {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const blob: Blob = await new Promise((res, rej) => {
          canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/png");
        });
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      } catch {
        /* permission denied */
      }
    };

    openCtx(e.clientX, e.clientY, [
      {
        kind: "item",
        label: "Paste here",
        shortcut: "⌘V",
        onClick: doPaste,
      },
      { kind: "item", label: "Copy page text", onClick: copyPageText },
      { kind: "item", label: "Copy page as image", onClick: copyPageAsImage },
      { kind: "separator" },
      {
        kind: "item",
        label: "Add text here",
        onClick: () => {
          setTextPrompt({ page: pageNumber, x: pdfX, y: pdfYFromBottom });
          setTool("text");
        },
      },
      {
        kind: "item",
        label: "Place image…",
        onClick: () => {
          // Reuse the existing image-picker; click location becomes the next
          // click's place point (the image tool drops on next canvas click).
          useUIStore.getState().openImagePicker();
        },
      },
      {
        kind: "item",
        label: "Sticky note…",
        onClick: () => {
          // Route through the inline StickyPromptOverlay (same as the tool
          // button) so we don't rely on window.prompt.
          useUIStore.getState().setStickyPrompt({
            page: pageNumber,
            xPt: pdfX,
            yPt: pdfYFromBottom,
          });
        },
      },
      { kind: "separator" },
      { kind: "item", label: "Highlight mode", onClick: () => setTool("highlight") },
      { kind: "item", label: "Whiteout mode", onClick: () => setTool("whiteout") },
      { kind: "item", label: "Redact region", onClick: () => setTool("redact") },
    ]);
  };

  return (
    <div
      ref={setRefs}
      data-page={pageNumber}
      data-edit-text={tool === "editText" ? "1" : undefined}
      className="relative rounded-[var(--radius-page)]"
      style={{
        // Until pdf.js gives us real dims, render at zero size so the
        // viewer's flex column has nothing to show — avoids the default
        // 612x792 placeholder briefly flashing for landscape / non-letter
        // PDFs. The placeholder is harmless in light mode but produces a
        // very visible white-on-dark flash in dark mode.
        width: dims?.w ?? 0,
        height: dims?.h ?? 0,
        // V1.0046: only show white background + drop shadow once the canvas
        // has painted. Before that, the wrapper inherits the app background
        // and is effectively invisible — no white flash on tab open.
        background: painted ? "#fff" : "transparent",
        boxShadow: painted ? "var(--page-shadow)" : "none",
      }}
      onClick={tool === "editText" ? onTextLayerClick : undefined}
      onContextMenu={onContextMenu}
    >
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: "100%", display: "block" }}
        className="rounded-[var(--radius-page)]"
      />
      <div ref={textLayerRef} className="textLayer" aria-hidden={false} />
      {pageSize && (
        <AcroFormLayer
          pdf={pdf}
          pageNumber={pageNumber}
          zoom={zoom}
          pageHeightPt={pageSize.h}
        />
      )}
      {toolActive && (
        <div
          onClick={isDragTool ? undefined : handleInteractionClick}
          onPointerDown={isDragTool ? pointerDownDrag : undefined}
          onPointerMove={isDragTool ? pointerMoveDrag : undefined}
          onPointerUp={isDragTool ? pointerUpDrag : undefined}
          className="absolute inset-0 z-10"
          style={{ cursor, outline: "2px dashed rgba(109,94,245,0.4)", outlineOffset: -2 }}
          data-testid="interaction-layer"
          data-tool={tool}
        >
          {dragBox && (
            <div
              className="pointer-events-none absolute"
              style={{
                left: dragBox.x,
                top: dragBox.y,
                width: dragBox.w,
                height: dragBox.h,
                background:
                  tool === "highlight"
                    ? "rgba(255, 230, 0, 0.4)"
                    : tool === "whiteout"
                      ? "rgba(255,255,255,0.85)"
                      : tool === "redact"
                        ? "rgba(0,0,0,0.85)"
                        : "transparent",
                border:
                  tool === "circle"
                    ? "1.5px solid rgba(30,30,30,0.9)"
                    : tool === "rect"
                      ? "1.5px solid rgba(30,30,30,0.9)"
                      : "1px dashed rgba(109,94,245,0.6)",
                borderRadius: tool === "circle" ? "50%" : 0,
              }}
            />
          )}
          {tool === "draw" && penPath.length > 1 && (
            <svg
              className="pointer-events-none absolute inset-0"
              width="100%"
              height="100%"
            >
              <path
                d={
                  `M ${penPath[0].x} ${penPath[0].y} ` +
                  penPath
                    .slice(1)
                    .map((p) => `L ${p.x} ${p.y}`)
                    .join(" ")
                }
                stroke="rgba(10,10,20,0.95)"
                strokeWidth={1.5}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </div>
      )}
      {dims && (
        <SearchHighlightLayer
          pageNumber={pageNumber}
          zoom={zoom}
          pageHeightPx={dims.h}
        />
      )}
      {dims && (
        <>
          <PendingTextLayer
            pageNumber={pageNumber}
            zoom={zoom}
            pageHeightPx={dims.h}
          />
          <PendingImageLayer
            pageNumber={pageNumber}
            zoom={zoom}
            pageHeightPx={dims.h}
          />
          <PendingShapeLayer
            pageNumber={pageNumber}
            zoom={zoom}
            pageHeightPx={dims.h}
          />
          <TextPromptOverlay
            pageNumber={pageNumber}
            zoom={zoom}
            pageHeightPx={dims.h}
          />
          <StickyPromptOverlay
            pageNumber={pageNumber}
            zoom={zoom}
            pageHeightPx={dims.h}
          />
        </>
      )}
    </div>
  );
});

async function dataUrlToBytes(dataUrl: string): Promise<Uint8Array> {
  const base64 = dataUrl.split(",", 2)[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
