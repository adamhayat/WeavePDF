// Wrappers around pdf-lib for the editing operations Phase 1-3 need.
// Every op takes Uint8Array(s) and returns new Uint8Array; the caller
// re-loads pdf.js with the result so the viewer stays in sync.

import {
  PDFDocument,
  degrees,
  StandardFonts,
  rgb,
  PDFTextField,
  PDFCheckBox,
  PDFDropdown,
  PDFRadioGroup,
  PDFOptionList,
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFString,
  PDFRef,
} from "pdf-lib";
import type { PDFPage } from "pdf-lib";

/** V1.0104: bake-side translation between the renderer's coordinate space
 *  and pdf-lib's PDF user space. The renderer captures every overlay
 *  position MediaBox-relative — i.e. (0, 0) is the lower-left of the
 *  visible page — because that's what the click→PDF conversion in
 *  PageCanvas yields (`pageSize.h - clickY / zoom` returns a value in
 *  [0, MediaBoxHeight]). PDFs whose MediaBox lower-left is non-zero
 *  (Canva exports ship with `[0, 7.83, 595.5, 850.08]`) silently shifted
 *  every baked edit by `mediaBox.y` before V1.0104, because pdf-lib's
 *  drawText / drawRectangle / drawImage treat their x/y as raw user-space
 *  coords with no awareness of the page origin. The fix: every bake site
 *  that consumes caller-supplied positions adds this origin to the
 *  pdf-lib args. `getCropBox()` matches what pdf.js renders (it returns
 *  the CropBox if set, falling back to the MediaBox otherwise). */
function pageContentOrigin(page: PDFPage): { x: number; y: number } {
  const box = page.getCropBox();
  return { x: box.x, y: box.y };
}

type Rotation = 0 | 90 | 180 | 270;

function toUint8(bytes: Uint8Array): Uint8Array {
  // Some pdf-lib saves return a wider typed array; normalise.
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/** Load without throwing on PDFs with invalid xrefs (common in the wild). */
async function load(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
}

/** Merge N source PDFs, in order, into a single output. */
export async function mergePdfs(sources: Uint8Array[]): Promise<Uint8Array> {
  if (sources.length === 0) throw new Error("mergePdfs: empty sources");
  if (sources.length === 1) return toUint8(sources[0]);
  const out = await PDFDocument.create();
  for (const bytes of sources) {
    const src = await load(bytes);
    const copied = await out.copyPages(src, src.getPageIndices());
    for (const p of copied) out.addPage(p);
  }
  return toUint8(await out.save());
}

/** Insert `newBytes` into `base` after `afterPage1Based` (0 = at beginning). */
export async function insertAfter(
  base: Uint8Array,
  newBytes: Uint8Array,
  afterPage1Based: number,
): Promise<Uint8Array> {
  const out = await load(base);
  const src = await load(newBytes);
  const copied = await out.copyPages(src, src.getPageIndices());
  const insertAt = Math.max(0, Math.min(afterPage1Based, out.getPageCount()));
  for (let i = 0; i < copied.length; i++) {
    out.insertPage(insertAt + i, copied[i]);
  }
  return toUint8(await out.save());
}

/** Page count of a PDF byte stream. Cheap pdf-lib parse; use when you
 *  just need the count without rendering or extracting pages. */
export async function countPages(bytes: Uint8Array): Promise<number> {
  const doc = await load(bytes);
  return doc.getPageCount();
}

/**
 * V1.0056: produce a brand-new single-page blank PDF. Used by the "New
 * Blank PDF" command (⌘N) and the DropZone's "Create blank PDF" button.
 * Default size is US Letter portrait (612 × 792 pt). Pdf-lib's
 * `PDFDocument.create()` already emits a syntactically-valid skeleton
 * with no metadata — perfect for "Untitled".
 */
export async function createBlankPdf(opts?: {
  paper?: "letter" | "legal" | "a4";
  orientation?: "portrait" | "landscape";
}): Promise<Uint8Array> {
  const paper = opts?.paper ?? "letter";
  const orientation = opts?.orientation ?? "portrait";
  // Dimensions in PDF points (1pt = 1/72 inch).
  const sizes: Record<NonNullable<typeof paper>, [number, number]> = {
    letter: [612, 792],
    legal: [612, 1008],
    a4: [595.276, 841.89],
  };
  const [w, h] = sizes[paper];
  const doc = await PDFDocument.create();
  doc.addPage(orientation === "landscape" ? [h, w] : [w, h]);
  return toUint8(await doc.save());
}

/** Remove the given 1-based page numbers. Silently ignores out-of-range. */
export async function deletePages(
  base: Uint8Array,
  pages1Based: number[],
): Promise<Uint8Array> {
  const src = await load(base);
  const keepIndexes = src
    .getPageIndices()
    .filter((i) => !pages1Based.includes(i + 1));
  if (keepIndexes.length === 0) throw new Error("Cannot delete all pages");
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, keepIndexes);
  for (const p of copied) out.addPage(p);
  return toUint8(await out.save());
}

/**
 * Rotate the given 1-based pages by `deltaDegrees` (must be a multiple of 90).
 * Positive = clockwise.
 */
export async function rotatePages(
  base: Uint8Array,
  pages1Based: number[],
  deltaDegrees: 90 | -90 | 180,
): Promise<Uint8Array> {
  const doc = await load(base);
  for (const p of pages1Based) {
    const idx = p - 1;
    if (idx < 0 || idx >= doc.getPageCount()) continue;
    const page = doc.getPage(idx);
    const current = (page.getRotation().angle as Rotation) ?? 0;
    const next = (((current + deltaDegrees) % 360) + 360) % 360;
    page.setRotation(degrees(next));
  }
  return toUint8(await doc.save());
}

/**
 * V1.0090: insert a blank page immediately after the given 1-based
 * page. Size defaults to the active doc's first page (PDF Expert
 * convention — match existing layout unless overridden). Pass
 * `page1Based: 0` (or undefined) to append at end-of-doc.
 *
 * Adam's brief: "There should be a new page button in the left sidebar
 * — I don't see a way to do it except dragging one page can somehow
 * make another which I didn't get but it worked." Drag-to-duplicate
 * stays as a power-user shortcut; this is the explicit UI path.
 */
export async function insertBlankPageAfter(
  base: Uint8Array,
  page1Based: number,
  opts: { size?: [number, number] } = {},
): Promise<Uint8Array> {
  const doc = await load(base);
  const pageCount = doc.getPageCount();
  // Resolve size — caller override → first-page size → US Letter.
  let size: [number, number];
  if (opts.size) {
    size = opts.size;
  } else if (pageCount > 0) {
    const first = doc.getPage(0).getSize();
    size = [first.width, first.height];
  } else {
    size = [612, 792]; // US Letter portrait
  }
  const insertIdx = page1Based <= 0 || page1Based >= pageCount
    ? pageCount
    : page1Based;
  doc.insertPage(insertIdx, size);
  return toUint8(await doc.save());
}

/** Duplicate the given 1-based page, inserting the copy immediately after it. */
export async function duplicatePage(
  base: Uint8Array,
  page1Based: number,
): Promise<Uint8Array> {
  const doc = await load(base);
  const idx = page1Based - 1;
  if (idx < 0 || idx >= doc.getPageCount()) return toUint8(await doc.save());
  const [copied] = await doc.copyPages(doc, [idx]);
  doc.insertPage(idx + 1, copied);
  return toUint8(await doc.save());
}

/** Reorder pages by 0-based source indices. Must cover every page exactly once. */
export async function reorderPages(
  base: Uint8Array,
  newOrder0Based: number[],
): Promise<Uint8Array> {
  const src = await load(base);
  const n = src.getPageCount();
  if (newOrder0Based.length !== n) {
    throw new Error(`reorderPages: expected ${n} indices, got ${newOrder0Based.length}`);
  }
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, newOrder0Based);
  for (const p of copied) out.addPage(p);
  return toUint8(await out.save());
}

/**
 * Wrap an image (PNG, JPG) as a 1-page PDF sized to the image at 72dpi.
 * HEIC isn't supported by pdf-lib; caller must decode first.
 */
export async function imageToPdf(imageBytes: Uint8Array, mime: string): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  let img;
  if (mime === "image/png") {
    img = await out.embedPng(imageBytes);
  } else if (mime === "image/jpeg" || mime === "image/jpg") {
    img = await out.embedJpg(imageBytes);
  } else {
    throw new Error(`imageToPdf: unsupported mime type: ${mime}`);
  }
  // Target dim: fit within US Letter (612x792) with margin; scale down only.
  const pageW = 612;
  const pageH = 792;
  const margin = 36;
  const maxW = pageW - margin * 2;
  const maxH = pageH - margin * 2;
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  const page = out.addPage([pageW, pageH]);
  page.drawImage(img, {
    x: (pageW - drawW) / 2,
    y: (pageH - drawH) / 2,
    width: drawW,
    height: drawH,
  });
  return toUint8(await out.save());
}

/**
 * Decode arbitrary image bytes (including HEIC) in the renderer via <canvas>
 * and re-encode as PNG so pdf-lib can embed them.
 */
export async function decodeImageToPng(blob: Blob): Promise<Uint8Array> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("Image decode failed"));
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D context");
    ctx.drawImage(img, 0, 0);
    const pngBlob = await new Promise<Blob | null>((res) =>
      canvas.toBlob((b) => res(b), "image/png"),
    );
    if (!pngBlob) throw new Error("Canvas toBlob failed");
    return new Uint8Array(await pngBlob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Draw a white rectangle over the given region (whiteout). */
export async function whiteoutRegion(
  base: Uint8Array,
  page1Based: number,
  // coords are MediaBox-relative — (0, 0) is the lower-left of the visible
  // page. V1.0104 routes them through pageContentOrigin() so PDFs whose
  // MediaBox lower-left is non-zero (Canva exports) place correctly.
  region: { x: number; y: number; width: number; height: number },
): Promise<Uint8Array> {
  const doc = await load(base);
  const page = doc.getPage(page1Based - 1);
  const origin = pageContentOrigin(page);
  page.drawRectangle({
    x: region.x + origin.x,
    y: region.y + origin.y,
    width: region.width,
    height: region.height,
    color: rgb(1, 1, 1),
    borderWidth: 0,
  });
  return toUint8(await doc.save());
}

/** Draw text at a point — used by the whiteout+retype edit flow. */
/**
 * Pick the closest pdf-lib StandardFont for a given CSS font-family + weight
 * + style combo. Used by Edit-Existing-Text so replacement text looks like
 * the original instead of always landing in Helvetica regular.
 */
export function matchStandardFont(
  family: string | undefined | null,
  bold: boolean,
  italic: boolean,
): StandardFonts {
  const f = (family ?? "").toLowerCase();
  if (f.includes("times") || f.includes("serif")) {
    if (bold && italic) return StandardFonts.TimesRomanBoldItalic;
    if (bold) return StandardFonts.TimesRomanBold;
    if (italic) return StandardFonts.TimesRomanItalic;
    return StandardFonts.TimesRoman;
  }
  if (f.includes("courier") || f.includes("mono")) {
    if (bold && italic) return StandardFonts.CourierBoldOblique;
    if (bold) return StandardFonts.CourierBold;
    if (italic) return StandardFonts.CourierOblique;
    return StandardFonts.Courier;
  }
  // Default to Helvetica family (Arial/Calibri/Verdana/etc. are close enough).
  if (bold && italic) return StandardFonts.HelveticaBoldOblique;
  if (bold) return StandardFonts.HelveticaBold;
  if (italic) return StandardFonts.HelveticaOblique;
  return StandardFonts.Helvetica;
}

/** V1.0072: a bake region in PDF coords (y = bottom-left origin). Returned
 *  alongside the bytes from drawText / drawWrappedText so the commit flow
 *  can store it in the round-trip metadata — the next open uses it as the
 *  whiteout that covers the previously-baked content. */
export type BakedBBox = { x: number; y: number; width: number; height: number };

export async function drawText(
  base: Uint8Array,
  page1Based: number,
  opts: {
    x: number; // points, bottom-left origin
    y: number;
    size: number;
    text: string;
    color?: { r: number; g: number; b: number };
    font?: StandardFonts;
    /** V1.0057: bold / italic flags. If provided, they override the
     *  variant of `font` (e.g. Helvetica + bold → Helvetica-Bold). Lets
     *  the pending text edit's runtime toggles map cleanly to pdf-lib
     *  StandardFonts without having to parse / rewrite `font` upstream. */
    bold?: boolean;
    italic?: boolean;
  },
): Promise<{ bytes: Uint8Array; bbox: BakedBBox | null }> {
  const doc = await load(base);
  const page = doc.getPage(page1Based - 1);
  // Pick the right family variant when bold/italic toggles are set.
  // matchStandardFont takes a CSS-like family string; pdf-lib's
  // StandardFonts enum values double as the family key ("Helvetica",
  // "TimesRoman", "Courier") so we can pass `opts.font` straight through.
  const base0 = opts.font ?? StandardFonts.Helvetica;
  const resolved =
    opts.bold || opts.italic
      ? matchStandardFont(base0, !!opts.bold, !!opts.italic)
      : base0;
  const font = await doc.embedFont(resolved);
  const c = opts.color ?? { r: 0, g: 0, b: 0 };
  const origin = pageContentOrigin(page);
  page.drawText(opts.text, {
    x: opts.x + origin.x,
    y: opts.y + origin.y,
    size: opts.size,
    font,
    color: rgb(c.r, c.g, c.b),
  });
  const width = opts.text.length === 0
    ? 0
    : font.widthOfTextAtSize(opts.text, opts.size);
  // V1.0104: bbox stays MediaBox-relative (no `+ origin`). It's stored in
  // WeavePDFEdits metadata as the next-open's whiteout; the whiteout baker
  // applies its own origin shift at draw time, so the saved value must
  // remain in the same coord system the renderer uses.
  const bbox: BakedBBox | null = width > 0
    ? {
        // Pad slightly so the next-save whiteout fully covers anti-aliased
        // glyph extents (descenders, italic shear).
        x: opts.x - 1,
        y: opts.y - opts.size * 0.3,
        width: width + 2,
        height: opts.size * 1.15,
      }
    : null;
  return { bytes: toUint8(await doc.save()), bbox };
}

/**
 * V1.0062: draw word-wrapped text into a fixed-width box. The `widthPt`
 * is the maximum line width in PDF points; lines are broken at word
 * boundaries via `font.widthOfTextAtSize` measurements. Honors explicit
 * `\n` newlines in `text`. Single words that exceed `widthPt` get pushed
 * onto their own line (slight overflow rather than mid-word break — pdf-
 * lib's standard fonts don't ship a hyphenation table).
 *
 * Y semantics match `drawText`: `opts.y` is the baseline of the FIRST
 * (topmost) line. Subsequent lines are drawn at `y - n * size * 1.2` to
 * match the on-screen `lineHeight: 1.2` used in PendingTextLayer.
 */
export async function drawWrappedText(
  base: Uint8Array,
  page1Based: number,
  opts: {
    x: number;
    y: number;
    widthPt: number;
    size: number;
    text: string;
    color?: { r: number; g: number; b: number };
    font?: StandardFonts;
    bold?: boolean;
    italic?: boolean;
    /** V1.0069: paragraph alignment within the wrap width. */
    align?: "left" | "center" | "right" | "justify";
  },
): Promise<{ bytes: Uint8Array; bbox: BakedBBox | null }> {
  const doc = await load(base);
  const page = doc.getPage(page1Based - 1);
  const base0 = opts.font ?? StandardFonts.Helvetica;
  const resolved =
    opts.bold || opts.italic
      ? matchStandardFont(base0, !!opts.bold, !!opts.italic)
      : base0;
  const font = await doc.embedFont(resolved);
  const c = opts.color ?? { r: 0, g: 0, b: 0 };
  const align = opts.align ?? "left";
  // V1.0104: shift caller-supplied MediaBox-relative coords into pdf-lib's
  // PDF user space. Single shift applied once at the top so the wrap +
  // alignment + per-line cursor math below stays unaware of the offset.
  const origin = pageContentOrigin(page);

  // Build wrapped lines, remembering which ones are hard-wrapped (next is
  // a forced newline or end of text) — justify skips those because the
  // last line of a paragraph stays left-aligned in every word processor.
  const lines: { text: string; isLastInPara: boolean }[] = [];
  const paragraphs = opts.text.split("\n");
  for (let p = 0; p < paragraphs.length; p++) {
    const rawLine = paragraphs[p];
    if (rawLine.length === 0) {
      lines.push({ text: "", isLastInPara: true });
      continue;
    }
    const words = rawLine.split(/(\s+)/);
    let current = "";
    const paraLines: string[] = [];
    for (const tok of words) {
      const candidate = current + tok;
      const w = font.widthOfTextAtSize(candidate, opts.size);
      if (w <= opts.widthPt || current.length === 0) {
        current = candidate;
      } else {
        paraLines.push(current.replace(/\s+$/, ""));
        current = tok.replace(/^\s+/, "");
      }
    }
    if (current.length > 0) paraLines.push(current);
    for (let i = 0; i < paraLines.length; i++) {
      lines.push({ text: paraLines[i], isLastInPara: i === paraLines.length - 1 });
    }
  }

  // V1.0077: alignment reference is the LONGEST WRAPPED LINE, not the
  // wrap-box width. Adam's feedback: short lines should center / right-
  // align against the actual rendered text bounds, not against the
  // outer dashed frame's right edge. We pre-compute max line width so
  // the draw loop can use it as the alignment anchor's right edge.
  let maxLineWidth = 0;
  for (const { text } of lines) {
    if (text.length === 0) continue;
    const w = font.widthOfTextAtSize(text, opts.size);
    if (w > maxLineWidth) maxLineWidth = w;
  }
  const alignBoxWidth = maxLineWidth > 0 ? maxLineWidth : opts.widthPt;

  const lineGap = opts.size * 1.2;
  let cursorY = opts.y;
  for (const { text, isLastInPara } of lines) {
    if (text.length > 0) {
      const lineW = font.widthOfTextAtSize(text, opts.size);
      let drawX = opts.x;
      if (align === "center") {
        drawX = opts.x + Math.max(0, (alignBoxWidth - lineW) / 2);
      } else if (align === "right") {
        drawX = opts.x + Math.max(0, alignBoxWidth - lineW);
      } else if (align === "justify" && !isLastInPara) {
        // Distribute extra space across word gaps so each line fills
        // the alignment box (= longest line). Drop trailing/leading
        // whitespace; rebuild the line word-by-word with computed gaps.
        const tokens = text.trim().split(/\s+/).filter((t) => t.length > 0);
        if (tokens.length > 1) {
          const wordsW = tokens.reduce(
            (acc, t) => acc + font.widthOfTextAtSize(t, opts.size),
            0,
          );
          const gap = (alignBoxWidth - wordsW) / (tokens.length - 1);
          let x = opts.x;
          for (const tok of tokens) {
            page.drawText(tok, {
              x: x + origin.x,
              y: cursorY + origin.y,
              size: opts.size,
              font,
              color: rgb(c.r, c.g, c.b),
            });
            x += font.widthOfTextAtSize(tok, opts.size) + gap;
          }
          cursorY -= lineGap;
          continue;
        }
      }
      page.drawText(text, {
        x: drawX + origin.x,
        y: cursorY + origin.y,
        size: opts.size,
        font,
        color: rgb(c.r, c.g, c.b),
      });
    }
    cursorY -= lineGap;
  }
  // V1.0072 → V1.0077: bbox always uses the longest-line width (anchored
  // at opts.x). With alignment now relative to maxLineWidth, the painted
  // glyphs sit between opts.x and opts.x + maxLineWidth regardless of the
  // chosen alignment — so the whiteout we store for round-trip restoration
  // can hug the actual content extent on the next save.
  let bbox: BakedBBox | null = null;
  if (maxLineWidth > 0) {
    const linesCount = lines.length;
    const topY = opts.y + opts.size * 0.85;
    const bottomY = opts.y - (linesCount - 1) * lineGap - opts.size * 0.3;
    bbox = {
      x: opts.x - 1,
      y: bottomY - 1,
      width: maxLineWidth + 2,
      height: topY - bottomY + 2,
    };
  }
  return { bytes: toUint8(await doc.save()), bbox };
}

/** V1.0072: WeavePDF stores its round-trip metadata under this key in the
 *  PDF Info dictionary. Custom Info-dict keys are non-standard but legal
 *  PDF — other readers silently ignore them. Other PDF tools see the
 *  baked content normally; only WeavePDF restores the overlays. */
export const WEAVE_INFO_KEY = "WeavePDFEdits";

/** V1.0072/V1.0078: round-trip metadata payload. Version 1 stored text
 *  only. Version 2 stores the full WeavePDF overlay layer (text, images,
 *  shapes) so a file saved from WeavePDF reopens with its own elements
 *  selectable/editable again. */
export type WeavePdfMetadata = {
  version: 1 | 2;
  textEdits: WeavePdfTextEdit[];
  imageEdits: WeavePdfImageEdit[];
  shapeEdits: WeavePdfShapeEdit[];
};

export type WeavePdfTextEdit = {
  page: number;
  xPt: number;
  yPt: number;
  size: number;
  text: string;
  widthPt?: number;
  bold?: boolean;
  italic?: boolean;
  align?: "left" | "center" | "right" | "justify";
  fontName?: string;
  /** Region the previous bake actually covered, in PDF coords. The next
   *  open uses this as the overlay's `whiteout` field so the baked text
   *  visible underneath gets covered while the editable overlay floats
   *  on top. */
  whiteout: { x: number; y: number; width: number; height: number };
};

export type WeavePdfImageEdit = {
  page: number;
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
  mime: "image/png" | "image/jpeg";
  dataBase64: string;
  /** V1.0091: full image format options now round-trip on save+reopen.
   *  Pre-V1.0091 these were stored on `PendingImageEdit` but stripped at
   *  serialization time, so a user who rotated/flipped/dimmed an image
   *  saw their adjustments lost on close+reopen. Each is optional so
   *  v:2 files saved by V1.0090 (no fields) still load correctly. */
  rotation?: number;
  opacity?: number;
  flipH?: boolean;
  flipV?: boolean;
  /** V1.0091: image "layer style" attributes (Photoshop term). Border
   *  is an inside-stroke around the image's rendered bounds (no
   *  growth into the image area itself). Drop shadow renders a
   *  blurred translucent rect beneath the image. Both are baked at
   *  commit time and round-tripped via this schema. */
  border?: { widthPt: number; color: { r: number; g: number; b: number } };
  dropShadow?: {
    offsetXPt: number;
    offsetYPt: number;
    blurPt: number;
    opacity: number;
    color: { r: number; g: number; b: number };
  };
};

export type WeavePdfShapeEdit = { page: number } & (
  | { kind: "rect"; xPt: number; yPt: number; widthPt: number; heightPt: number; color: { r: number; g: number; b: number }; thickness: number }
  | { kind: "ellipse"; xPt: number; yPt: number; widthPt: number; heightPt: number; color: { r: number; g: number; b: number }; thickness: number }
  | { kind: "line"; fromX: number; fromY: number; toX: number; toY: number; color: { r: number; g: number; b: number }; thickness: number }
  | { kind: "arrow"; fromX: number; fromY: number; toX: number; toY: number; color: { r: number; g: number; b: number }; thickness: number }
  | { kind: "freehand"; points: Array<{ x: number; y: number }>; color: { r: number; g: number; b: number }; thickness: number }
  | { kind: "highlight"; xPt: number; yPt: number; widthPt: number; heightPt: number }
  | { kind: "whiteout"; xPt: number; yPt: number; widthPt: number; heightPt: number }
  | { kind: "redact"; xPt: number; yPt: number; widthPt: number; heightPt: number }
  | { kind: "sticky"; xPt: number; yPt: number; text: string }
);

/** V1.0091: canary string appended to the PDF's `/Keywords` Info-dict
 *  entry on every save. On reopen, the existence of this string in
 *  Keywords combined with the ABSENCE of `WeavePDFEdits` means another
 *  tool (Acrobat's "Optimize PDF", PDF/A converters, command-line
 *  flatteners) stripped our custom Info key — but Keywords typically
 *  survives those transforms. The app uses this to surface a non-modal
 *  "WeavePDF edits were stripped" toast on reopen instead of silently
 *  treating the file as a fresh PDF. */
export const WEAVE_CANARY_PREFIX = "WeavePDFv2:";

function appendKeywordCanary(infoDict: PDFDict, ctx: import("pdf-lib").PDFContext): void {
  // Read existing Keywords, append our canary if not already present.
  const existing = infoDict.get(PDFName.of("Keywords"));
  let prior = "";
  if (existing instanceof PDFString) prior = existing.decodeText();
  if (prior.includes(WEAVE_CANARY_PREFIX)) return; // idempotent
  const stamp = WEAVE_CANARY_PREFIX + new Date().toISOString().slice(0, 10);
  const joined = prior ? `${prior}; ${stamp}` : stamp;
  infoDict.set(PDFName.of("Keywords"), PDFString.of(joined));
  void ctx;
}

/** Stash a `WeavePdfMetadata` payload inside the PDF's Info dictionary
 *  under `WEAVE_INFO_KEY`. Replaces any existing entry; preserves all
 *  other Info-dict keys (Title, Author, etc.).
 *  V1.0091: also stamps a `WeavePDFv2:` canary into /Keywords so a
 *  later reopen can detect when our custom Info key was stripped by
 *  Acrobat / PDF optimizers (Keywords survives those transforms;
 *  custom Info keys often don't). */
export async function embedWeaveMetadata(
  bytes: Uint8Array,
  payload: WeavePdfMetadata,
): Promise<Uint8Array> {
  const doc = await load(bytes);
  const ctx = doc.context;
  const trailer = ctx.trailerInfo as { Info?: PDFRef };
  let infoDict: PDFDict;
  if (trailer.Info) {
    const looked = ctx.lookup(trailer.Info);
    if (looked instanceof PDFDict) {
      infoDict = looked;
    } else {
      infoDict = ctx.obj({}) as PDFDict;
      trailer.Info = ctx.register(infoDict);
    }
  } else {
    infoDict = ctx.obj({}) as PDFDict;
    trailer.Info = ctx.register(infoDict);
  }
  infoDict.set(PDFName.of(WEAVE_INFO_KEY), PDFString.of(JSON.stringify(payload)));
  appendKeywordCanary(infoDict, ctx);
  return toUint8(await doc.save());
}

/** V1.0091: check whether the PDF's /Keywords field contains the
 *  WeavePDF canary. Used by the reopen path to detect "I saved this
 *  in WeavePDF but my metadata is missing" — Acrobat-strip case. */
export async function detectWeaveCanaryWithoutMetadata(
  bytes: Uint8Array,
): Promise<boolean> {
  try {
    const doc = await load(bytes);
    const ctx = doc.context;
    const trailer = ctx.trailerInfo as { Info?: PDFRef };
    if (!trailer.Info) return false;
    const looked = ctx.lookup(trailer.Info);
    if (!(looked instanceof PDFDict)) return false;
    // If our actual metadata is present, this isn't a stripped file.
    if (looked.get(PDFName.of(WEAVE_INFO_KEY))) return false;
    const kw = looked.get(PDFName.of("Keywords"));
    if (!(kw instanceof PDFString)) return false;
    return kw.decodeText().includes(WEAVE_CANARY_PREFIX);
  } catch {
    return false;
  }
}

/** Inverse of `embedWeaveMetadata`. Returns `null` if no metadata was
 *  stored (a plain PDF, or one saved by a different tool). Tolerant of
 *  malformed JSON — returns `null` rather than throwing. */
export async function extractWeaveMetadata(
  bytes: Uint8Array,
): Promise<WeavePdfMetadata | null> {
  try {
    const doc = await load(bytes);
    const ctx = doc.context;
    const trailer = ctx.trailerInfo as { Info?: PDFRef };
    if (!trailer.Info) return null;
    const looked = ctx.lookup(trailer.Info);
    if (!(looked instanceof PDFDict)) return null;
    const val = looked.get(PDFName.of(WEAVE_INFO_KEY));
    if (!val) return null;
    let raw: string;
    if (val instanceof PDFString) {
      raw = val.decodeText();
    } else {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as {
      version?: unknown;
      textEdits?: unknown;
      imageEdits?: unknown;
      shapeEdits?: unknown;
    };
    if (obj.version !== 1 && obj.version !== 2) return null;
    if (!Array.isArray(obj.textEdits)) return null;
    return {
      version: obj.version,
      textEdits: obj.textEdits as WeavePdfTextEdit[],
      imageEdits: Array.isArray(obj.imageEdits) ? obj.imageEdits as WeavePdfImageEdit[] : [],
      shapeEdits: Array.isArray(obj.shapeEdits) ? obj.shapeEdits as WeavePdfShapeEdit[] : [],
    };
  } catch {
    return null;
  }
}

/**
 * Draw a translucent highlight over a rectangular region.
 * Intended for annotate flow.
 */
export async function drawHighlight(
  base: Uint8Array,
  page1Based: number,
  region: { x: number; y: number; width: number; height: number },
  color: { r: number; g: number; b: number } = { r: 1, g: 0.9, b: 0 },
): Promise<Uint8Array> {
  const doc = await load(base);
  const page = doc.getPage(page1Based - 1);
  const origin = pageContentOrigin(page);
  page.drawRectangle({
    x: region.x + origin.x,
    y: region.y + origin.y,
    width: region.width,
    height: region.height,
    color: rgb(color.r, color.g, color.b),
    opacity: 0.4,
    borderWidth: 0,
  });
  return toUint8(await doc.save());
}

/** Embed an image at the given region on a page (for signatures).
 *  V1.0090: `opts` adds rotation (degrees CCW around the region's
 *  centroid) + opacity (0..1) — must-haves from the agent's image
 *  options research. Flip H/V is handled by the caller pre-flipping
 *  the canvas pixels before calling placeImage; pdf-lib's drawImage
 *  doesn't support a sign-flip primitive and a canvas re-encode is
 *  simpler than wrapping the page in a transform matrix.
 *  Defaults preserve pre-V1.0090 behaviour exactly. */
export async function placeImage(
  base: Uint8Array,
  page1Based: number,
  imageBytes: Uint8Array,
  mime: "image/png" | "image/jpeg",
  region: { x: number; y: number; width: number; height: number },
  opts: {
    rotation?: number;
    opacity?: number;
    /** V1.0091: inside-stroke border around the image's rendered
     *  rectangle. Doesn't grow the image — the stroke is centred on
     *  the rect's outline, half inside / half outside as pdf-lib draws
     *  it. `widthPt = 0` = no border (same as omitting). */
    border?: { widthPt: number; color: { r: number; g: number; b: number } };
    /** V1.0091: blurred translucent rectangle drawn beneath the image
     *  (drawn FIRST, then the image on top). Blur is approximated via
     *  N concentric semi-transparent rects offset by `blurPt / N`
     *  pixels — pdf-lib has no real Gaussian filter, so we fake the
     *  look. Good enough for prosumer print preview. */
    dropShadow?: {
      offsetXPt: number;
      offsetYPt: number;
      blurPt: number;
      opacity: number;
      color: { r: number; g: number; b: number };
    };
  } = {},
): Promise<Uint8Array> {
  const doc = await load(base);
  const page = doc.getPage(page1Based - 1);
  const img =
    mime === "image/png"
      ? await doc.embedPng(imageBytes)
      : await doc.embedJpg(imageBytes);
  const rot = ((opts.rotation ?? 0) % 360 + 360) % 360;
  const opacity = Math.max(0, Math.min(1, opts.opacity ?? 1));
  const w = region.width;
  const h = region.height;
  // V1.0104: shift caller-supplied MediaBox-relative coords into pdf-lib's
  // PDF user space. Applied at the centroid so the rotation math below
  // stays unchanged (the shift composes with the centroid translate).
  const origin = pageContentOrigin(page);
  // pdf-lib's drawImage `rotate` option rotates around the draw
  // origin (= bottom-left of the un-rotated rectangle). To rotate
  // around the visual CENTER (the user expectation when they say
  // "rotate this image"), shift the origin so the centroid lands at
  // (cx, cy) after rotation. Centroid of un-rotated img is (w/2, h/2);
  // under rotation θ that maps to (w/2·cosθ − h/2·sinθ, w/2·sinθ +
  // h/2·cosθ) relative to origin. So origin = centroid − that.
  const cx = region.x + origin.x + w / 2;
  const cy = region.y + origin.y + h / 2;
  const θ = (rot * Math.PI) / 180;
  const cosθ = Math.cos(θ);
  const sinθ = Math.sin(θ);
  const ox = cx - (w / 2) * cosθ + (h / 2) * sinθ;
  const oy = cy - (w / 2) * sinθ - (h / 2) * cosθ;

  // V1.0091: drop shadow BEFORE the image, so the image renders on
  // top. The shadow is positioned offset from the image's centroid
  // by (offsetXPt, offsetYPt) in PDF coords (Y up = shadow moves
  // up; user-visual convention has shadows dropping DOWN, so the UI
  // negates Y at input time). Blur is faked by stacking N rects
  // at increasing alpha — pdf-lib doesn't expose a Gaussian filter.
  // For rotated images the shadow follows the rotation by mirroring
  // the same origin-shift math.
  if (opts.dropShadow && opts.dropShadow.opacity > 0) {
    const ds = opts.dropShadow;
    const blurSteps = ds.blurPt > 0 ? 5 : 1;
    const stepBlur = ds.blurPt / blurSteps;
    const stepOpacity = ds.opacity / blurSteps;
    for (let i = 0; i < blurSteps; i++) {
      const grow = stepBlur * i;
      const sw = w + grow * 2;
      const sh = h + grow * 2;
      const scx = cx + ds.offsetXPt;
      const scy = cy + ds.offsetYPt;
      const sox = scx - (sw / 2) * cosθ + (sh / 2) * sinθ;
      const soy = scy - (sw / 2) * sinθ - (sh / 2) * cosθ;
      page.drawRectangle({
        x: sox,
        y: soy,
        width: sw,
        height: sh,
        color: rgb(ds.color.r, ds.color.g, ds.color.b),
        opacity: stepOpacity,
        rotate: rot ? degrees(rot) : undefined,
        borderWidth: 0,
      });
    }
  }

  page.drawImage(img, {
    x: ox,
    y: oy,
    width: w,
    height: h,
    rotate: rot ? degrees(rot) : undefined,
    opacity,
  });

  // V1.0091: border AFTER the image so the stroke sits on top of the
  // image edge. pdf-lib's drawRectangle with no fill (`color: undefined`)
  // doesn't work — we have to use `borderColor` + `borderWidth` and
  // explicitly omit `color` to keep the fill transparent.
  if (opts.border && opts.border.widthPt > 0) {
    page.drawRectangle({
      x: ox,
      y: oy,
      width: w,
      height: h,
      borderColor: rgb(opts.border.color.r, opts.border.color.g, opts.border.color.b),
      borderWidth: opts.border.widthPt,
      rotate: rot ? degrees(rot) : undefined,
      // Important: do NOT set `color` — that would fill the rectangle
      // with that color and cover the image we just drew.
      opacity: 1,
    });
  }

  return toUint8(await doc.save());
}

/** V1.0090: flip image bytes horizontally and/or vertically via canvas.
 *  Returns PNG bytes (always — JPEG round-trips to PNG, lossy is
 *  acceptable for an explicit user flip action). Used at commit time
 *  for image overlays whose pending state has flipH / flipV set. */
export async function flipImageBytes(
  bytes: Uint8Array,
  mime: "image/png" | "image/jpeg",
  opts: { flipH?: boolean; flipV?: boolean },
): Promise<Uint8Array> {
  if (!opts.flipH && !opts.flipV) return bytes;
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("flipImageBytes: decode failed"));
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("flipImageBytes: no 2D context");
    const sx = opts.flipH ? -1 : 1;
    const sy = opts.flipV ? -1 : 1;
    ctx.translate(opts.flipH ? canvas.width : 0, opts.flipV ? canvas.height : 0);
    ctx.scale(sx, sy);
    ctx.drawImage(img, 0, 0);
    const out = await new Promise<Blob>((res, rej) => {
      canvas.toBlob((b) => (b ? res(b) : rej(new Error("flipImageBytes: toBlob failed"))), "image/png");
    });
    return new Uint8Array(await out.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Light compression: re-save with pdf-lib's object stream compression.
 * This is not as aggressive as Ghostscript's /ebook preset; treat it as a
 * placeholder until the gs binary is bundled.
 */
export async function compressLight(base: Uint8Array): Promise<Uint8Array> {
  const doc = await load(base);
  const out = await doc.save({ useObjectStreams: true });
  return toUint8(out);
}

// ─── Shape primitives — each one bakes a vector annotation into the PDF ───

type RGB = { r: number; g: number; b: number };
type StrokeOpts = {
  color?: RGB;
  thickness?: number;
  opacity?: number;
};

export async function drawRect(
  base: Uint8Array,
  page1Based: number,
  region: { x: number; y: number; width: number; height: number },
  opts: StrokeOpts & { fill?: RGB | null } = {},
): Promise<Uint8Array> {
  const doc = await load(base);
  const page = doc.getPage(page1Based - 1);
  const origin = pageContentOrigin(page);
  const c = opts.color ?? { r: 0, g: 0, b: 0 };
  const f = opts.fill ?? null;
  page.drawRectangle({
    x: region.x + origin.x,
    y: region.y + origin.y,
    width: region.width,
    height: region.height,
    borderColor: rgb(c.r, c.g, c.b),
    borderWidth: opts.thickness ?? 1.5,
    opacity: opts.opacity ?? 1,
    color: f ? rgb(f.r, f.g, f.b) : undefined,
  });
  return toUint8(await doc.save());
}

export async function drawCircle(
  base: Uint8Array,
  page1Based: number,
  region: { x: number; y: number; width: number; height: number },
  opts: StrokeOpts & { fill?: RGB | null } = {},
): Promise<Uint8Array> {
  const doc = await load(base);
  const page = doc.getPage(page1Based - 1);
  const origin = pageContentOrigin(page);
  const c = opts.color ?? { r: 0, g: 0, b: 0 };
  const f = opts.fill ?? null;
  // pdf-lib's drawEllipse uses center + radii.
  page.drawEllipse({
    x: region.x + origin.x + region.width / 2,
    y: region.y + origin.y + region.height / 2,
    xScale: region.width / 2,
    yScale: region.height / 2,
    borderColor: rgb(c.r, c.g, c.b),
    borderWidth: opts.thickness ?? 1.5,
    opacity: opts.opacity ?? 1,
    color: f ? rgb(f.r, f.g, f.b) : undefined,
  });
  return toUint8(await doc.save());
}

export async function drawLine(
  base: Uint8Array,
  page1Based: number,
  start: { x: number; y: number },
  end: { x: number; y: number },
  opts: StrokeOpts = {},
): Promise<Uint8Array> {
  const doc = await load(base);
  const page = doc.getPage(page1Based - 1);
  const origin = pageContentOrigin(page);
  const c = opts.color ?? { r: 0, g: 0, b: 0 };
  page.drawLine({
    start: { x: start.x + origin.x, y: start.y + origin.y },
    end: { x: end.x + origin.x, y: end.y + origin.y },
    color: rgb(c.r, c.g, c.b),
    thickness: opts.thickness ?? 1.5,
    opacity: opts.opacity ?? 1,
  });
  return toUint8(await doc.save());
}

/** Line with a solid triangular arrowhead at the end point. */
export async function drawArrow(
  base: Uint8Array,
  page1Based: number,
  start: { x: number; y: number },
  end: { x: number; y: number },
  opts: StrokeOpts = {},
): Promise<Uint8Array> {
  const doc = await load(base);
  const page = doc.getPage(page1Based - 1);
  const origin = pageContentOrigin(page);
  const c = opts.color ?? { r: 0, g: 0, b: 0 };
  const thickness = opts.thickness ?? 1.5;
  // V1.0104: shift the caller-supplied MediaBox-relative endpoints into
  // pdf-lib's user space up front, so every derived point (shaft, head,
  // SVG anchor) inherits the offset uniformly.
  const startU = { x: start.x + origin.x, y: start.y + origin.y };
  const endU = { x: end.x + origin.x, y: end.y + origin.y };

  // Shaft: stop a bit short of the tip so the arrowhead meets cleanly.
  const dx = endU.x - startU.x;
  const dy = endU.y - startU.y;
  const len = Math.hypot(dx, dy);
  if (len < 2) {
    page.drawLine({ start: startU, end: endU, color: rgb(c.r, c.g, c.b), thickness });
    return toUint8(await doc.save());
  }
  const ux = dx / len;
  const uy = dy / len;
  const headLen = Math.max(8, thickness * 4);
  const headWidth = Math.max(6, thickness * 3);
  const shaftEnd = { x: endU.x - ux * headLen * 0.6, y: endU.y - uy * headLen * 0.6 };
  page.drawLine({
    start: startU,
    end: shaftEnd,
    color: rgb(c.r, c.g, c.b),
    thickness,
    opacity: opts.opacity ?? 1,
  });

  // Arrowhead triangle — two points perpendicular to the shaft, one at the tip.
  const px = -uy;
  const py = ux;
  const baseCenter = { x: endU.x - ux * headLen, y: endU.y - uy * headLen };
  const left = {
    x: baseCenter.x + px * (headWidth / 2),
    y: baseCenter.y + py * (headWidth / 2),
  };
  const right = {
    x: baseCenter.x - px * (headWidth / 2),
    y: baseCenter.y - py * (headWidth / 2),
  };
  page.drawSvgPath(
    `M ${left.x} ${left.y} L ${endU.x} ${endU.y} L ${right.x} ${right.y} Z`,
    {
      color: rgb(c.r, c.g, c.b),
      borderColor: rgb(c.r, c.g, c.b),
      borderWidth: 0,
      opacity: opts.opacity ?? 1,
      // drawSvgPath draws from top-left; we pass in absolute PDF coords.
      x: 0,
      y: page.getHeight(),
    },
  );
  return toUint8(await doc.save());
}

/** Crop every page by the given margins (points). Positive values shrink the page. */
export async function cropPages(
  base: Uint8Array,
  margins: { top: number; bottom: number; left: number; right: number },
): Promise<Uint8Array> {
  const doc = await load(base);
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const nx = Math.max(0, margins.left);
    const ny = Math.max(0, margins.bottom);
    const nw = Math.max(10, width - margins.left - margins.right);
    const nh = Math.max(10, height - margins.top - margins.bottom);
    page.setCropBox(nx, ny, nw, nh);
    page.setMediaBox(nx, ny, nw, nh);
  }
  return toUint8(await doc.save());
}

/**
 * Stamp a repeating header and/or footer, optionally with page numbers.
 * {format} may contain `{n}` and `{total}` tokens.
 */
export async function drawHeaderFooter(
  base: Uint8Array,
  opts: {
    header?: string;
    footer?: string;
    pageNumberFormat?: string; // e.g. "Page {n} of {total}"
    pageNumberPosition?: "footer" | "header";
    size?: number;
    margin?: number;
    color?: RGB;
  },
): Promise<Uint8Array> {
  const doc = await load(base);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const color = opts.color ?? { r: 0.25, g: 0.25, b: 0.27 };
  const size = opts.size ?? 10;
  const margin = opts.margin ?? 24;
  const pages = doc.getPages();
  const total = pages.length;
  pages.forEach((page, i) => {
    const { width, height } = page.getSize();
    // V1.0104: margin is "distance from visible page edge", so anchor at
    // the CropBox origin (= 0,0 for normal PDFs, non-zero for Canva and
    // similar). Without this, the header/footer drift onto the MediaBox
    // outside the visible page bounds.
    const origin = pageContentOrigin(page);
    const yHeader = origin.y + height - margin;
    const yFooter = origin.y + margin - size * 0.2;
    if (opts.header) {
      const tw = font.widthOfTextAtSize(opts.header, size);
      page.drawText(opts.header, {
        x: origin.x + (width - tw) / 2,
        y: yHeader,
        size,
        font,
        color: rgb(color.r, color.g, color.b),
      });
    }
    if (opts.footer) {
      const tw = font.widthOfTextAtSize(opts.footer, size);
      page.drawText(opts.footer, {
        x: origin.x + (width - tw) / 2,
        y: yFooter,
        size,
        font,
        color: rgb(color.r, color.g, color.b),
      });
    }
    if (opts.pageNumberFormat) {
      const label = opts.pageNumberFormat
        .replace(/\{n\}/g, String(i + 1))
        .replace(/\{total\}/g, String(total));
      const tw = font.widthOfTextAtSize(label, size);
      const y = opts.pageNumberPosition === "header" ? yHeader : yFooter;
      // Bottom-right page number is the conventional layout.
      page.drawText(label, {
        x: origin.x + width - margin - tw,
        y,
        size,
        font,
        color: rgb(color.r, color.g, color.b),
      });
    }
  });
  return toUint8(await doc.save());
}

/**
 * Place a sticky-note annotation: a small yellow square that reads like a
 * legal-pad note. The text is baked next to the marker.
 */
export async function drawStickyNote(
  base: Uint8Array,
  page1Based: number,
  position: { x: number; y: number },
  text: string,
): Promise<Uint8Array> {
  const doc = await load(base);
  const page = doc.getPage(page1Based - 1);
  const origin = pageContentOrigin(page);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boxSize = 16;
  // V1.0104: shift the caller-supplied MediaBox-relative origin into pdf-
  // lib's user space; the marker rect, folded-corner SVG, and note text
  // all derive from `pos` so a single shift covers them.
  const pos = { x: position.x + origin.x, y: position.y + origin.y };
  // Marker square
  page.drawRectangle({
    x: pos.x,
    y: pos.y,
    width: boxSize,
    height: boxSize,
    color: rgb(1, 0.87, 0.35),
    borderColor: rgb(0.75, 0.6, 0.1),
    borderWidth: 0.8,
  });
  // Folded-corner triangle for character.
  page.drawSvgPath(
    `M ${pos.x + boxSize - 5} ${page.getHeight() - pos.y - boxSize + 5}
     L ${pos.x + boxSize} ${page.getHeight() - pos.y - boxSize + 5}
     L ${pos.x + boxSize} ${page.getHeight() - pos.y} Z`,
    {
      color: rgb(0.95, 0.8, 0.2),
      x: 0,
      y: page.getHeight(),
    },
  );
  // Text to the right of the marker.
  const wrapped = wrapText(text, font, 10, 220);
  let y = pos.y + boxSize - 10;
  for (const line of wrapped) {
    page.drawText(line, {
      x: pos.x + boxSize + 6,
      y,
      size: 10,
      font,
      color: rgb(0.1, 0.1, 0.12),
    });
    y -= 12;
  }
  return toUint8(await doc.save());
}

function wrapText(
  text: string,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  size: number,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    const tentative = current ? `${current} ${w}` : w;
    if (font.widthOfTextAtSize(tentative, size) <= maxWidth) {
      current = tentative;
    } else {
      if (current) lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Extract the given 1-based pages into a new PDF. */
export async function extractPages(
  base: Uint8Array,
  pages1Based: number[],
): Promise<Uint8Array> {
  const src = await load(base);
  const indexes = pages1Based
    .map((p) => p - 1)
    .filter((i) => i >= 0 && i < src.getPageCount());
  if (indexes.length === 0) throw new Error("extractPages: no valid pages");
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, indexes);
  for (const p of copied) out.addPage(p);
  return toUint8(await out.save());
}

/** Set document metadata (title, author, subject, keywords). */
export async function setMetadata(
  base: Uint8Array,
  meta: {
    title?: string;
    author?: string;
    subject?: string;
    keywords?: string[];
  },
): Promise<Uint8Array> {
  const doc = await load(base);
  if (meta.title !== undefined) doc.setTitle(meta.title);
  if (meta.author !== undefined) doc.setAuthor(meta.author);
  if (meta.subject !== undefined) doc.setSubject(meta.subject);
  if (meta.keywords !== undefined) doc.setKeywords(meta.keywords);
  doc.setProducer("WeavePDF");
  return toUint8(await doc.save());
}

/** Get current metadata for display in an editor. */
export async function getMetadata(base: Uint8Array): Promise<{
  title: string;
  author: string;
  subject: string;
  keywords: string;
  producer: string;
  pageCount: number;
}> {
  const doc = await load(base);
  return {
    title: doc.getTitle() ?? "",
    author: doc.getAuthor() ?? "",
    subject: doc.getSubject() ?? "",
    keywords: (doc.getKeywords() ?? "").trim(),
    producer: doc.getProducer() ?? "",
    pageCount: doc.getPageCount(),
  };
}

/**
 * Draw a freeform path from an ordered list of points.
 * Points are in PDF user-space (bottom-left origin).
 */
export async function drawPath(
  base: Uint8Array,
  page1Based: number,
  points: { x: number; y: number }[],
  opts: StrokeOpts = {},
): Promise<Uint8Array> {
  if (points.length < 2) return base;
  const doc = await load(base);
  const page = doc.getPage(page1Based - 1);
  const origin = pageContentOrigin(page);
  const c = opts.color ?? { r: 0.1, g: 0.1, b: 0.1 };
  // pdf-lib's drawSvgPath treats the path's y as growing DOWN from {x, y}.
  // Anchor at (0, pageHeight) and flip each y into DOM-style coords.
  // V1.0104: shift the SVG anchor by `origin.y` so the y-flip pivots
  // around the visible page top, and shift each path x by `origin.x` so
  // the caller's MediaBox-relative coords land at the right user-space x.
  // Composed math: PDF_y = (pageHeight + origin.y) − (pageHeight − points[i].y)
  // = origin.y + points[i].y, which is the user-space position of the
  // caller's MediaBox-relative point.
  const pageHeight = page.getHeight();
  const d =
    `M ${points[0].x + origin.x} ${pageHeight - points[0].y} ` +
    points
      .slice(1)
      .map((p) => `L ${p.x + origin.x} ${pageHeight - p.y}`)
      .join(" ");
  page.drawSvgPath(d, {
    borderColor: rgb(c.r, c.g, c.b),
    borderWidth: opts.thickness ?? 1.5,
    borderOpacity: opts.opacity ?? 1,
    x: 0,
    y: pageHeight + origin.y,
  });
  return toUint8(await doc.save());
}

/**
 * Render every page of a PDF to Markdown. Uses pdf.js text content positions
 * to reconstruct reading order per page. Heuristic heading detection by
 * font-size outlier compared to the page average.
 */
export async function pdfToMarkdown(bytes: Uint8Array): Promise<string> {
  const { pdfjsLib } = await import("./pdfjs");
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  try {
    const chunks: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      type Item = { str: string; y: number; x: number; size: number };
      const items: Item[] = [];
      for (const raw of tc.items) {
        const it = raw as { str: string; transform: number[]; width?: number; height?: number };
        if (!it.str) continue;
        const y = Math.round(it.transform[5]);
        const x = it.transform[4];
        // Transform[0] is x-scale, roughly proportional to font size.
        const size = Math.abs(it.transform[0]) || it.height || 12;
        items.push({ str: it.str, y, x, size });
      }
      // Group into lines by y (within 2 units is "same line").
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      type Line = { y: number; items: Item[]; maxSize: number };
      const lines: Line[] = [];
      for (const it of items) {
        const last = lines[lines.length - 1];
        if (last && Math.abs(last.y - it.y) < 2) {
          last.items.push(it);
          last.maxSize = Math.max(last.maxSize, it.size);
        } else {
          lines.push({ y: it.y, items: [it], maxSize: it.size });
        }
      }

      if (lines.length === 0) {
        chunks.push(`## Page ${i}\n\n_(no extractable text — likely a scanned image)_`);
        continue;
      }

      const avgSize =
        lines.reduce((acc, l) => acc + l.maxSize, 0) / lines.length;
      const headingThreshold = avgSize * 1.35;

      chunks.push(`## Page ${i}\n`);
      let lastWasHeading = false;
      for (const line of lines) {
        const text = line.items
          .sort((a, b) => a.x - b.x)
          .map((i) => i.str)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (!text) continue;
        if (line.maxSize > headingThreshold) {
          chunks.push(`\n### ${text}\n`);
          lastWasHeading = true;
        } else {
          chunks.push(lastWasHeading ? text : text);
          lastWasHeading = false;
        }
      }
      chunks.push("");
    }
    return chunks.join("\n").trim() + "\n";
  } finally {
    void pdf.destroy();
  }
}

/**
 * Find every occurrence of `query` across the document using pdf.js text
 * positions, whiteout each match, and stamp `replacement` in the same place.
 * Returns the rewritten bytes plus the number of replacements made.
 *
 * Trade-offs:
 * - Case-insensitive matching.
 * - Matches that span multiple pdf.js text items aren't handled (an item is
 *   roughly one text run as emitted by the PDF). Most forms / docs split at
 *   natural whitespace, so word-level replacement works; replacing phrases
 *   that cross runs will miss some occurrences.
 * - Character positioning uses a uniform `item.width / item.str.length`
 *   assumption. Accurate for mono fonts; close enough for prose fonts.
 */
export async function replaceAllText(
  base: Uint8Array,
  query: string,
  replacement: string,
): Promise<{ bytes: Uint8Array; replaced: number }> {
  if (!query) return { bytes: base, replaced: 0 };
  const { pdfjsLib } = await import("./pdfjs");
  const pdf = await pdfjsLib.getDocument({ data: base.slice() }).promise;
  type Match = { page: number; x: number; y: number; w: number; h: number; size: number };
  const matches: Match[] = [];
  const q = query.toLowerCase();
  try {
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      for (const raw of content.items) {
        const item = raw as { str: string; transform: number[]; width: number };
        if (!item.str) continue;
        const lc = item.str.toLowerCase();
        let from = 0;
        while (true) {
          const idx = lc.indexOf(q, from);
          if (idx === -1) break;
          const itemX = item.transform[4];
          const itemY = item.transform[5];
          const fontSize = Math.abs(item.transform[0]) || 12;
          const charWidth = item.width / Math.max(1, item.str.length);
          matches.push({
            page: p,
            x: itemX + idx * charWidth,
            y: itemY,
            w: charWidth * query.length,
            h: fontSize * 1.2,
            size: fontSize,
          });
          from = idx + q.length;
        }
      }
    }
  } finally {
    void pdf.destroy();
  }

  if (matches.length === 0) return { bytes: base, replaced: 0 };
  const doc = await load(base);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const m of matches) {
    if (m.page < 1 || m.page > doc.getPageCount()) continue;
    const page = doc.getPage(m.page - 1);
    page.drawRectangle({
      x: m.x - 1,
      y: m.y - m.h * 0.2,
      width: m.w + 2,
      height: m.h,
      color: rgb(1, 1, 1),
      opacity: 1,
      borderWidth: 0,
    });
    if (replacement) {
      page.drawText(replacement, {
        x: m.x,
        y: m.y,
        size: m.size,
        font,
        color: rgb(0, 0, 0),
      });
    }
  }
  return { bytes: toUint8(await doc.save()), replaced: matches.length };
}

/**
 * Stamp sequential Bates numbers in the footer of every page. Convention
 * for legal document production: `PREFIX0001`, `PREFIX0002`, ... starting
 * at `start` and zero-padded to `digits`. Placed bottom-left in the footer
 * margin so it stays out of the way of content-area page numbers.
 */
export async function drawBatesNumbers(
  base: Uint8Array,
  opts: { prefix: string; start: number; digits: number; size?: number; margin?: number },
): Promise<Uint8Array> {
  const doc = await load(base);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const size = opts.size ?? 9;
  const margin = opts.margin ?? 24;
  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const label = opts.prefix + String(opts.start + i).padStart(opts.digits, "0");
    // V1.0104: anchor the bottom-left Bates stamp at the visible page edge.
    const origin = pageContentOrigin(page);
    page.drawText(label, {
      x: origin.x + margin,
      y: origin.y + margin - size * 0.2,
      size,
      font,
      color: rgb(0.2, 0.2, 0.25),
    });
  }
  return toUint8(await doc.save());
}

// ─── OCR text-layer application ───────────────────────────────────────────

export type OcrPageResult = {
  /** 1-based page number */
  page: number;
  /** Vision bounding boxes for this page, in normalised 0..1 bottom-left coords. */
  boxes: Array<{ text: string; x: number; y: number; w: number; h: number }>;
};

/**
 * Given a set of OCR results keyed by page, draw an invisible text layer
 * at each recognized region so the PDF becomes searchable + selectable.
 * The visible page is untouched — text is drawn with `opacity: 0`.
 *
 * Call this after running `window.weavepdf.ocr.runImage` against each page's
 * rendered PNG; the caller decides which pages to OCR (typically all of them).
 */
export async function applyOcrTextLayer(
  base: Uint8Array,
  results: OcrPageResult[],
): Promise<Uint8Array> {
  const doc = await load(base);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const { page: pageNum, boxes } of results) {
    if (pageNum < 1 || pageNum > doc.getPageCount()) continue;
    const page = doc.getPage(pageNum - 1);
    const { width, height } = page.getSize();
    // V1.0104: OCR boxes are normalised 0..1 against the visible page, so
    // anchor at the CropBox origin so the hidden text layer aligns with
    // the rendered glyphs on PDFs with a non-zero MediaBox lower-left.
    const origin = pageContentOrigin(page);
    for (const b of boxes) {
      const text = b.text.trim();
      if (!text) continue;
      const x = origin.x + b.x * width;
      const y = origin.y + b.y * height;
      const h = Math.max(b.h * height, 1);
      // Size: fit the region's height (subtract a sliver for descenders).
      const size = Math.max(4, h * 0.85);
      page.drawText(text, {
        x,
        y,
        size,
        font,
        color: rgb(0, 0, 0),
        opacity: 0, // invisible; still extractable by search / copy / export.
      });
    }
  }
  return toUint8(await doc.save());
}

// ─── AcroForm (fillable PDF forms) ────────────────────────────────────────

export type FormFieldInfo =
  | { name: string; kind: "text"; value: string; multiline: boolean; readOnly: boolean }
  | { name: string; kind: "checkbox"; checked: boolean; readOnly: boolean }
  | { name: string; kind: "radio"; options: string[]; selected: string | undefined; readOnly: boolean }
  | { name: string; kind: "dropdown"; options: string[]; selected: string | undefined; readOnly: boolean }
  | { name: string; kind: "optionList"; options: string[]; selected: string[]; readOnly: boolean };

export type FormFieldValue =
  | { name: string; kind: "text"; value: string }
  | { name: string; kind: "checkbox"; checked: boolean }
  | { name: string; kind: "radio"; selected: string | null }
  | { name: string; kind: "dropdown"; selected: string | null }
  | { name: string; kind: "optionList"; selected: string[] };

/** Return a description of every fillable form field. */
export async function getFormFields(base: Uint8Array): Promise<FormFieldInfo[]> {
  const doc = await load(base);
  let form;
  try {
    form = doc.getForm();
  } catch {
    return [];
  }
  const out: FormFieldInfo[] = [];
  for (const field of form.getFields()) {
    const name = field.getName();
    const readOnly = field.isReadOnly();
    if (field instanceof PDFTextField) {
      out.push({
        name,
        kind: "text",
        value: field.getText() ?? "",
        multiline: field.isMultiline(),
        readOnly,
      });
    } else if (field instanceof PDFCheckBox) {
      out.push({ name, kind: "checkbox", checked: field.isChecked(), readOnly });
    } else if (field instanceof PDFRadioGroup) {
      out.push({
        name,
        kind: "radio",
        options: field.getOptions(),
        selected: field.getSelected() ?? undefined,
        readOnly,
      });
    } else if (field instanceof PDFDropdown) {
      const sel = field.getSelected();
      out.push({
        name,
        kind: "dropdown",
        options: field.getOptions(),
        selected: sel[0],
        readOnly,
      });
    } else if (field instanceof PDFOptionList) {
      out.push({
        name,
        kind: "optionList",
        options: field.getOptions(),
        selected: field.getSelected(),
        readOnly,
      });
    }
  }
  return out;
}

/**
 * Apply form field values. When `flatten` is true, the form is rendered
 * to static page content — values can no longer be edited but are baked
 * in and will display in every PDF viewer. Recommended for completed forms.
 */
export async function setFormFields(
  base: Uint8Array,
  values: FormFieldValue[],
  opts: { flatten?: boolean } = {},
): Promise<Uint8Array> {
  const doc = await load(base);
  const form = doc.getForm();
  for (const v of values) {
    try {
      const field = form.getField(v.name);
      if (v.kind === "text" && field instanceof PDFTextField) {
        field.setText(v.value);
        // V1.0038: pdf-lib's appearance generator computes the content
        // rect inside a text widget as
        //   contentRect = widgetRect - 2 * (borderWidth + 1)
        // (see node_modules/pdf-lib/cjs/api/form/appearances.js). With the
        // default borderWidth of 0, content gets just 1pt of internal
        // padding — invisible at 100% zoom — so typed text appears flush
        // against the left/top/bottom borders.
        //
        // Fix: set the widget's BorderStyle width to ~3pt. pdf-lib will
        // then build the appearance with 3+1=4pt of internal padding
        // per side. Border COLOR is left unset, so the border doesn't
        // visibly draw — we get padding for free without a visible line.
        // Plus set an explicit font size that fits the padded content
        // area so text doesn't get auto-sized to fill the whole widget.
        try {
          const widgets = field.acroField.getWidgets();
          for (const widget of widgets) {
            const rect = widget.getRectangle();
            const fieldHeight = Math.abs(rect.height);
            // Pick a border-width that gives meaningful padding without
            // dwarfing tiny fields. 3pt for normal fields (~22pt tall),
            // 1pt for cramped ones (≤16pt).
            const padBorder = fieldHeight >= 16 ? 3 : 1;
            const bs = widget.getOrCreateBorderStyle();
            bs.setWidth(padBorder);
          }
          // Font size: clamp to leave breathing room above/below text.
          const firstRect = widgets[0]?.getRectangle();
          if (firstRect) {
            const fieldHeight = Math.abs(firstRect.height);
            // padBorder*2 + padding*2 = padding total per axis; leave
            // ~4pt extra for visible cap height. Clamp 8..14pt.
            const padBorder = fieldHeight >= 16 ? 3 : 1;
            const usable = fieldHeight - 2 * (padBorder + 1);
            const target = Math.max(8, Math.min(14, usable - 2));
            field.setFontSize(target);
          }
        } catch {
          // Some fields don't support setFontSize / setBorderStyle (e.g.
          // multiline with explicit DA); leave as-is rather than abort.
        }
      } else if (v.kind === "checkbox" && field instanceof PDFCheckBox) {
        if (v.checked) field.check();
        else field.uncheck();
      } else if (v.kind === "radio" && field instanceof PDFRadioGroup) {
        if (v.selected) field.select(v.selected);
      } else if (v.kind === "dropdown" && field instanceof PDFDropdown) {
        if (v.selected) field.select(v.selected);
      } else if (v.kind === "optionList" && field instanceof PDFOptionList) {
        if (v.selected.length > 0) field.select(v.selected);
      }
    } catch {
      // Unknown field / type mismatch — skip rather than abort the whole save.
    }
  }
  // V1.0038: explicitly generate appearance streams for every dirty field.
  // pdf-lib's setText only updates /V (the value); without /AP, viewers
  // (Preview, pdf.js) auto-generate appearances at render time using their
  // own padding rules — which ignore our BorderStyle width hack and re-flush
  // the text to the border. updateFieldAppearances bakes the actual /AP
  // stream into the PDF using pdf-lib's drawTextField (which DOES respect
  // BorderStyle.W for content-rect inset). Now every viewer renders the
  // same padded text we computed.
  try {
    form.updateFieldAppearances();
  } catch {
    // Font-embed failures or unusual field types — fall through to save
    // without baking; viewer-side auto-appearance still works (just no
    // padding control).
  }
  if (opts.flatten) {
    try {
      form.flatten();
    } catch {
      /* some forms can't be flattened; fall back to keeping them interactive */
    }
  }
  return toUint8(await doc.save());
}

/**
 * Cryptographic redaction: render the page to a bitmap, paint the redaction
 * region in black on the bitmap, then replace the page content with just
 * that image. The original text / vector operators under the redaction are
 * discarded in the output bytes — recoverable neither by selection, copy,
 * nor by parsing the PDF structure.
 *
 * Trade-offs the caller accepts:
 * - The whole page becomes a bitmap: text is no longer selectable, links
 *   no longer clickable, no longer searchable by default (re-run OCR to
 *   restore selectable text on the unredacted parts).
 * - File size grows for that page.
 * - Render scale is 2× by default — enough for print quality; bump to 3×
 *   for archival use by passing `scale: 3`.
 */
export async function redactRegion(
  base: Uint8Array,
  page1Based: number,
  region: { x: number; y: number; width: number; height: number },
  opts: { scale?: number } = {},
): Promise<Uint8Array> {
  const scale = opts.scale ?? 2;
  const { pdfjsLib } = await import("./pdfjs");
  const pdfJsDoc = await pdfjsLib.getDocument({ data: base.slice() }).promise;
  try {
    const page = await pdfJsDoc.getPage(page1Based);
    const baseViewport = page.getViewport({ scale: 1 });
    const pageWidthPt = baseViewport.width;
    const pageHeightPt = baseViewport.height;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("redact: canvas 2d context unavailable");

    // Render the page.
    await page.render({ canvasContext: ctx, viewport }).promise;

    // Paint the redacted region black. Canvas coords have origin at top-left;
    // PDF has bottom-left. Convert.
    const cx = region.x * scale;
    const cy = (pageHeightPt - region.y - region.height) * scale;
    const cw = region.width * scale;
    const ch = region.height * scale;
    ctx.fillStyle = "#000000";
    ctx.fillRect(cx, cy, cw, ch);

    // Canvas → PNG bytes.
    const pngBlob: Blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
    });
    const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());

    // Replace the page with the flattened bitmap at the original page size.
    const doc = await load(base);
    const pngImage = await doc.embedPng(pngBytes);
    // Grab original page rotation so the new flattened page preserves it
    // (otherwise the rendered bitmap looks double-rotated).
    const origPage = doc.getPage(page1Based - 1);
    const rotation = origPage.getRotation();
    doc.removePage(page1Based - 1);
    const newPage = doc.insertPage(page1Based - 1, [pageWidthPt, pageHeightPt]);
    newPage.setRotation(rotation);
    newPage.drawImage(pngImage, {
      x: 0,
      y: 0,
      width: pageWidthPt,
      height: pageHeightPt,
    });
    return toUint8(await doc.save());
  } finally {
    void pdfJsDoc.destroy();
  }
}

/**
 * Stamp a diagonal text watermark across every page.
 * Size scales with the page so it reads on any format.
 */
/**
 * Add a clickable Link annotation over a rectangle on a page. The link can
 * either open an external URL or jump to another page in the same document.
 *
 * Coordinates are in PDF user-space points (bottom-left origin) — same
 * convention every other primitive in this file uses.
 *
 * Implements the PDF spec's Link annotation:
 *   - external URL: /Subtype /Link, /A action with /S /URI + /URI(...)
 *   - intra-document: /Subtype /Link, /A action with /S /GoTo + /D [page /Fit]
 */
// V1.0020 hardening: defensive URL scheme allowlist for Link annotations.
// LinkPopover already validates user input, but addLinkAnnotation can be
// called from any future code path (palette macros, batch ops, etc.); this
// is the chokepoint where the URL becomes a baked-in PDF object that
// downstream readers (Preview, Adobe, browsers) will follow.
const LINK_ANNOTATION_ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);
function assertSafeLinkUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Link URL is not a valid URL");
  }
  if (!LINK_ANNOTATION_ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(
      `Link URL scheme not allowed: ${parsed.protocol} (only http, https, and mailto)`,
    );
  }
}

export async function addLinkAnnotation(
  base: Uint8Array,
  page: number,
  rect: { x: number; y: number; width: number; height: number },
  target: { kind: "url"; url: string } | { kind: "page"; pageNumber: number },
): Promise<Uint8Array> {
  if (target.kind === "url") {
    // Re-validate at the chokepoint; UI already checks, but a future caller
    // shouldn't be able to forge a `javascript:` / `file:` link annotation.
    assertSafeLinkUrl(target.url);
  }
  const doc = await load(base);
  const pages = doc.getPages();
  if (page < 1 || page > pages.length) {
    throw new Error(`Page ${page} out of range (1..${pages.length})`);
  }
  const targetPage = pages[page - 1];
  const ctx = doc.context;

  // Build the action dictionary for the link target.
  let action: PDFDict;
  if (target.kind === "url") {
    action = ctx.obj({
      Type: "Action",
      S: "URI",
      URI: PDFString.of(target.url),
    });
  } else {
    const destPageIdx = Math.max(1, Math.min(pages.length, target.pageNumber)) - 1;
    const destPageRef = pages[destPageIdx].ref;
    // Destination array: [pageRef /Fit] — Fit fits the page in the viewer.
    const dest = PDFArray.withContext(ctx);
    dest.push(destPageRef);
    dest.push(PDFName.of("Fit"));
    action = ctx.obj({
      Type: "Action",
      S: "GoTo",
      D: dest,
    });
  }

  // Build the annotation dictionary.
  const annotRect = PDFArray.withContext(ctx);
  annotRect.push(PDFNumber.of(rect.x));
  annotRect.push(PDFNumber.of(rect.y));
  annotRect.push(PDFNumber.of(rect.x + rect.width));
  annotRect.push(PDFNumber.of(rect.y + rect.height));

  // Border: [0 0 0] makes it invisible. Some PDFs draw a default thin border
  // when /Border is missing, so set it explicitly.
  const border = PDFArray.withContext(ctx);
  border.push(PDFNumber.of(0));
  border.push(PDFNumber.of(0));
  border.push(PDFNumber.of(0));

  const linkAnnot = ctx.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: annotRect,
    Border: border,
    A: action,
    F: 4, // Print flag (so it renders if printed)
  });
  const linkRef = ctx.register(linkAnnot);

  // Append to the page's existing /Annots array, creating one if absent.
  const pageDict = targetPage.node;
  const existing = pageDict.lookup(PDFName.of("Annots"));
  if (existing instanceof PDFArray) {
    existing.push(linkRef);
  } else {
    const arr = PDFArray.withContext(ctx);
    arr.push(linkRef);
    pageDict.set(PDFName.of("Annots"), arr);
  }

  return toUint8(await doc.save());
}

/**
 * Write human-readable page labels (Roman numerals for front matter, custom
 * names for cover pages, etc.) into the PDF's /PageLabels number tree. Each
 * entry in `ranges` defines a contiguous run starting at `startPage`
 * (1-based, inclusive) with the given style and optional prefix.
 *
 * Examples:
 *   [{ startPage: 1, style: "lower-roman" }]                 → i, ii, iii…
 *   [{ startPage: 1, style: "decimal", prefix: "Cover" }]    → Cover-1, Cover-2…
 *   [{ startPage: 1, style: "upper-alpha" }, { startPage: 3, style: "decimal" }]
 *     → A, B, 1, 2, 3…
 */
export type PageLabelRange = {
  startPage: number; // 1-based, inclusive
  style: "decimal" | "upper-roman" | "lower-roman" | "upper-alpha" | "lower-alpha" | "none";
  prefix?: string;
  // First numeric value in this range (defaults to 1).
  firstNumber?: number;
};

export async function setPageLabels(
  base: Uint8Array,
  ranges: PageLabelRange[],
): Promise<Uint8Array> {
  const doc = await load(base);
  const ctx = doc.context;
  // Convert to 0-based and sort by startPage.
  const sorted = [...ranges]
    .map((r) => ({ ...r, idx: Math.max(1, r.startPage) - 1 }))
    .sort((a, b) => a.idx - b.idx);

  const nums = PDFArray.withContext(ctx);
  for (const r of sorted) {
    nums.push(PDFNumber.of(r.idx));
    const labelDict = ctx.obj({
      ...(r.style === "decimal" && { S: PDFName.of("D") }),
      ...(r.style === "upper-roman" && { S: PDFName.of("R") }),
      ...(r.style === "lower-roman" && { S: PDFName.of("r") }),
      ...(r.style === "upper-alpha" && { S: PDFName.of("A") }),
      ...(r.style === "lower-alpha" && { S: PDFName.of("a") }),
      ...(r.prefix ? { P: PDFString.of(r.prefix) } : {}),
      ...(r.firstNumber && r.firstNumber !== 1 ? { St: PDFNumber.of(r.firstNumber) } : {}),
    });
    nums.push(labelDict);
  }
  const pageLabelsDict = ctx.obj({ Nums: nums });
  doc.catalog.set(PDFName.of("PageLabels"), pageLabelsDict);
  return toUint8(await doc.save());
}

/**
 * Read existing /PageLabels number tree into a flat array of label strings,
 * one per page. Returns plain "1", "2", … if no /PageLabels exists.
 */
export async function getPageLabels(base: Uint8Array): Promise<string[]> {
  const doc = await load(base);
  const numPages = doc.getPageCount();
  const catalog = doc.catalog;
  const labelsDict = catalog.lookup(PDFName.of("PageLabels"));
  if (!(labelsDict instanceof PDFDict)) {
    return Array.from({ length: numPages }, (_, i) => String(i + 1));
  }
  const numsRaw = labelsDict.lookup(PDFName.of("Nums"));
  if (!(numsRaw instanceof PDFArray)) {
    return Array.from({ length: numPages }, (_, i) => String(i + 1));
  }
  // Walk the number tree pairs: [startIdx0, dict0, startIdx1, dict1, …].
  type Range = { startIdx: number; style: string; prefix: string; first: number };
  const ranges: Range[] = [];
  for (let i = 0; i < numsRaw.size(); i += 2) {
    const startNode = numsRaw.lookup(i);
    const dictNode = numsRaw.lookup(i + 1);
    if (!(startNode instanceof PDFNumber) || !(dictNode instanceof PDFDict)) continue;
    const styleNode = dictNode.lookup(PDFName.of("S"));
    const prefixNode = dictNode.lookup(PDFName.of("P"));
    const firstNode = dictNode.lookup(PDFName.of("St"));
    ranges.push({
      startIdx: startNode.asNumber(),
      style: styleNode instanceof PDFName ? styleNode.asString().slice(1) : "",
      prefix: prefixNode instanceof PDFString ? prefixNode.asString() : "",
      first: firstNode instanceof PDFNumber ? firstNode.asNumber() : 1,
    });
  }
  if (ranges.length === 0) {
    return Array.from({ length: numPages }, (_, i) => String(i + 1));
  }
  const out: string[] = [];
  for (let p = 0; p < numPages; p++) {
    // Find the latest range whose startIdx <= p.
    let active = ranges[0];
    for (const r of ranges) if (r.startIdx <= p) active = r;
    const offset = p - active.startIdx;
    const num = active.first + offset;
    let body: string;
    switch (active.style) {
      case "D":
        body = String(num);
        break;
      case "R":
        body = toRoman(num).toUpperCase();
        break;
      case "r":
        body = toRoman(num).toLowerCase();
        break;
      case "A":
        body = toAlpha(num).toUpperCase();
        break;
      case "a":
        body = toAlpha(num).toLowerCase();
        break;
      default:
        body = "";
    }
    out.push(active.prefix + body || String(p + 1));
  }
  return out;
}

function toRoman(n: number): string {
  if (n <= 0) return "";
  const map: Array<[number, string]> = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let out = "";
  let rem = n;
  for (const [v, s] of map) {
    while (rem >= v) {
      out += s;
      rem -= v;
    }
  }
  return out;
}

function toAlpha(n: number): string {
  // PDF spec: A, B, …, Z, AA, BB, …, ZZ, AAA, … (run-length, NOT Excel-style).
  if (n <= 0) return "";
  const cycle = Math.floor((n - 1) / 26) + 1;
  const letter = String.fromCharCode("a".charCodeAt(0) + ((n - 1) % 26));
  return letter.repeat(cycle);
}

// Suppress unused-import warning for PDFRef (used via .ref above through types).
void PDFRef;

export async function drawTextWatermark(
  base: Uint8Array,
  text: string,
  opts: { opacity?: number; color?: RGB; rotation?: number } = {},
): Promise<Uint8Array> {
  const doc = await load(base);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const color = opts.color ?? { r: 0.7, g: 0.1, b: 0.1 };
  const opacity = opts.opacity ?? 0.2;
  const rotation = opts.rotation ?? 45;
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    // V1.0104: watermark centers on the visible page, not the
    // MediaBox-relative (0, 0) anchor.
    const origin = pageContentOrigin(page);
    const fontSize = Math.min(width, height) * 0.12;
    const textWidth = font.widthOfTextAtSize(text, fontSize);
    // pdf-lib rotates text around (x, y) — its baseline-left anchor — so to
    // visually center the rotated text box on the page, offset (x, y) by
    // (-textWidth/2, -textHeight/2) in the ROTATED frame.
    const rad = (rotation * Math.PI) / 180;
    const halfW = textWidth / 2;
    const halfH = fontSize * 0.35; // approx visual mid-height from baseline
    const x = origin.x + width / 2 - halfW * Math.cos(rad) + halfH * Math.sin(rad);
    const y = origin.y + height / 2 - halfW * Math.sin(rad) - halfH * Math.cos(rad);
    page.drawText(text, {
      x,
      y,
      size: fontSize,
      font,
      color: rgb(color.r, color.g, color.b),
      opacity,
      rotate: degrees(rotation),
    });
  }
  return toUint8(await doc.save());
}

// ─── Page-layout primitives ─────────────────────────────────────────────
// N-up, auto-crop, fit-to-paper, booklet, split-double-spread. Each one
// rebuilds the PDF from scratch via pdf-lib's embedPdf + drawPage so the
// source document is never mutated in place. Auto-crop additionally needs
// pdf.js to render each page to a canvas and detect the content bounding
// box by walking pixels.

/** Standard paper sizes in PDF user-space points (1pt = 1/72 in). */
export const PAPER_SIZES = {
  letter: { width: 612, height: 792 },
  legal: { width: 612, height: 1008 },
  a4: { width: 595.28, height: 841.89 },
  a3: { width: 841.89, height: 1190.55 },
  a5: { width: 419.53, height: 595.28 },
  tabloid: { width: 792, height: 1224 },
} as const;

export type PaperSize = keyof typeof PAPER_SIZES | "source";

function resolvePaperSize(
  size: PaperSize,
  source: { width: number; height: number },
  orientation: "portrait" | "landscape" | "auto" = "auto",
): { width: number; height: number } {
  const base = size === "source" ? { ...source } : { ...PAPER_SIZES[size] };
  if (orientation === "landscape" && base.width < base.height) {
    return { width: base.height, height: base.width };
  }
  if (orientation === "portrait" && base.width > base.height) {
    return { width: base.height, height: base.width };
  }
  return base;
}

/**
 * N-up: combine multiple pages onto each output page in a grid.
 *   2 → 1×2 landscape
 *   4 → 2×2
 *   6 → 2×3
 *   9 → 3×3
 * Pages keep their aspect ratio and are scaled to fit each grid cell with
 * a small gutter. Output paper size defaults to landscape Letter for 2-up,
 * portrait Letter for the rest (matches Preview's behaviour).
 */
/** V1.0085: `perSheet` accepts either a fixed grid keyword (2/4/6/9) or
 *  an explicit `{ cols, rows }` shape — the latter lets the Print modal's
 *  "Fit all on one sheet" mode pass a dynamic grid sized from the
 *  source page count (e.g. 30 pages → 6×5), without being capped at the
 *  five canonical layouts. */
export type NUpSpec = 2 | 4 | 6 | 9 | { cols: number; rows: number };

export async function nUpPages(
  base: Uint8Array,
  perSheet: NUpSpec,
  opts: {
    paper?: PaperSize;
    orientation?: "portrait" | "landscape" | "auto";
    margin?: number; // points around outside of sheet
    gutter?: number; // points between cells
    addBorders?: boolean;
  } = {},
): Promise<Uint8Array> {
  // V1.0083: two-strategy nUp. The vector path (pdf-lib `embedPdf` +
  // `drawPage`) is fastest and keeps text searchable in the output PDF,
  // but pdf-lib's content-stream resolver is brittle on real-world PDFs:
  // AcroForm widgets pointing at missing streams, corrupt xrefs, certain
  // Word/Office→PDF exports trip its minified `Expected instance of t,
  // but got instance of undefined` assertions. V1.0082's earlier fix
  // only wrapped `embedPdf` itself; the actual throw fires later during
  // `out.save()` (pdf-lib defers stream resolution), so the catch never
  // fired in practice — Adam still saw the error banner.
  //
  // The dispatcher below now wraps the ENTIRE vector pipeline (load →
  // embed → draw → save) in a try/catch. If anything throws, we throw
  // out the partial output and re-run via the raster path: pdf.js
  // rasterizes each source page to a PNG, then pdf-lib's `embedPng` +
  // `drawImage` composes them onto sheets. pdf.js is the same engine
  // already rendering the viewer, so anything visible on screen can be
  // rasterized — the fallback never fails for a PDF the user can see.
  // V1.0083: tests can force the raster fallback via a window flag to
  // verify the path end-to-end without needing a curated broken PDF.
  // Production code never sets this; it's a pure test hook.
  const forceRaster =
    typeof window !== "undefined" &&
    (window as unknown as { __weavepdfTest__?: { forceRasterNUp?: boolean } })
      .__weavepdfTest__?.forceRasterNUp === true;
  if (forceRaster) {
    return await nUpPagesRaster(base, perSheet, opts);
  }
  try {
    return await nUpPagesVector(base, perSheet, opts);
  } catch {
    return await nUpPagesRaster(base, perSheet, opts);
  }
}

function nUpGeometry(perSheet: NUpSpec, opts: { paper?: PaperSize; orientation?: "portrait" | "landscape" | "auto"; margin?: number; gutter?: number; addBorders?: boolean }, firstSize: { width: number; height: number }) {
  // V1.0085: dynamic grid takes precedence — caller supplies cols/rows
  // (used by "Fit all on one sheet"). Falls through to the canonical
  // 2/4/6/9 layouts otherwise.
  let layout: { cols: number; rows: number };
  let defaultOrient: "portrait" | "landscape";
  if (typeof perSheet === "object") {
    layout = { cols: Math.max(1, perSheet.cols), rows: Math.max(1, perSheet.rows) };
    // Pick orientation that lets each cell hold the source's aspect ratio
    // most efficiently. Approximate: if cells become landscape (wider than
    // tall) and the source is portrait, the sheet should be landscape too
    // so the math doesn't waste paper. Default to portrait unless the
    // grid is strongly horizontal.
    defaultOrient = layout.cols > layout.rows ? "landscape" : "portrait";
  } else {
    const grid = (
      {
        2: { cols: 1, rows: 2, defaultOrient: "landscape" as const },
        4: { cols: 2, rows: 2, defaultOrient: "portrait" as const },
        6: { cols: 2, rows: 3, defaultOrient: "portrait" as const },
        9: { cols: 3, rows: 3, defaultOrient: "portrait" as const },
      } as const
    )[perSheet];
    defaultOrient = grid.defaultOrient;
    // 2-up specifically: lay pages side-by-side on a landscape sheet (cols=2).
    // The grid above puts them as 1×2 because that's the natural "two pages
    // stacked" — but for 2-up we want 2×1 landscape, the canonical layout.
    layout = perSheet === 2 ? { cols: 2, rows: 1 } : { cols: grid.cols, rows: grid.rows };
  }
  const cells = layout.cols * layout.rows;
  const orientation = opts.orientation ?? defaultOrient;
  const sheet = resolvePaperSize(opts.paper ?? "letter", firstSize, orientation);
  const margin = opts.margin ?? 18;
  const gutter = opts.gutter ?? 9;
  const cellWidth = (sheet.width - margin * 2 - gutter * (layout.cols - 1)) / layout.cols;
  const cellHeight = (sheet.height - margin * 2 - gutter * (layout.rows - 1)) / layout.rows;
  return { sheet, layout, cells, cellWidth, cellHeight, margin, gutter };
}

function drawCell(
  sheetPage: import("pdf-lib").PDFPage,
  cellX: number,
  cellTopY: number,
  cellWidth: number,
  cellHeight: number,
  srcWidthPt: number,
  srcHeightPt: number,
  draw: (page: import("pdf-lib").PDFPage, opts: { x: number; y: number; width: number; height: number }) => void,
  addBorders: boolean,
) {
  const scale = Math.min(cellWidth / srcWidthPt, cellHeight / srcHeightPt);
  const drawW = srcWidthPt * scale;
  const drawH = srcHeightPt * scale;
  const drawX = cellX + (cellWidth - drawW) / 2;
  const drawY = cellTopY - cellHeight + (cellHeight - drawH) / 2;
  draw(sheetPage, { x: drawX, y: drawY, width: drawW, height: drawH });
  if (addBorders) {
    sheetPage.drawRectangle({
      x: drawX,
      y: drawY,
      width: drawW,
      height: drawH,
      borderColor: rgb(0.7, 0.7, 0.7),
      borderWidth: 0.5,
    });
  }
}

/** Vector n-up via `embedPdf` + `drawPage`. Fast + searchable output,
 *  but throws on PDFs pdf-lib can't fully resolve. */
async function nUpPagesVector(
  base: Uint8Array,
  perSheet: NUpSpec,
  opts: { paper?: PaperSize; orientation?: "portrait" | "landscape" | "auto"; margin?: number; gutter?: number; addBorders?: boolean },
): Promise<Uint8Array> {
  const addBorders = opts.addBorders ?? false;
  const src = await load(base);
  const srcPages = src.getPages();
  if (srcPages.length === 0) return base;
  const firstSize = srcPages[0].getSize();
  const { sheet, layout, cells, cellWidth, cellHeight, margin, gutter } = nUpGeometry(perSheet, opts, firstSize);

  const out = await PDFDocument.create();
  const indices = srcPages.map((_, i) => i);
  const embedded = await out.embedPdf(src, indices);

  for (let start = 0; start < embedded.length; start += cells) {
    const sheetPage = out.addPage([sheet.width, sheet.height]);
    for (let i = 0; i < cells; i++) {
      const srcIdx = start + i;
      if (srcIdx >= embedded.length) break;
      const ep = embedded[srcIdx];
      const col = i % layout.cols;
      const row = Math.floor(i / layout.cols);
      const cellX = margin + col * (cellWidth + gutter);
      const cellTopY = sheet.height - margin - row * (cellHeight + gutter);
      drawCell(
        sheetPage, cellX, cellTopY, cellWidth, cellHeight,
        ep.width, ep.height,
        (page, drawOpts) => page.drawPage(ep, drawOpts),
        addBorders,
      );
    }
  }
  // V1.0083: save() inside the try so deferred stream resolution failures
  // hit the dispatcher's fallback. Pre-V1.0083 the caller saved separately
  // and the throw escaped any catch.
  return toUint8(await out.save());
}

/** Raster n-up via pdf.js → PNG → `embedPng` + `drawImage`. Heavier
 *  output but works for any PDF the viewer can render. Fallback path
 *  for documents pdf-lib can't fully resolve. */
async function nUpPagesRaster(
  base: Uint8Array,
  perSheet: NUpSpec,
  opts: { paper?: PaperSize; orientation?: "portrait" | "landscape" | "auto"; margin?: number; gutter?: number; addBorders?: boolean },
): Promise<Uint8Array> {
  const addBorders = opts.addBorders ?? false;
  const { pdfjsLib } = await import("./pdfjs");
  const pdfJsDoc = await pdfjsLib.getDocument({ data: base.slice() }).promise;
  try {
    const numPages = pdfJsDoc.numPages;
    if (numPages === 0) return base;
    const firstPage = await pdfJsDoc.getPage(1);
    const firstVp = firstPage.getViewport({ scale: 1 });
    const firstSize = { width: firstVp.width, height: firstVp.height };
    const { sheet, layout, cells, cellWidth, cellHeight, margin, gutter } = nUpGeometry(perSheet, opts, firstSize);

    const out = await PDFDocument.create();
    const RASTER_SCALE = 2; // 2× DPI for crisp print
    type Raster = { widthPt: number; heightPt: number; image: import("pdf-lib").PDFImage };
    const rasters: Raster[] = [];
    for (let i = 1; i <= numPages; i++) {
      const page = await pdfJsDoc.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: RASTER_SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("nUpPagesRaster: no 2D context");
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const blob = await new Promise<Blob>((res, rej) => {
        canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png");
      });
      const buf = new Uint8Array(await blob.arrayBuffer());
      const image = await out.embedPng(buf);
      rasters.push({ widthPt: vp1.width, heightPt: vp1.height, image });
    }

    for (let start = 0; start < rasters.length; start += cells) {
      const sheetPage = out.addPage([sheet.width, sheet.height]);
      for (let i = 0; i < cells; i++) {
        const srcIdx = start + i;
        if (srcIdx >= rasters.length) break;
        const r = rasters[srcIdx];
        const col = i % layout.cols;
        const row = Math.floor(i / layout.cols);
        const cellX = margin + col * (cellWidth + gutter);
        const cellTopY = sheet.height - margin - row * (cellHeight + gutter);
        drawCell(
          sheetPage, cellX, cellTopY, cellWidth, cellHeight,
          r.widthPt, r.heightPt,
          (page, drawOpts) => page.drawImage(r.image, drawOpts),
          addBorders,
        );
      }
    }
    return toUint8(await out.save());
  } finally {
    try { await pdfJsDoc.destroy(); } catch { /* ignore */ }
  }
}

/**
 * Crop each page to its content bounding box (or, when `uniform: true`, to
 * the union bounding box across every page so all output pages stay the
 * same size). Pages are rendered to a canvas via pdf.js, then we walk pixels
 * to find the smallest rectangle that contains every non-white pixel, with
 * a configurable padding margin (default 6pt).
 *
 * `whiteThreshold` (0..255) is the per-channel brightness above which a
 * pixel counts as background. Default 240 is forgiving of mild scan noise
 * without eating real content.
 */
export async function autoCropPages(
  base: Uint8Array,
  opts: {
    uniform?: boolean;
    padding?: number; // points
    whiteThreshold?: number; // 0..255
    scale?: number; // pdf.js render scale (1..3)
  } = {},
): Promise<Uint8Array> {
  const padding = opts.padding ?? 6;
  const whiteThreshold = opts.whiteThreshold ?? 240;
  const scale = opts.scale ?? 1.5;
  const uniform = opts.uniform ?? false;

  const { pdfjsLib } = await import("./pdfjs");
  const pdfJsDoc = await pdfjsLib.getDocument({ data: base.slice() }).promise;
  try {
    type Bbox = { x: number; y: number; width: number; height: number; pageWidth: number; pageHeight: number };
    const bboxes: Bbox[] = [];
    for (let p = 1; p <= pdfJsDoc.numPages; p++) {
      const page = await pdfJsDoc.getPage(p);
      const baseVp = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("autoCrop: canvas 2d context unavailable");
      // White background so transparency in the PDF doesn't read as content.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

      let minX = canvas.width;
      let minY = canvas.height;
      let maxX = -1;
      let maxY = -1;
      // Walk pixels — every 4 bytes is RGBA. A pixel is "content" if any
      // channel is below the white threshold OR alpha is non-trivial below 1.
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          if (r < whiteThreshold || g < whiteThreshold || b < whiteThreshold) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) {
        // Page is entirely blank — preserve original size, don't crop to nothing.
        bboxes.push({
          x: 0,
          y: 0,
          width: baseVp.width,
          height: baseVp.height,
          pageWidth: baseVp.width,
          pageHeight: baseVp.height,
        });
        continue;
      }
      // Convert pixel coords (top-left origin) → PDF points (bottom-left).
      const padPx = padding * scale;
      const px = Math.max(0, minX - padPx);
      const py = Math.max(0, minY - padPx);
      const pw = Math.min(canvas.width, maxX + padPx) - px;
      const ph = Math.min(canvas.height, maxY + padPx) - py;
      const ptX = px / scale;
      const ptW = pw / scale;
      const ptH = ph / scale;
      // PDF Y origin is at the bottom of the page; canvas at the top.
      const ptY = baseVp.height - (py / scale + ptH);
      bboxes.push({
        x: ptX,
        y: ptY,
        width: ptW,
        height: ptH,
        pageWidth: baseVp.width,
        pageHeight: baseVp.height,
      });
    }

    let unionBbox: Bbox | null = null;
    if (uniform && bboxes.length > 0) {
      const minX = Math.min(...bboxes.map((b) => b.x));
      const minY = Math.min(...bboxes.map((b) => b.y));
      const maxX = Math.max(...bboxes.map((b) => b.x + b.width));
      const maxY = Math.max(...bboxes.map((b) => b.y + b.height));
      unionBbox = {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
        pageWidth: 0,
        pageHeight: 0,
      };
    }

    const doc = await load(base);
    const pages = doc.getPages();
    for (let i = 0; i < pages.length; i++) {
      const bb = uniform && unionBbox ? unionBbox : bboxes[i];
      // setMediaBox + setCropBox both — MediaBox is the absolute paper size
      // for the page; CropBox what readers display. Setting both makes the
      // crop survive every reader, including ones that ignore CropBox.
      pages[i].setMediaBox(bb.x, bb.y, bb.width, bb.height);
      pages[i].setCropBox(bb.x, bb.y, bb.width, bb.height);
    }
    return toUint8(await doc.save());
  } finally {
    void pdfJsDoc.destroy();
  }
}

/**
 * V1.0086: content-aware "fit everything on one page" for printing.
 * Adam's case: a 2-page insurance cert where page 2 has ~150pt of
 * content and ~640pt of whitespace. `nUpPages` with {cols:2,rows:1}
 * gave him a 2-up tile layout — page 2 got half the sheet, almost all
 * of which was blank, while page 1 got squeezed to fit its half.
 *
 * The smart approach: rasterize each source page, pixel-scan to find
 * its actual content bounding box, drop the inter-page whitespace, and
 * compose the cropped content rectangles onto a single output sheet.
 * Picks between vertical-stack / horizontal-row / grid layouts based on
 * which one allows the largest uniform scale (= most legible output).
 *
 * Always all-raster — the user's PDFs that need this feature often
 * trip pdf-lib's vector resolver (V1.0083). Slightly larger output,
 * but it works on anything pdf.js can render (which is anything the
 * viewer can show).
 *
 * Returns the source unchanged when source has 1 page (no-op) or 0
 * pages.
 */
/**
 * V1.0087: detect the visible content bounding box of a single PDF page,
 * returned in PDF user-space points (origin = bottom-left, matching
 * pdf-lib semantics). Used by the draggable Crop tool to seed its
 * default rectangle to the actual used area rather than the full
 * MediaBox. Returns null when the page is entirely whitespace or pdf.js
 * can't render it.
 *
 * Implementation: render the page to a canvas via pdf.js at the given
 * raster scale, pixel-scan for non-white pixels using `whiteThreshold`,
 * pad the resulting bbox by `pad` pixels, and convert back to points.
 * Same primitive `fitAllOntoSingleSheet` uses internally — this just
 * exposes it as a single-page helper for UI defaults.
 */
export async function detectPageContentBbox(
  bytes: Uint8Array,
  page1Based: number,
  opts: { rasterScale?: number; whiteThreshold?: number; pad?: number } = {},
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  const rasterScale = opts.rasterScale ?? 1.5;
  const whiteThreshold = opts.whiteThreshold ?? 240;
  const pad = opts.pad ?? 6;
  const { pdfjsLib } = await import("./pdfjs");
  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  try {
    if (page1Based < 1 || page1Based > doc.numPages) return null;
    const page = await doc.getPage(page1Based);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: rasterScale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;
    const w = canvas.width;
    const h = canvas.height;
    for (let y = 0; y < h; y++) {
      const rowOff = y * w * 4;
      for (let x = 0; x < w; x++) {
        const idx = rowOff + x * 4;
        if (
          data[idx] < whiteThreshold ||
          data[idx + 1] < whiteThreshold ||
          data[idx + 2] < whiteThreshold
        ) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null; // entirely whitespace
    const cx0 = Math.max(0, minX - pad);
    const cy0 = Math.max(0, minY - pad);
    const cx1 = Math.min(canvas.width - 1, maxX + pad);
    const cy1 = Math.min(canvas.height - 1, maxY + pad);
    // Canvas is top-origin; PDF user-space is bottom-origin. Convert by
    // flipping Y around the page height.
    const pageWPt = vp1.width;
    const pageHPt = vp1.height;
    const xPt = cx0 / rasterScale;
    const wPt = (cx1 - cx0 + 1) / rasterScale;
    const topPx = cy0 / rasterScale; // distance from top edge in points
    const hPt = (cy1 - cy0 + 1) / rasterScale;
    const yPt = pageHPt - topPx - hPt; // bottom-left origin
    return {
      x: Math.max(0, Math.min(pageWPt, xPt)),
      y: Math.max(0, Math.min(pageHPt, yPt)),
      w: Math.max(0, Math.min(pageWPt - xPt, wPt)),
      h: Math.max(0, Math.min(pageHPt - yPt, hPt)),
    };
  } finally {
    try { await doc.destroy(); } catch { /* ignore */ }
  }
}

export async function fitAllOntoSingleSheet(
  base: Uint8Array,
  paper: PaperSize = "letter",
  orientation: "portrait" | "landscape" | "auto" = "auto",
  opts: { margin?: number; gutter?: number; rasterScale?: number; whiteThreshold?: number; pad?: number } = {},
): Promise<Uint8Array> {
  const margin = opts.margin ?? 18;
  const gutter = opts.gutter ?? 6;
  const rasterScale = opts.rasterScale ?? 1.5;
  const whiteThreshold = opts.whiteThreshold ?? 240;
  const pad = opts.pad ?? 6; // px around the detected content bbox

  const { pdfjsLib } = await import("./pdfjs");
  const pdfJsDoc = await pdfjsLib.getDocument({ data: base.slice() }).promise;
  try {
    const numPages = pdfJsDoc.numPages;
    if (numPages <= 1) return base;

    type CroppedPage = {
      png: Uint8Array;
      // Cropped extent in PDF points (the user-meaningful unit).
      contentWPt: number;
      contentHPt: number;
    };
    const cropped: CroppedPage[] = [];
    let firstPagePdfSize = { width: 612, height: 792 };

    for (let i = 1; i <= numPages; i++) {
      const page = await pdfJsDoc.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      if (i === 1) firstPagePdfSize = { width: vp1.width, height: vp1.height };
      const vp = page.getViewport({ scale: rasterScale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("fitAllOntoSingleSheet: no 2D context");
      // White background so transparent regions don't get treated as
      // content during the bbox scan.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;

      // Scan pixels for the smallest non-white bbox. Two-pass for
      // speed: first by rows (find vertical content extent), then
      // within those rows by columns. Naive full-scan is ~2× slower
      // but still fast enough at 1.5× DPI; keep simple.
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let minX = canvas.width;
      let minY = canvas.height;
      let maxX = -1;
      let maxY = -1;
      const w = canvas.width;
      const h = canvas.height;
      for (let y = 0; y < h; y++) {
        const rowOff = y * w * 4;
        for (let x = 0; x < w; x++) {
          const idx = rowOff + x * 4;
          if (
            data[idx] < whiteThreshold ||
            data[idx + 1] < whiteThreshold ||
            data[idx + 2] < whiteThreshold
          ) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) {
        // Page is entirely whitespace — represent it as a tiny placeholder
        // and skip it from the layout math by using a zero-ish content
        // box. We'll filter empty pages before composition.
        continue;
      }
      const cx0 = Math.max(0, minX - pad);
      const cy0 = Math.max(0, minY - pad);
      const cx1 = Math.min(canvas.width - 1, maxX + pad);
      const cy1 = Math.min(canvas.height - 1, maxY + pad);
      const cropPxW = cx1 - cx0 + 1;
      const cropPxH = cy1 - cy0 + 1;

      const cropCanvas = document.createElement("canvas");
      cropCanvas.width = cropPxW;
      cropCanvas.height = cropPxH;
      const cropCtx = cropCanvas.getContext("2d");
      if (!cropCtx) throw new Error("fitAllOntoSingleSheet: no crop 2D context");
      cropCtx.drawImage(canvas, cx0, cy0, cropPxW, cropPxH, 0, 0, cropPxW, cropPxH);
      const blob = await new Promise<Blob>((res, rej) => {
        cropCanvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/png");
      });
      const png = new Uint8Array(await blob.arrayBuffer());

      cropped.push({
        png,
        contentWPt: cropPxW / rasterScale,
        contentHPt: cropPxH / rasterScale,
      });
    }

    if (cropped.length === 0) return base; // all pages empty (degenerate)

    // Resolve sheet size — orientation: "auto" picks the one that
    // matches the dominant content aspect, so a doc full of landscape
    // pages doesn't get awkwardly portrait-letterboxed.
    const totalContentW = cropped.reduce((s, p) => s + p.contentWPt, 0);
    const totalContentH = cropped.reduce((s, p) => s + p.contentHPt, 0);
    const sheet = resolvePaperSize(paper, firstPagePdfSize, orientation);
    const innerW = sheet.width - margin * 2;
    const innerH = sheet.height - margin * 2;
    const N = cropped.length;

    // Score three candidate layouts; the one with the largest scale
    // wins (most legible output).
    // Vertical stack.
    const stackW = Math.max(...cropped.map((p) => p.contentWPt));
    const stackH = totalContentH + gutter * (N - 1);
    const scaleV = Math.min(innerW / stackW, innerH / stackH);
    // Horizontal row.
    const rowW = totalContentW + gutter * (N - 1);
    const rowH = Math.max(...cropped.map((p) => p.contentHPt));
    const scaleH = Math.min(innerW / rowW, innerH / rowH);
    // Square-ish grid.
    const cols = Math.max(1, Math.ceil(Math.sqrt(N)));
    const rows = Math.max(1, Math.ceil(N / cols));
    const cellW = (innerW - gutter * (cols - 1)) / cols;
    const cellH = (innerH - gutter * (rows - 1)) / rows;
    let scaleG = Infinity;
    for (const p of cropped) {
      const s = Math.min(cellW / p.contentWPt, cellH / p.contentHPt);
      if (s < scaleG) scaleG = s;
    }
    let mode: "vertical" | "horizontal" | "grid";
    if (scaleV >= scaleH && scaleV >= scaleG) mode = "vertical";
    else if (scaleH >= scaleG) mode = "horizontal";
    else mode = "grid";
    // Never scale UP — auto-fit shouldn't magnify; the user has the
    // explicit Scale slider for that.
    const cap = (s: number) => Math.min(1, s);

    const out = await PDFDocument.create();
    const outPage = out.addPage([sheet.width, sheet.height]);

    if (mode === "vertical") {
      const scale = cap(scaleV);
      const blockW = stackW * scale;
      const blockH = stackH * scale;
      const blockX = margin + (innerW - blockW) / 2;
      let cursorYTop = sheet.height - margin - (innerH - blockH) / 2;
      for (const p of cropped) {
        const drawW = p.contentWPt * scale;
        const drawH = p.contentHPt * scale;
        const drawX = blockX + (blockW - drawW) / 2;
        const drawY = cursorYTop - drawH;
        const img = await out.embedPng(p.png);
        outPage.drawImage(img, { x: drawX, y: drawY, width: drawW, height: drawH });
        cursorYTop -= drawH + gutter * scale;
      }
    } else if (mode === "horizontal") {
      const scale = cap(scaleH);
      const blockW = rowW * scale;
      const blockH = rowH * scale;
      let cursorX = margin + (innerW - blockW) / 2;
      const blockTopY = sheet.height - margin - (innerH - blockH) / 2;
      for (const p of cropped) {
        const drawW = p.contentWPt * scale;
        const drawH = p.contentHPt * scale;
        const drawY = blockTopY - blockH + (blockH - drawH) / 2;
        const img = await out.embedPng(p.png);
        outPage.drawImage(img, { x: cursorX, y: drawY, width: drawW, height: drawH });
        cursorX += drawW + gutter * scale;
      }
    } else {
      const scale = cap(scaleG);
      for (let i = 0; i < N; i++) {
        const p = cropped[i];
        const col = i % cols;
        const row = Math.floor(i / cols);
        const cellX = margin + col * (cellW + gutter);
        const cellTopY = sheet.height - margin - row * (cellH + gutter);
        const drawW = p.contentWPt * scale;
        const drawH = p.contentHPt * scale;
        const drawX = cellX + (cellW - drawW) / 2;
        const drawY = cellTopY - cellH + (cellH - drawH) / 2;
        const img = await out.embedPng(p.png);
        outPage.drawImage(img, { x: drawX, y: drawY, width: drawW, height: drawH });
      }
    }
    return toUint8(await out.save());
  } finally {
    try { await pdfJsDoc.destroy(); } catch { /* ignore */ }
  }
}

/**
 * Re-paginate the document onto a target paper size. Each source page is
 * embedded and either fit (preserve aspect, centre, may have margins) or
 * filled (preserve aspect, may crop at edges). Useful for normalising a
 * mixed-size document before printing.
 */
export async function fitToPaper(
  base: Uint8Array,
  paper: PaperSize,
  opts: {
    mode?: "fit" | "fill";
    orientation?: "portrait" | "landscape" | "auto";
    margin?: number; // points (only applied in fit mode)
  } = {},
): Promise<Uint8Array> {
  const mode = opts.mode ?? "fit";
  const margin = opts.margin ?? 0;
  const src = await load(base);
  const srcPages = src.getPages();
  if (srcPages.length === 0) return base;

  const out = await PDFDocument.create();
  const embedded = await out.embedPdf(src, srcPages.map((_, i) => i));

  for (const ep of embedded) {
    const sheet = resolvePaperSize(paper, ep, opts.orientation);
    const sheetPage = out.addPage([sheet.width, sheet.height]);
    const innerW = sheet.width - margin * 2;
    const innerH = sheet.height - margin * 2;
    const scale =
      mode === "fit"
        ? Math.min(innerW / ep.width, innerH / ep.height)
        : Math.max(innerW / ep.width, innerH / ep.height);
    const drawW = ep.width * scale;
    const drawH = ep.height * scale;
    const x = (sheet.width - drawW) / 2;
    const y = (sheet.height - drawH) / 2;
    sheetPage.drawPage(ep, { x, y, width: drawW, height: drawH });
  }
  return toUint8(await out.save());
}

/**
 * V1.0084: scale each source page's content to `scale × ` its original
 * size and recompose onto a same-sized output page, centred. Preserves
 * the source page dimensions so the printer's paper handling doesn't
 * change — only the rendered content shrinks/grows.
 *
 * Used by the Print modal's "Custom %" scale option. For Adam's stated
 * case ("1.3 pages, fit on one"), use the dedicated "Shrink to one
 * sheet" scale mode instead — that re-paginates via n-up. This helper
 * is the lower-level companion for arbitrary % scales.
 *
 * Same two-strategy pattern as `nUpPages`: vector path first (embedPdf
 * + drawPage), falling back to pdf.js rasterization on documents
 * pdf-lib can't fully resolve.
 */

/**
 * V1.0088: print-path scale + orientation handler. Replaces the old
 * 1-up pipeline (`scalePageContent` + `fitToPaper`) with a single
 * content-aware function that:
 *
 *   1. Detects each source page's content bbox via pdf.js raster (same
 *      pixel-scan helper as V1.0086).
 *   2. Auto-rotates 90° if the content aspect doesn't match the output
 *      sheet aspect — so a portrait scan on a landscape sheet rotates
 *      to fill the wide direction.
 *   3. Fit-fill semantics: `scalePct=100` = content fills the printable
 *      area at maximum size (preserving aspect). `<100` shrinks. `>100`
 *      overflows the margins toward the page edge (the user is asking
 *      for more zoom; let them have it).
 *   4. Centers the result on the output page sized to `paper` +
 *      `orientation`.
 *
 * Pre-V1.0088 bugs this fixes (from Adam's screenshots):
 * - Landscape orientation just resized the output sheet; the source
 *   stayed portrait and produced wasted whitespace on a landscape page.
 * - Scale > 100% drew oversized content centered on a same-size page,
 *   so the overflow clipped at the page edge instead of "taking more
 *   of the page" like the user expected.
 *
 * All-raster (pdf.js) so it works on PDFs that trip pdf-lib's vector
 * resolver (V1.0083 territory). For full-page typeset docs the fit
 * factor is ≈1.0 — visual output stays the same as the old "no scale"
 * path. For sparse-content docs (scans, certificates) it auto-zooms
 * the content to fill the page, which is the entire point of the fix.
 */
export async function scaleToFitForPrint(
  base: Uint8Array,
  paper: PaperSize,
  orientation: "portrait" | "landscape" | "auto",
  scalePct: number,
  opts: { margin?: number; rasterScale?: number; whiteThreshold?: number; pad?: number } = {},
): Promise<Uint8Array> {
  const margin = opts.margin ?? 18;
  const rasterScale = opts.rasterScale ?? 1.5;
  const whiteThreshold = opts.whiteThreshold ?? 240;
  const pad = opts.pad ?? 6;

  const { pdfjsLib } = await import("./pdfjs");
  const pdfJsDoc = await pdfjsLib.getDocument({ data: base.slice() }).promise;
  try {
    const numPages = pdfJsDoc.numPages;
    if (numPages === 0) return base;
    const out = await PDFDocument.create();

    for (let i = 1; i <= numPages; i++) {
      const page = await pdfJsDoc.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const sheet = resolvePaperSize(paper, { width: vp1.width, height: vp1.height }, orientation);
      const innerW = sheet.width - margin * 2;
      const innerH = sheet.height - margin * 2;

      const vp = page.getViewport({ scale: rasterScale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("scaleToFitForPrint: no 2D context");
      // White background — transparent areas shouldn't read as content
      // during the bbox scan.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;

      // Pixel-scan for the content bbox.
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let minX = canvas.width;
      let minY = canvas.height;
      let maxX = -1;
      let maxY = -1;
      const cw = canvas.width;
      const ch = canvas.height;
      for (let y = 0; y < ch; y++) {
        const rowOff = y * cw * 4;
        for (let x = 0; x < cw; x++) {
          const idx = rowOff + x * 4;
          if (
            data[idx] < whiteThreshold ||
            data[idx + 1] < whiteThreshold ||
            data[idx + 2] < whiteThreshold
          ) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      // Empty page → add a blank output sheet so page count is preserved.
      if (maxX < 0) {
        out.addPage([sheet.width, sheet.height]);
        continue;
      }
      const cx0 = Math.max(0, minX - pad);
      const cy0 = Math.max(0, minY - pad);
      const cx1 = Math.min(cw - 1, maxX + pad);
      const cy1 = Math.min(ch - 1, maxY + pad);
      const cropPxW = cx1 - cx0 + 1;
      const cropPxH = cy1 - cy0 + 1;
      const cropCanvas = document.createElement("canvas");
      cropCanvas.width = cropPxW;
      cropCanvas.height = cropPxH;
      const cropCtx = cropCanvas.getContext("2d");
      if (!cropCtx) throw new Error("scaleToFitForPrint: no crop ctx");
      cropCtx.drawImage(canvas, cx0, cy0, cropPxW, cropPxH, 0, 0, cropPxW, cropPxH);

      let contentWPt = cropPxW / rasterScale;
      let contentHPt = cropPxH / rasterScale;

      // Auto-rotate: if content's landscape-ness doesn't match the
      // sheet's, rotate the cropped canvas 90° so its long edge aligns
      // with the sheet's long edge. Match every major print dialog
      // (Acrobat's "Auto portrait/landscape", Preview's auto-rotate).
      const contentLandscape = contentWPt > contentHPt;
      const sheetLandscape = sheet.width > sheet.height;
      const rotate90 = contentLandscape !== sheetLandscape;
      let sourceCanvas: HTMLCanvasElement = cropCanvas;
      if (rotate90) {
        const r = document.createElement("canvas");
        r.width = cropPxH;
        r.height = cropPxW;
        const rc = r.getContext("2d");
        if (!rc) throw new Error("scaleToFitForPrint: no rotate ctx");
        // 90° CCW: translate, rotate, then drawImage at origin.
        rc.translate(0, cropPxW);
        rc.rotate(-Math.PI / 2);
        rc.drawImage(cropCanvas, 0, 0);
        sourceCanvas = r;
        const tmp = contentWPt;
        contentWPt = contentHPt;
        contentHPt = tmp;
      }

      // Fit-fill: scale 100% means content fills the printable area at
      // max size (preserve aspect). User's `scalePct` multiplies that
      // fit factor — >100 overflows margins toward the page edge, <100
      // leaves more whitespace.
      const fitScale = Math.min(innerW / contentWPt, innerH / contentHPt);
      const finalScale = fitScale * (scalePct / 100);
      const drawW = contentWPt * finalScale;
      const drawH = contentHPt * finalScale;
      const drawX = (sheet.width - drawW) / 2;
      const drawY = (sheet.height - drawH) / 2;

      const blob = await new Promise<Blob>((res, rej) => {
        sourceCanvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/png");
      });
      const buf = new Uint8Array(await blob.arrayBuffer());
      const img = await out.embedPng(buf);
      const sheetPage = out.addPage([sheet.width, sheet.height]);
      sheetPage.drawImage(img, { x: drawX, y: drawY, width: drawW, height: drawH });
    }
    return toUint8(await out.save());
  } finally {
    try { await pdfJsDoc.destroy(); } catch { /* ignore */ }
  }
}

export async function scalePageContent(
  base: Uint8Array,
  scale: number,
): Promise<Uint8Array> {
  if (!Number.isFinite(scale) || scale <= 0) return base;
  if (Math.abs(scale - 1) < 0.001) return base;
  try {
    return await scalePageContentVector(base, scale);
  } catch {
    return await scalePageContentRaster(base, scale);
  }
}

async function scalePageContentVector(
  base: Uint8Array,
  scale: number,
): Promise<Uint8Array> {
  const src = await load(base);
  const srcPages = src.getPages();
  if (srcPages.length === 0) return base;
  const out = await PDFDocument.create();
  const embedded = await out.embedPdf(src, srcPages.map((_, i) => i));
  for (const ep of embedded) {
    const sheetPage = out.addPage([ep.width, ep.height]);
    const drawW = ep.width * scale;
    const drawH = ep.height * scale;
    const x = (ep.width - drawW) / 2;
    const y = (ep.height - drawH) / 2;
    sheetPage.drawPage(ep, { x, y, width: drawW, height: drawH });
  }
  return toUint8(await out.save());
}

async function scalePageContentRaster(
  base: Uint8Array,
  scale: number,
): Promise<Uint8Array> {
  const { pdfjsLib } = await import("./pdfjs");
  const pdfJsDoc = await pdfjsLib.getDocument({ data: base.slice() }).promise;
  try {
    const numPages = pdfJsDoc.numPages;
    if (numPages === 0) return base;
    const out = await PDFDocument.create();
    const RASTER_SCALE = 2;
    for (let i = 1; i <= numPages; i++) {
      const page = await pdfJsDoc.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: RASTER_SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("scalePageContentRaster: no 2D context");
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const blob = await new Promise<Blob>((res, rej) => {
        canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png");
      });
      const buf = new Uint8Array(await blob.arrayBuffer());
      const image = await out.embedPng(buf);
      const sheetPage = out.addPage([vp1.width, vp1.height]);
      const drawW = vp1.width * scale;
      const drawH = vp1.height * scale;
      const x = (vp1.width - drawW) / 2;
      const y = (vp1.height - drawH) / 2;
      sheetPage.drawImage(image, { x, y, width: drawW, height: drawH });
    }
    return toUint8(await out.save());
  } finally {
    try { await pdfJsDoc.destroy(); } catch { /* ignore */ }
  }
}

/**
 * Booklet imposition: pad to a multiple of 4, reorder pages so a folded
 * stapled stack reads in sequence, then 2-up onto landscape sheets. For a
 * 4-page document the sequence is [4, 1, 2, 3]; for 8 pages [8, 1, 2, 7, 6,
 * 3, 4, 5]; in general for N pages (N % 4 === 0) and i in 0..N/2:
 *   pair i: [N - i, i + 1]   if i is even
 *   pair i: [i + 1, N - i]   if i is odd
 */
export async function bookletImpose(
  base: Uint8Array,
  opts: {
    paper?: PaperSize;
    margin?: number;
    gutter?: number;
  } = {},
): Promise<Uint8Array> {
  const margin = opts.margin ?? 18;
  const gutter = opts.gutter ?? 9;
  const src = await load(base);
  const srcCount = src.getPageCount();
  if (srcCount === 0) return base;

  // Round up to the next multiple of 4 by appending blank pages whose size
  // matches page 1 — the booklet expects every leaf to be the same size.
  const padTo = Math.ceil(srcCount / 4) * 4;
  const blanks = padTo - srcCount;
  if (blanks > 0) {
    const refSize = src.getPage(0).getSize();
    for (let i = 0; i < blanks; i++) {
      src.addPage([refSize.width, refSize.height]);
    }
  }
  const total = src.getPageCount();

  // Compute the booklet sequence.
  const sequence: number[] = [];
  for (let i = 0; i < total / 2; i++) {
    if (i % 2 === 0) {
      sequence.push(total - i, i + 1); // last & first, third-last & third, …
    } else {
      sequence.push(i + 1, total - i);
    }
  }

  const firstSize = src.getPage(0).getSize();
  const sheet = resolvePaperSize(opts.paper ?? "letter", firstSize, "landscape");
  const cellWidth = (sheet.width - margin * 2 - gutter) / 2;
  const cellHeight = sheet.height - margin * 2;

  const out = await PDFDocument.create();
  const embedded = await out.embedPdf(
    src,
    sequence.map((p) => p - 1),
  );

  for (let pair = 0; pair < embedded.length; pair += 2) {
    const sheetPage = out.addPage([sheet.width, sheet.height]);
    for (let side = 0; side < 2; side++) {
      const ep = embedded[pair + side];
      if (!ep) continue;
      const cellX = margin + side * (cellWidth + gutter);
      const scale = Math.min(cellWidth / ep.width, cellHeight / ep.height);
      const drawW = ep.width * scale;
      const drawH = ep.height * scale;
      const drawX = cellX + (cellWidth - drawW) / 2;
      const drawY = margin + (cellHeight - drawH) / 2;
      sheetPage.drawPage(ep, { x: drawX, y: drawY, width: drawW, height: drawH });
    }
  }
  return toUint8(await out.save());
}

/**
 * Split each page in half (horizontal by default — left half becomes one
 * page, right half another) and produce a doc with twice as many pages.
 * Useful for scanned book spreads where two facing pages were captured as
 * one wide image. `direction: "vertical"` cuts horizontally instead (top
 * half + bottom half).
 */
export async function splitDoubleSpread(
  base: Uint8Array,
  opts: {
    direction?: "horizontal" | "vertical";
    gutter?: number; // points subtracted from each half (small overlap → 0)
  } = {},
): Promise<Uint8Array> {
  const direction = opts.direction ?? "horizontal";
  const gutter = opts.gutter ?? 0;
  const src = await load(base);
  const srcPages = src.getPages();
  if (srcPages.length === 0) return base;

  const out = await PDFDocument.create();
  const embedded = await out.embedPdf(src, srcPages.map((_, i) => i));

  for (const ep of embedded) {
    if (direction === "horizontal") {
      // Left half
      const halfW = ep.width / 2 - gutter / 2;
      const leftPage = out.addPage([halfW, ep.height]);
      leftPage.drawPage(ep, { x: 0, y: 0, width: ep.width, height: ep.height });
      leftPage.setCropBox(0, 0, halfW, ep.height);
      leftPage.setMediaBox(0, 0, halfW, ep.height);
      // Right half — draw the embed shifted so the right side aligns to x=0.
      const rightPage = out.addPage([halfW, ep.height]);
      rightPage.drawPage(ep, {
        x: -(ep.width / 2 + gutter / 2),
        y: 0,
        width: ep.width,
        height: ep.height,
      });
      rightPage.setCropBox(0, 0, halfW, ep.height);
      rightPage.setMediaBox(0, 0, halfW, ep.height);
    } else {
      // Vertical split (top + bottom).
      const halfH = ep.height / 2 - gutter / 2;
      const topPage = out.addPage([ep.width, halfH]);
      topPage.drawPage(ep, {
        x: 0,
        y: -(ep.height / 2 + gutter / 2),
        width: ep.width,
        height: ep.height,
      });
      topPage.setCropBox(0, 0, ep.width, halfH);
      topPage.setMediaBox(0, 0, ep.width, halfH);
      const bottomPage = out.addPage([ep.width, halfH]);
      bottomPage.drawPage(ep, { x: 0, y: 0, width: ep.width, height: ep.height });
      bottomPage.setCropBox(0, 0, ep.width, halfH);
      bottomPage.setMediaBox(0, 0, ep.width, halfH);
    }
  }
  return toUint8(await out.save());
}
