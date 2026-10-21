// V1.0128 — "Full page" at 2/4/6/9 per sheet trims the pages' white margins
// to one shared content box so the content fills its tile. Adam (2026-10-13):
// "Why wouldn't full page work with multiple sheets? It could work here."
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, rgb } from "pdf-lib";
import sharp from "sharp";
import * as ops from "../../src/renderer/lib/pdf-ops";
import { unionViewBoxes, viewBoxToPdfBox } from "../../src/renderer/lib/print-trim";

describe("print-trim geometry", () => {
  it("union keeps every page's content (one shared scale for all tiles)", () => {
    expect(
      unionViewBoxes([
        { x: 50, y: 40, w: 480, h: 760 },
        null, // blank page
        { x: 60, y: 30, w: 500, h: 300 },
      ]),
    ).toEqual({ x: 50, y: 30, w: 510, h: 770 });
    expect(unionViewBoxes([null, null])).toBeNull();
  });

  it("maps a top-left viewport box into PDF user space (bottom-left origin)", () => {
    const crop = { x: 0, y: 0, width: 600, height: 800 };
    // content 100 from the top, 200 tall → PDF y = 800 - 300 = 500
    expect(viewBoxToPdfBox({ x: 50, y: 100, w: 400, h: 200 }, crop)).toEqual({
      x: 50,
      y: 500,
      width: 400,
      height: 200,
    });
  });

  it("honours a crop box that doesn't start at 0,0 (Canva-style y0 offset)", () => {
    const crop = { x: 10, y: 20, width: 600, height: 800 };
    expect(viewBoxToPdfBox({ x: 50, y: 100, w: 400, h: 200 }, crop)).toEqual({
      x: 60,
      y: 520,
      width: 400,
      height: 200,
    });
  });

  it("clamps padding that runs past the page edge", () => {
    const crop = { x: 0, y: 0, width: 600, height: 800 };
    expect(viewBoxToPdfBox({ x: -6, y: -6, w: 312, h: 812 }, crop)).toEqual({
      x: 0,
      y: 0,
      width: 306,
      height: 800,
    });
  });

  it("skips a trim that would save nothing (content already edge to edge)", () => {
    const crop = { x: 0, y: 0, width: 600, height: 800 };
    expect(viewBoxToPdfBox({ x: -6, y: -6, w: 612, h: 812 }, crop)).toBeNull();
  });
});

/** Render page 1 with macOS PDFKit (Preview's engine), composited on white,
 *  and return the dark-pixel bounding box as fractions of the sheet. */
function inkBox(bytes: Uint8Array) {
  const dir = mkdtempSync(join(tmpdir(), "weave-trim-"));
  const f = join(dir, "s.pdf");
  writeFileSync(f, bytes);
  execFileSync("qlmanage", ["-t", "-s", "800", "-o", dir, f], { stdio: "ignore" });
  return join(dir, "s.pdf.png");
}
async function darkBounds(png: string) {
  const { data, info } = await sharp(png).flatten({ background: "#ffffff" }).raw().toBuffer({ resolveWithObject: true });
  let minX = info.width, maxX = -1, minY = info.height, maxY = -1;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const k = (y * info.width + x) * info.channels;
      if (data[k] < 100 && data[k + 1] < 100 && data[k + 2] < 100) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  return { w: (maxX - minX + 1) / info.width, h: (maxY - minY + 1) / info.height, ok: maxX >= 0 };
}

describe("trimmed pages through the real n-up", () => {
  // An A4 page whose content (a black block) sits inside wide white margins.
  async function a4WithMargins() {
    const d = await PDFDocument.create();
    for (let i = 0; i < 2; i++) {
      const p = d.addPage([595.92, 841.92]);
      p.drawRectangle({ x: 100, y: 150, width: 395.92, height: 541.92, color: rgb(0, 0, 0) });
    }
    return d.save();
  }

  it("content fills a much larger share of the sheet, nothing is lost", async () => {
    const src = await a4WithMargins();
    const plain = await ops.nUpPages(src, 2, { paper: "letter", orientation: "landscape" });

    // Same trim the app computes (viewport top-left box → PDF box), with the
    // pixel scan replaced by the known content rectangle + 6 pt padding.
    const d = await PDFDocument.load(src);
    for (const p of d.getPages()) {
      const b = viewBoxToPdfBox({ x: 94, y: 144, w: 407.92, h: 553.92 }, p.getCropBox())!;
      p.setMediaBox(b.x, b.y, b.width, b.height);
      p.setCropBox(b.x, b.y, b.width, b.height);
    }
    const trimmed = await ops.nUpPages(await d.save(), 2, { paper: "letter", orientation: "landscape" });

    const before = await darkBounds(inkBox(plain));
    const after = await darkBounds(inkBox(trimmed));
    expect(before.ok && after.ok).toBe(true);
    // Control: untrimmed, the blocks fill well under the sheet's height.
    expect(before.h).toBeLessThan(0.7);
    // Trimmed: the same blocks fill most of it, and stay inside the sheet.
    expect(after.h).toBeGreaterThan(before.h * 1.3);
    expect(after.h).toBeLessThan(1);
    expect(after.w).toBeLessThan(1);
  }, 30000);

  it("a rotated page is never trimmed (safe fallback = print as before)", async () => {
    const d = await PDFDocument.create();
    const p = d.addPage([595.92, 841.92]);
    p.setRotation({ type: "degrees", angle: 90 } as never);
    const src = await d.save();
    // Returns before any rendering, so this runs without a canvas.
    expect(await ops.trimPagesToContentForPrint(src)).toBe(src);
  });
});
