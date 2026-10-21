/**
 * V1.0125: bake every pending element into the PDF in the SAME stacking order
 * the viewer paints them (lib/layers.ts `bakeOrder`). Extracted from
 * `commitAllPending` so the unit tests exercise the exact code Save runs.
 *
 * Pre-V1.0125 the bake was hard-coded shapes → images → text while the viewer
 * painted text → images → shapes. A whiteout drawn over a text box therefore
 * hid it on screen but the saved file drew the text back ON TOP — Adam's
 * Scotiabank form showed "Condo / 485,000 / 2026/10/08" in Preview that he had
 * whited out in WeavePDF.
 *
 * `ops` is the pdf-ops module (the store lazy-loads it to keep pdf-lib out of
 * the boot chunk; tests import it directly).
 */
import type { PendingImageEdit, PendingShapeEdit, PendingTextEdit } from "../stores/document";
import type { BakedBBox } from "./pdf-ops";
import { bakeOrder } from "./layers";

type PdfOps = typeof import("./pdf-ops");

const PAGE_MARGIN = 36;
const MIN_WRAP_TEXT_WIDTH_PT = 120;

export async function bakeLayers(
  ops: PdfOps,
  input: Uint8Array,
  arrays: { text: PendingTextEdit[]; image: PendingImageEdit[]; shape: PendingShapeEdit[] },
  opts: { pageWidth: (page: number) => number; marginsEnabled: boolean },
): Promise<{ bytes: Uint8Array; textBoxes: Map<string, BakedBBox> }> {
  let bytes = input;
  const textBoxes = new Map<string, BakedBBox>();

  const bakeText = async (e: PendingTextEdit) => {
    // A text box's own Edit-Text whiteout is drawn immediately before its
    // text, i.e. AT the text's layer — the viewer paints it the same way.
    if (e.whiteout) {
      bytes = await ops.whiteoutRegion(bytes, e.page, e.whiteout);
    }
    const pageW = opts.pageWidth(e.page);
    const rightBound = opts.marginsEnabled ? pageW - PAGE_MARGIN : pageW;
    const maxAllowed = Math.max(36, rightBound - e.xPt);
    const minWrapWidth = e.whiteout != null
      ? 36
      : Math.min(MIN_WRAP_TEXT_WIDTH_PT, maxAllowed);
    const effectiveWidth = e.whiteout != null
      ? e.widthPt ?? null
      : e.widthPt != null
        ? Math.max(minWrapWidth, Math.min(e.widthPt, maxAllowed))
        : maxAllowed;
    let baked: BakedBBox | null = null;
    if (effectiveWidth != null) {
      const r = await ops.drawWrappedText(bytes, e.page, {
        x: e.xPt,
        y: e.yPt,
        widthPt: effectiveWidth,
        size: e.size,
        text: e.text,
        font: e.fontName as Parameters<PdfOps["drawText"]>[2]["font"],
        bold: e.bold,
        italic: e.italic,
        align: e.align,
        color: e.color,
      });
      bytes = r.bytes;
      baked = r.bbox;
    } else {
      const r = await ops.drawText(bytes, e.page, {
        x: e.xPt,
        y: e.yPt,
        size: e.size,
        text: e.text,
        font: e.fontName as Parameters<PdfOps["drawText"]>[2]["font"],
        bold: e.bold,
        italic: e.italic,
        color: e.color,
      });
      bytes = r.bytes;
      baked = r.bbox;
    }
    if (baked) textBoxes.set(e.id, baked);
  };

  const drawAll = async (start: Uint8Array): Promise<void> => {
  bytes = start;
  for (const layer of bakeOrder(arrays)) {
    if (layer.kind === "text") {
      await bakeText(layer.edit);
      continue;
    }
    if (layer.kind === "image") {
      const e = layer.edit;
      const imageBytes = (e.flipH || e.flipV)
        ? await ops.flipImageBytes(e.bytes, e.mime, { flipH: e.flipH, flipV: e.flipV })
        : e.bytes;
      const imageMime: "image/png" | "image/jpeg" = (e.flipH || e.flipV) ? "image/png" : e.mime;
      bytes = await ops.placeImage(bytes, e.page, imageBytes, imageMime, {
        x: e.xPt,
        y: e.yPt,
        width: e.widthPt,
        height: e.heightPt,
      }, {
        rotation: e.rotation,
        opacity: e.opacity,
        border: e.border,
        dropShadow: e.dropShadow,
      });
      continue;
    }
    const e = layer.edit;
    switch (e.kind) {
      case "rect":
        bytes = await ops.drawRect(bytes, e.page, { x: e.xPt, y: e.yPt, width: e.widthPt, height: e.heightPt }, { color: e.color, thickness: e.thickness });
        break;
      case "ellipse":
        bytes = await ops.drawCircle(bytes, e.page, { x: e.xPt, y: e.yPt, width: e.widthPt, height: e.heightPt }, { color: e.color, thickness: e.thickness });
        break;
      case "line":
        bytes = await ops.drawLine(bytes, e.page, { x: e.fromX, y: e.fromY }, { x: e.toX, y: e.toY }, { color: e.color, thickness: e.thickness });
        break;
      case "arrow":
        bytes = await ops.drawArrow(bytes, e.page, { x: e.fromX, y: e.fromY }, { x: e.toX, y: e.toY }, { color: e.color, thickness: e.thickness });
        break;
      case "freehand":
        bytes = await ops.drawPath(bytes, e.page, e.points, { color: e.color, thickness: e.thickness });
        break;
      case "highlight":
        bytes = await ops.drawHighlight(bytes, e.page, { x: e.xPt, y: e.yPt, width: e.widthPt, height: e.heightPt });
        break;
      case "whiteout":
        bytes = await ops.whiteoutRegion(bytes, e.page, { x: e.xPt, y: e.yPt, width: e.widthPt, height: e.heightPt });
        break;
      case "redact":
        bytes = await ops.redactRegion(bytes, e.page, { x: e.xPt, y: e.yPt, width: e.widthPt, height: e.heightPt });
        break;
      case "sticky":
        bytes = await ops.drawStickyNote(bytes, e.page, { x: e.xPt, y: e.yPt }, e.text);
        break;
    }
  }
  };

  // V1.0126: draw everything into ONE loaded document (see pdf-ops
  // `bakeInOnePass`) — ~8 s → well under a second on Adam's 52-element form.
  // A redaction rasterises the page through pdf.js from real bytes, so a
  // document with one takes the old one-element-at-a-time path.
  if (arrays.shape.some((e) => e.kind === "redact")) {
    await drawAll(input);
    return { bytes, textBoxes };
  }
  const out = await ops.bakeInOnePass(input, drawAll);
  return { bytes: out, textBoxes };
}
