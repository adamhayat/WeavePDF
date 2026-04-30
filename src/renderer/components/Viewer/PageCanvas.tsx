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
import { bytesToBlob } from "../../../shared/buffers";

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

  // Click-to-edit on existing text: when the edit-text tool is active,
  // intercept clicks on the text layer spans, read their position + font
  // size, and stage a PendingTextEdit that will whiteout the original
  // region and draw the user's new text in its place.
  const onTextLayerClick = async (e: React.MouseEvent<HTMLDivElement>) => {
    if (tool !== "editText" || !pageSize) return;
    const span = (e.target as HTMLElement).closest("span") as HTMLElement | null;
    if (!span || !containerRef.current) return;
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
    const activeTab = useDocumentStore.getState().activeTab();
    if (!activeTab) return;
    const newId = addPendingTextEdit(activeTab.id, {
      page: pageNumber,
      xPt,
      yPt: yPtBaseline,
      size: heightPt * 0.85, // span height ~ font size in CSS pixels; shrink a touch
      text,
      fontName,
      whiteout: {
        x: xPt - 1,
        y: yPtBaseline - 2,
        width: widthPt + 2,
        height: heightPt + 4,
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
      className="relative rounded-[var(--radius-page)] bg-white shadow-[var(--page-shadow)]"
      style={{ width: dims?.w ?? 612, height: dims?.h ?? 792 }}
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
