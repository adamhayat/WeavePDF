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
  // coords are in PDF user space (points, bottom-left origin)
  region: { x: number; y: number; width: number; height: number },
): Promise<Uint8Array> {
  const doc = await load(base);
  const page = doc.getPage(page1Based - 1);
  page.drawRectangle({
    x: region.x,
    y: region.y,
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
  },
): Promise<Uint8Array> {
  const doc = await load(base);
  const page = doc.getPage(page1Based - 1);
  const font = await doc.embedFont(opts.font ?? StandardFonts.Helvetica);
  const c = opts.color ?? { r: 0, g: 0, b: 0 };
  page.drawText(opts.text, {
    x: opts.x,
    y: opts.y,
    size: opts.size,
    font,
    color: rgb(c.r, c.g, c.b),
  });
  return toUint8(await doc.save());
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
  page.drawRectangle({
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
    color: rgb(color.r, color.g, color.b),
    opacity: 0.4,
    borderWidth: 0,
  });
  return toUint8(await doc.save());
}

/** Embed an image at the given region on a page (for signatures). */
export async function placeImage(
  base: Uint8Array,
  page1Based: number,
  imageBytes: Uint8Array,
  mime: "image/png" | "image/jpeg",
  region: { x: number; y: number; width: number; height: number },
): Promise<Uint8Array> {
  const doc = await load(base);
  const page = doc.getPage(page1Based - 1);
  const img =
    mime === "image/png"
      ? await doc.embedPng(imageBytes)
      : await doc.embedJpg(imageBytes);
  page.drawImage(img, {
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
  });
  return toUint8(await doc.save());
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
  const c = opts.color ?? { r: 0, g: 0, b: 0 };
  const f = opts.fill ?? null;
  page.drawRectangle({
    x: region.x,
    y: region.y,
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
  const c = opts.color ?? { r: 0, g: 0, b: 0 };
  const f = opts.fill ?? null;
  // pdf-lib's drawEllipse uses center + radii.
  page.drawEllipse({
    x: region.x + region.width / 2,
    y: region.y + region.height / 2,
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
  const c = opts.color ?? { r: 0, g: 0, b: 0 };
  page.drawLine({
    start,
    end,
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
  const c = opts.color ?? { r: 0, g: 0, b: 0 };
  const thickness = opts.thickness ?? 1.5;

  // Shaft: stop a bit short of the tip so the arrowhead meets cleanly.
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len < 2) {
    page.drawLine({ start, end, color: rgb(c.r, c.g, c.b), thickness });
    return toUint8(await doc.save());
  }
  const ux = dx / len;
  const uy = dy / len;
  const headLen = Math.max(8, thickness * 4);
  const headWidth = Math.max(6, thickness * 3);
  const shaftEnd = { x: end.x - ux * headLen * 0.6, y: end.y - uy * headLen * 0.6 };
  page.drawLine({
    start,
    end: shaftEnd,
    color: rgb(c.r, c.g, c.b),
    thickness,
    opacity: opts.opacity ?? 1,
  });

  // Arrowhead triangle — two points perpendicular to the shaft, one at the tip.
  const px = -uy;
  const py = ux;
  const baseCenter = { x: end.x - ux * headLen, y: end.y - uy * headLen };
  const left = {
    x: baseCenter.x + px * (headWidth / 2),
    y: baseCenter.y + py * (headWidth / 2),
  };
  const right = {
    x: baseCenter.x - px * (headWidth / 2),
    y: baseCenter.y - py * (headWidth / 2),
  };
  page.drawSvgPath(
    `M ${left.x} ${left.y} L ${end.x} ${end.y} L ${right.x} ${right.y} Z`,
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
    const yHeader = height - margin;
    const yFooter = margin - size * 0.2;
    if (opts.header) {
      const tw = font.widthOfTextAtSize(opts.header, size);
      page.drawText(opts.header, {
        x: (width - tw) / 2,
        y: yHeader,
        size,
        font,
        color: rgb(color.r, color.g, color.b),
      });
    }
    if (opts.footer) {
      const tw = font.widthOfTextAtSize(opts.footer, size);
      page.drawText(opts.footer, {
        x: (width - tw) / 2,
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
        x: width - margin - tw,
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
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boxSize = 16;
  // Marker square
  page.drawRectangle({
    x: position.x,
    y: position.y,
    width: boxSize,
    height: boxSize,
    color: rgb(1, 0.87, 0.35),
    borderColor: rgb(0.75, 0.6, 0.1),
    borderWidth: 0.8,
  });
  // Folded-corner triangle for character.
  page.drawSvgPath(
    `M ${position.x + boxSize - 5} ${page.getHeight() - position.y - boxSize + 5}
     L ${position.x + boxSize} ${page.getHeight() - position.y - boxSize + 5}
     L ${position.x + boxSize} ${page.getHeight() - position.y} Z`,
    {
      color: rgb(0.95, 0.8, 0.2),
      x: 0,
      y: page.getHeight(),
    },
  );
  // Text to the right of the marker.
  const wrapped = wrapText(text, font, 10, 220);
  let y = position.y + boxSize - 10;
  for (const line of wrapped) {
    page.drawText(line, {
      x: position.x + boxSize + 6,
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
  const c = opts.color ?? { r: 0.1, g: 0.1, b: 0.1 };
  // pdf-lib's drawSvgPath treats the path's y as growing DOWN from {x, y}.
  // Anchor at (0, pageHeight) and flip each y into DOM-style coords.
  const pageHeight = page.getHeight();
  const d =
    `M ${points[0].x} ${pageHeight - points[0].y} ` +
    points
      .slice(1)
      .map((p) => `L ${p.x} ${pageHeight - p.y}`)
      .join(" ");
  page.drawSvgPath(d, {
    borderColor: rgb(c.r, c.g, c.b),
    borderWidth: opts.thickness ?? 1.5,
    borderOpacity: opts.opacity ?? 1,
    x: 0,
    y: pageHeight,
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
    page.drawText(label, {
      x: margin,
      y: margin - size * 0.2,
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
    for (const b of boxes) {
      const text = b.text.trim();
      if (!text) continue;
      const x = b.x * width;
      const y = b.y * height;
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
        // V1.0037: pdf-lib's default appearance generator uses a font size
        // of 0 (auto-fit), which scales the text to fill the entire field
        // height — text ends up flush against top + bottom + left borders
        // with no internal padding, which the user reads as "appended to
        // the border". Set an explicit size that leaves ~3pt of breathing
        // room top + bottom. setFontSize after setText regenerates the
        // appearance stream with the new size.
        try {
          const widgets = field.acroField.getWidgets();
          const rect = widgets[0]?.getRectangle();
          if (rect) {
            const fieldHeight = Math.abs(rect.height);
            // Leave 6pt total padding (3pt top, 3pt bottom). Clamp 8..14pt
            // — typical form-field font range; smaller fields still get
            // 8pt minimum for readability.
            const target = Math.max(8, Math.min(14, fieldHeight - 6));
            field.setFontSize(target);
          }
        } catch {
          // Some fields don't support setFontSize (e.g. multiline with
          // explicit DA); leave as-is rather than abort.
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
    const fontSize = Math.min(width, height) * 0.12;
    const textWidth = font.widthOfTextAtSize(text, fontSize);
    // pdf-lib rotates text around (x, y) — its baseline-left anchor — so to
    // visually center the rotated text box on the page, offset (x, y) by
    // (-textWidth/2, -textHeight/2) in the ROTATED frame.
    const rad = (rotation * Math.PI) / 180;
    const halfW = textWidth / 2;
    const halfH = fontSize * 0.35; // approx visual mid-height from baseline
    const x = width / 2 - halfW * Math.cos(rad) + halfH * Math.sin(rad);
    const y = height / 2 - halfW * Math.sin(rad) - halfH * Math.cos(rad);
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
export async function nUpPages(
  base: Uint8Array,
  perSheet: 2 | 4 | 6 | 9,
  opts: {
    paper?: PaperSize;
    orientation?: "portrait" | "landscape" | "auto";
    margin?: number; // points around outside of sheet
    gutter?: number; // points between cells
    addBorders?: boolean;
  } = {},
): Promise<Uint8Array> {
  const margin = opts.margin ?? 18;
  const gutter = opts.gutter ?? 9;
  const addBorders = opts.addBorders ?? false;
  const grid = (
    {
      2: { cols: 1, rows: 2, defaultOrient: "landscape" as const },
      4: { cols: 2, rows: 2, defaultOrient: "portrait" as const },
      6: { cols: 2, rows: 3, defaultOrient: "portrait" as const },
      9: { cols: 3, rows: 3, defaultOrient: "portrait" as const },
    } as const
  )[perSheet];
  // For 2-up the cells are stacked top + bottom; rotating a landscape sheet
  // makes them feel like "two pages side by side" when read like a book.
  const cells = grid.cols * grid.rows;

  const src = await load(base);
  const srcPages = src.getPages();
  if (srcPages.length === 0) return base;
  const firstSize = srcPages[0].getSize();
  const orientation = opts.orientation ?? grid.defaultOrient;
  const sheet = resolvePaperSize(opts.paper ?? "letter", firstSize, orientation);

  // 2-up specifically: lay pages side-by-side on a landscape sheet (cols=2).
  // The grid above still puts them as 1×2 because that's the natural "two
  // pages stacked" — but for 2-up we want 2×1 landscape, the canonical layout.
  const layout =
    perSheet === 2
      ? { cols: 2, rows: 1 }
      : { cols: grid.cols, rows: grid.rows };

  const cellWidth = (sheet.width - margin * 2 - gutter * (layout.cols - 1)) / layout.cols;
  const cellHeight = (sheet.height - margin * 2 - gutter * (layout.rows - 1)) / layout.rows;

  // Build a fresh document and embed all source pages once (faster than
  // embedding per-output-page).
  const out = await PDFDocument.create();
  const indices = srcPages.map((_, i) => i);
  const embedded = await out.embedPdf(src, indices);

  for (let start = 0; start < embedded.length; start += cells) {
    const sheetPage = out.addPage([sheet.width, sheet.height]);
    for (let i = 0; i < cells; i++) {
      const srcIdx = start + i;
      if (srcIdx >= embedded.length) break;
      const ep = embedded[srcIdx];
      // Cell origin (top-left in human terms; pdf-lib uses bottom-left).
      const col = i % layout.cols;
      const row = Math.floor(i / layout.cols);
      const cellX = margin + col * (cellWidth + gutter);
      const cellTopY = sheet.height - margin - row * (cellHeight + gutter);
      // Compute scaled embed size that fits the cell while preserving aspect.
      const scale = Math.min(cellWidth / ep.width, cellHeight / ep.height);
      const drawW = ep.width * scale;
      const drawH = ep.height * scale;
      // Centre inside the cell.
      const drawX = cellX + (cellWidth - drawW) / 2;
      const drawY = cellTopY - cellHeight + (cellHeight - drawH) / 2;
      sheetPage.drawPage(ep, { x: drawX, y: drawY, width: drawW, height: drawH });
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
  }
  return toUint8(await out.save());
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
