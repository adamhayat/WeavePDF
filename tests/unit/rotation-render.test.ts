// The "proper rotated-PDF check" — verifies the part of the V1.0112 rotation
// work the unit tests couldn't before: that baked text RENDERS UPRIGHT on a
// /Rotate 90/180/270 page (the `rotate: degrees(r)` orientation), not sideways.
// pdf.js getTextContent reports each text run's matrix; combined with the
// rotation-applied viewport, an upright run advances horizontally on the
// displayed page (|m0| dominates |m1|) — a sideways run (a wrong rotate sign)
// would advance vertically (|m1| dominates). No canvas/app needed.
import { describe, it, expect } from "vitest";
import { PDFDocument, degrees } from "pdf-lib";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - legacy build ships no bundled types
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { drawText } from "../../src/renderer/lib/pdf-ops";

async function freshPdf(rotation: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  if (rotation) page.setRotation(degrees(rotation));
  return doc.save();
}

// pdf.js Util.transform(m1, m2) — compose two 2D affine matrices.
function mul(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

describe("baked text renders upright (horizontal), not sideways, on rotated pages", () => {
  for (const rotation of [0, 90, 180, 270]) {
    it(`rot ${rotation}`, async () => {
      const r = await drawText(await freshPdf(rotation), 1, { x: 80, y: 300, size: 20, text: "ABCDEFG" });
      const pdf = await pdfjs.getDocument({ data: r.bytes.slice(), isEvalSupported: false }).promise;
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 1 }); // applies /Rotate → display space
      const tc = await page.getTextContent();
      // pdf.js items are TextItem | TextMarkedContent; only TextItem has str/transform.
      const item = tc.items.find((i) => "str" in i && i.str.trim().length > 0) as { transform: number[] } | undefined;
      expect(item, `rot ${rotation}: baked text not found in text content`).toBeTruthy();
      const m = mul(viewport.transform, item!.transform);
      // V1.0122: the old `|m0| > |m1|` only caught SIDEWAYS text — an
      // upside-down bake (rotation sign flip) still had |m0| dominant and
      // passed at every rotation. In canvas space (y down), genuinely upright
      // text composes to ~[s, 0, 0, -s]: baseline advancing RIGHT (m0 > 0,
      // m1 ≈ 0) with ascenders UP (m3 < 0). Assert all three signs so
      // sideways, upside-down and mirrored bakes each fail distinctly.
      const label = `rot ${rotation}: display matrix [${m.slice(0, 4).map((v) => v.toFixed(1)).join(", ")}]`;
      expect(m[0], `${label} — text advances leftward (upside-down)`).toBeGreaterThan(0);
      expect(Math.abs(m[1]), `${label} — text is sideways`).toBeLessThan(Math.abs(m[0]) / 10);
      expect(m[3], `${label} — text is vertically mirrored`).toBeLessThan(0);
    });
  }
});
