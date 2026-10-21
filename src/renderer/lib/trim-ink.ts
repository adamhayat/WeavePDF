/**
 * V1.0126: crop a signature image to its ink. The saved drawing is the WHOLE
 * signature pad (transparent margins included), so a placed signature landed
 * well right of and below the click and sat inside a selection box much
 * bigger than the ink. Pure pixel scan of the alpha channel; returns null when
 * there is no ink (or the canvas can't be read) so callers fall back.
 */
export function inkBounds(
  alpha: (x: number, y: number) => number,
  width: number,
  height: number,
  threshold = 8,
): { x: number; y: number; w: number; h: number } | null {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha(x, y) > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Crop `img` to its ink plus `padPx`. Returns a PNG data URL and its size. */
export function trimImageToInk(
  img: HTMLImageElement,
  padPx = 6,
): { dataUrl: string; width: number; height: number } | null {
  try {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    const b = inkBounds((x, y) => data[(y * w + x) * 4 + 3], w, h);
    if (!b) return null;
    const x = Math.max(0, b.x - padPx);
    const y = Math.max(0, b.y - padPx);
    const cw = Math.min(w - x, b.w + padPx * 2);
    const ch = Math.min(h - y, b.h + padPx * 2);
    const out = document.createElement("canvas");
    out.width = cw;
    out.height = ch;
    out.getContext("2d")?.drawImage(c, x, y, cw, ch, 0, 0, cw, ch);
    return { dataUrl: out.toDataURL("image/png"), width: cw, height: ch };
  } catch {
    return null;
  }
}
