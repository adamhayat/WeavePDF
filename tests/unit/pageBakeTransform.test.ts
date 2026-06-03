// Unit test for the V1.0111/V1.0112 rotation-aware bake transform. Verifies
// `pageBakeTransform(page).point()` against pdf.js's own
// `viewport.convertToPdfPoint` — the ground truth the renderer uses to place
// overlays — for every page /Rotate, with and without a CropBox offset. Runs in
// plain Node (no app launch): `npm run test:unit`.
import { describe, it, expect } from "vitest";
import { PDFDocument, degrees } from "pdf-lib";
// Legacy build is the Node-friendly entry (no DOM worker needed for geometry).
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - the legacy build ships no bundled type declarations
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { pageBakeTransform } from "../../src/renderer/lib/pdf-ops";

async function makePdf(opts: {
  w: number;
  h: number;
  rotation: number;
  crop?: [number, number, number, number]; // x, y, w, h
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([opts.w, opts.h]);
  if (opts.crop) page.setCropBox(...opts.crop);
  page.setRotation(degrees(opts.rotation));
  return doc.save();
}

const SAMPLE_VP_POINTS = (Wd: number, Hd: number): [number, number][] => [
  [0, 0],
  [Wd, 0],
  [0, Hd],
  [Wd, Hd],
  [37, 91],
  [Wd / 2, Hd / 3],
];

describe("pageBakeTransform.point() matches pdf.js convertToPdfPoint", () => {
  for (const rotation of [0, 90, 180, 270]) {
    for (const crop of [undefined, [20, 30, 400, 600] as [number, number, number, number]]) {
      const label = `rotation ${rotation}, crop ${crop ? "offset" : "none"}`;
      it(label, async () => {
        // MediaBox is the crop box + its offset (so the visible page is 400x600).
        const mediaW = crop ? crop[0] + crop[2] + 10 : 400;
        const mediaH = crop ? crop[1] + crop[3] + 10 : 600;
        const bytes = await makePdf({ w: mediaW, h: mediaH, rotation, crop });

        const libDoc = await PDFDocument.load(bytes);
        const bt = pageBakeTransform(libDoc.getPage(0));

        const pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
        const vp = (await pdf.getPage(1)).getViewport({ scale: 1 });
        const Wd: number = vp.width;
        const Hd: number = vp.height;

        for (const [vx, vy] of SAMPLE_VP_POINTS(Wd, Hd)) {
          const truth = vp.convertToPdfPoint(vx, vy); // [userX, userY], bottom-left
          // PageCanvas stores bottom-left display coords: dx = vx, dy = Hd - vy.
          const mine = bt.point(vx, Hd - vy);
          expect(mine.x, `x @ (${vx},${vy})`).toBeCloseTo(truth[0], 4);
          expect(mine.y, `y @ (${vx},${vy})`).toBeCloseTo(truth[1], 4);
        }
      });
    }
  }
});

describe("pageBakeTransform.rect() swaps width/height for 90/270 and is identity at 0", () => {
  it("rotation 0 is a pure CropBox-origin shift", async () => {
    const bytes = await makePdf({ w: 400, h: 600, rotation: 0 });
    const bt = pageBakeTransform((await PDFDocument.load(bytes)).getPage(0));
    const r = bt.rect(10, 20, 100, 50);
    expect(r).toMatchObject({ x: 10, y: 20, width: 100, height: 50 });
  });

  it("rotation 90 swaps width and height", async () => {
    const bytes = await makePdf({ w: 400, h: 600, rotation: 90 });
    const bt = pageBakeTransform((await PDFDocument.load(bytes)).getPage(0));
    const r = bt.rect(10, 20, 100, 50);
    // A 100x50 display rect becomes 50x100 in user space on a 90° page.
    expect(r.width).toBeCloseTo(50, 4);
    expect(r.height).toBeCloseTo(100, 4);
  });
});
