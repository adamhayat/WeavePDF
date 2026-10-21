// Reproduction for the V1.0114 "saving doesn't work when I update a file" bug.
// Saving runs commitAllPending, which bakes pending edits through these
// primitives (all pure pdf-lib). If any throws, commitAllPending rejects and —
// because saveTabById doesn't wrap it — the save silently fails. This exercises
// the bakers the way commitAllPending does, on a normal (rot 0) AND a rotated
// page, to catch a regression from the V1.0112 rotation work.
import { describe, it, expect } from "vitest";
import { PDFDocument, degrees } from "pdf-lib";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - legacy build ships no bundled types
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  drawText,
  drawWrappedText,
  whiteoutRegion,
  drawRect,
  drawCircle,
  drawPath,
  placeImage,
} from "../../src/renderer/lib/pdf-ops";

async function freshPdf(rotation = 0, crop?: [number, number, number, number]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  if (crop) page.setCropBox(...crop);
  if (rotation) page.setRotation(degrees(rotation));
  return doc.save();
}

const BLACK = { r: 0, g: 0, b: 0 };
// A valid 1x1 PNG (stands in for a placed signature image).
const PNG_1x1 = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);

describe("save bake path doesn't throw", () => {
  for (const rotation of [0, 90, 270]) {
    it(`whiteoutRegion @ rot ${rotation}`, async () => {
      const out = await whiteoutRegion(await freshPdf(rotation), 1, { x: 100, y: 100, width: 80, height: 14 });
      expect(out.byteLength).toBeGreaterThan(100);
    });
    it(`drawText @ rot ${rotation}`, async () => {
      const r = await drawText(await freshPdf(rotation), 1, { x: 100, y: 100, size: 14, text: "Hello world" });
      expect(r.bytes.byteLength).toBeGreaterThan(100);
    });
    it(`drawWrappedText @ rot ${rotation}`, async () => {
      const r = await drawWrappedText(await freshPdf(rotation), 1, {
        x: 100, y: 700, widthPt: 200, size: 12,
        text: "Line one and some more\nLine two that should wrap around the box width nicely",
      });
      expect(r.bytes.byteLength).toBeGreaterThan(100);
    });
    it(`drawRect @ rot ${rotation}`, async () => {
      const out = await drawRect(await freshPdf(rotation), 1, { x: 100, y: 100, width: 50, height: 30 }, { color: BLACK, thickness: 1.5 });
      expect(out.byteLength).toBeGreaterThan(100);
    });
    it(`drawCircle @ rot ${rotation}`, async () => {
      const out = await drawCircle(await freshPdf(rotation), 1, { x: 100, y: 100, width: 50, height: 30 }, { color: BLACK, thickness: 1.5 });
      expect(out.byteLength).toBeGreaterThan(100);
    });
    it(`drawPath checkmark @ rot ${rotation}`, async () => {
      const out = await drawPath(await freshPdf(rotation), 1, [{ x: 100, y: 109 }, { x: 106, y: 100 }, { x: 118, y: 117 }], { color: BLACK, thickness: 2 });
      expect(out.byteLength).toBeGreaterThan(100);
    });
  }
});

// placeImage bakes a placed image (a drawn signature is a pending IMAGE edit).
// This is the baker that signing exercises on save. Cover rotations + a
// CropBox-offset page (real forms often have one) + the image's own rotation.
describe("placeImage (signature/image bake) doesn't throw", () => {
  for (const rotation of [0, 90, 180, 270]) {
    it(`@ page rot ${rotation}`, async () => {
      const out = await placeImage(
        await freshPdf(rotation), 1, PNG_1x1, "image/png",
        { x: 100, y: 100, width: 120, height: 40 },
        { rotation: 0, opacity: 1 },
      );
      expect(out.byteLength).toBeGreaterThan(100);
    });
  }
  it("@ CropBox offset", async () => {
    const out = await placeImage(
      await freshPdf(0, [20, 30, 400, 600]), 1, PNG_1x1, "image/png",
      { x: 100, y: 100, width: 120, height: 40 },
      { rotation: 0, opacity: 1 },
    );
    expect(out.byteLength).toBeGreaterThan(100);
  });
  it("@ with image rotation + border + drop shadow", async () => {
    const out = await placeImage(
      await freshPdf(0), 1, PNG_1x1, "image/png",
      { x: 100, y: 100, width: 120, height: 40 },
      { rotation: 30, opacity: 0.9, border: { widthPt: 1, color: BLACK }, dropShadow: { offsetXPt: 2, offsetYPt: -2, blurPt: 3, opacity: 0.3, color: BLACK } },
    );
    expect(out.byteLength).toBeGreaterThan(100);
  });
});

// commitAllPending bakes, then RELOADS the result through pdf.js (loadPdf). If
// pdf.js can't parse the baked bytes, commitAllPending rejects and the save
// silently dies. Verify the baked output round-trips through pdf.js.
describe("baked output reloads in pdf.js (commitAllPending's final loadPdf)", () => {
  async function reloads(bytes: Uint8Array): Promise<number> {
    const pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    return pdf.numPages;
  }
  it("drawText output", async () => {
    const r = await drawText(await freshPdf(0), 1, { x: 100, y: 100, size: 14, text: "Hello world" });
    expect(await reloads(r.bytes)).toBe(1);
  });
  it("drawWrappedText output", async () => {
    const r = await drawWrappedText(await freshPdf(0), 1, { x: 100, y: 700, widthPt: 200, size: 12, text: "wrapped\nlines of text here" });
    expect(await reloads(r.bytes)).toBe(1);
  });
  it("checkmark (drawPath) output", async () => {
    const out = await drawPath(await freshPdf(0), 1, [{ x: 100, y: 109 }, { x: 106, y: 100 }, { x: 118, y: 117 }], { color: BLACK, thickness: 2 });
    expect(await reloads(out)).toBe(1);
  });
  it("rotated-page text output", async () => {
    const r = await drawText(await freshPdf(90), 1, { x: 100, y: 100, size: 14, text: "Sideways" });
    expect(await reloads(r.bytes)).toBe(1);
  });
});
