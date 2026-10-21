/**
 * V1.0134: the sidebar thumbnail paints the page's editable elements the way
 * the page shows them — the real image, the real text, the real shapes — in
 * the same stacking order as the viewer and the save (`orderLayers`).
 *
 * Adam: "Why is the left sidebar not showing proper preview of pasted
 * screenshot" — since V1.0090 every pending element was a translucent
 * indigo rectangle, so a pasted screenshot showed as a purple box.
 *
 * Pure: takes any 2D-context-shaped object, so it runs in node tests with a
 * recording fake. Decoded images are handed in by the caller (decoding is
 * async and cached in the Sidebar).
 */
import type { PendingImageEdit, PendingShapeEdit, PendingTextEdit } from "../stores/document";
import { orderLayers } from "./layers";
import { overlayFontFamily } from "./overlay-font";

export type ThumbContext = {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  stroke(): void;
  fill(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
};

export type ThumbArrays = {
  text: PendingTextEdit[];
  image: PendingImageEdit[];
  shape: PendingShapeEdit[];
};

export type ImageLookup = (edit: PendingImageEdit) => CanvasImageSource | null;

function css(c: { r: number; g: number; b: number } | undefined, fallback: string): string {
  if (!c) return fallback;
  const f = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${f(c.r)}, ${f(c.g)}, ${f(c.b)})`;
}

/** Greedy word wrap on measured widths; explicit newlines always break.
 *  A single word wider than the box is split character-wise so nothing
 *  is dropped (mirrors `break-word` on screen). */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/(\s+)/).filter((w) => w.length > 0);
    let line = "";
    const splitLongWord = () => {
      while (measure(line) > maxWidth && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && measure(line.slice(0, cut)) > maxWidth) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    };
    for (const w of words) {
      const candidate = line + w;
      if (line.length === 0 || measure(candidate) <= maxWidth) {
        line = candidate;
        if (line.length > 0 && !/^\s+$/.test(line)) splitLongWord();
        continue;
      }
      out.push(line.trimEnd());
      line = w.trimStart();
      splitLongWord();
    }
    out.push(line.trimEnd());
  }
  return out;
}

function paintText(ctx: ThumbContext, e: PendingTextEdit, scale: number, pageHPt: number): void {
  const size = e.size * scale;
  if (e.whiteout) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(e.whiteout.x * scale, (pageHPt - e.whiteout.y - e.whiteout.height) * scale, e.whiteout.width * scale, e.whiteout.height * scale);
  }
  ctx.font = `${e.italic ? "italic " : ""}${e.bold ? "bold " : ""}${size}px ${overlayFontFamily(e.fontName)}`;
  ctx.fillStyle = css(e.color, "#0b0b0e");
  ctx.textBaseline = "alphabetic";
  const x = e.xPt * scale;
  const baseline = (pageHPt - e.yPt) * scale;
  const lines = e.widthPt != null
    ? wrapLines(e.text, e.widthPt * scale, (s) => ctx.measureText(s).width)
    : e.text.split("\n");
  const lineH = e.widthPt != null ? size * 1.2 : size;
  const boxW = e.widthPt != null ? e.widthPt * scale : 0;
  const align = e.widthPt != null ? e.align ?? "left" : "left";
  // Alignment is relative to the longest line (V1.0077), not the frame.
  const longest = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
  ctx.textAlign = "left";
  lines.forEach((line, i) => {
    const w = ctx.measureText(line).width;
    let dx = 0;
    if (align === "center") dx = (longest - w) / 2;
    else if (align === "right") dx = longest - w;
    void boxW;
    ctx.fillText(line, x + dx, baseline + i * lineH);
  });
}

function paintImage(ctx: ThumbContext, e: PendingImageEdit, scale: number, pageHPt: number, lookup: ImageLookup): void {
  const w = e.widthPt * scale;
  const h = e.heightPt * scale;
  const x = e.xPt * scale;
  const y = (pageHPt - e.yPt - e.heightPt) * scale;
  const img = lookup(e);
  ctx.save();
  ctx.globalAlpha = e.opacity ?? 1;
  ctx.translate(x + w / 2, y + h / 2);
  if (e.rotation) ctx.rotate((e.rotation * Math.PI) / 180);
  ctx.scale(e.flipH ? -1 : 1, e.flipV ? -1 : 1);
  if (img) {
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
  } else {
    // Still decoding: a light placeholder so the thumbnail reads "image here".
    ctx.fillStyle = "rgba(109, 94, 245, 0.18)";
    ctx.fillRect(-w / 2, -h / 2, w, h);
  }
  if (e.border && e.border.widthPt > 0) {
    ctx.strokeStyle = css(e.border.color, "#000");
    ctx.lineWidth = Math.max(0.5, e.border.widthPt * scale);
    ctx.strokeRect(-w / 2, -h / 2, w, h);
  }
  ctx.restore();
}

function paintShape(ctx: ThumbContext, s: PendingShapeEdit, scale: number, pageHPt: number): void {
  const X = (v: number) => v * scale;
  const Y = (v: number) => (pageHPt - v) * scale;
  ctx.save();
  switch (s.kind) {
    case "rect":
    case "ellipse": {
      ctx.strokeStyle = css(s.color, "#000");
      ctx.lineWidth = Math.max(0.5, s.thickness * scale);
      const x = X(s.xPt);
      const y = Y(s.yPt + s.heightPt);
      const w = s.widthPt * scale;
      const h = s.heightPt * scale;
      if (s.kind === "rect") {
        ctx.strokeRect(x, y, w, h);
      } else {
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
    case "line":
    case "arrow": {
      ctx.strokeStyle = css(s.color, "#000");
      ctx.lineWidth = Math.max(0.5, s.thickness * scale);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(X(s.fromX), Y(s.fromY));
      ctx.lineTo(X(s.toX), Y(s.toY));
      ctx.stroke();
      if (s.kind === "arrow") {
        const ang = Math.atan2(Y(s.toY) - Y(s.fromY), X(s.toX) - X(s.fromX));
        const len = Math.max(3, 8 * scale * Math.max(1, s.thickness));
        ctx.beginPath();
        ctx.moveTo(X(s.toX), Y(s.toY));
        ctx.lineTo(X(s.toX) - len * Math.cos(ang - Math.PI / 6), Y(s.toY) - len * Math.sin(ang - Math.PI / 6));
        ctx.moveTo(X(s.toX), Y(s.toY));
        ctx.lineTo(X(s.toX) - len * Math.cos(ang + Math.PI / 6), Y(s.toY) - len * Math.sin(ang + Math.PI / 6));
        ctx.stroke();
      }
      break;
    }
    case "freehand": {
      if (s.points.length === 0) break;
      ctx.strokeStyle = css(s.color, "#000");
      ctx.lineWidth = Math.max(0.5, s.thickness * scale);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(X(s.points[0].x), Y(s.points[0].y));
      for (const p of s.points.slice(1)) ctx.lineTo(X(p.x), Y(p.y));
      ctx.stroke();
      break;
    }
    case "highlight":
      ctx.fillStyle = "rgba(255, 230, 0, 0.45)";
      ctx.fillRect(X(s.xPt), Y(s.yPt + s.heightPt), s.widthPt * scale, s.heightPt * scale);
      break;
    case "whiteout":
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(X(s.xPt), Y(s.yPt + s.heightPt), s.widthPt * scale, s.heightPt * scale);
      break;
    case "redact":
      ctx.fillStyle = "#000000";
      ctx.fillRect(X(s.xPt), Y(s.yPt + s.heightPt), s.widthPt * scale, s.heightPt * scale);
      break;
    case "sticky": {
      const w = 20 * scale;
      ctx.fillStyle = "#ffe066";
      ctx.fillRect(X(s.xPt), Y(s.yPt), w, w);
      ctx.strokeStyle = "#c9a400";
      ctx.lineWidth = 0.5;
      ctx.strokeRect(X(s.xPt), Y(s.yPt), w, w);
      break;
    }
  }
  ctx.restore();
}

/**
 * Paint one page's pending elements onto a thumbnail already holding the
 * page's baked render. `scale` = thumbnail CSS px per PDF point.
 */
export function paintPendingOverlays(
  ctx: ThumbContext,
  arrays: ThumbArrays,
  page: number,
  scale: number,
  pageHPt: number,
  lookup: ImageLookup,
): void {
  for (const layer of orderLayers(arrays, page)) {
    if (layer.kind === "text") paintText(ctx, layer.edit, scale, pageHPt);
    else if (layer.kind === "image") paintImage(ctx, layer.edit, scale, pageHPt, lookup);
    else paintShape(ctx, layer.edit, scale, pageHPt);
  }
}
