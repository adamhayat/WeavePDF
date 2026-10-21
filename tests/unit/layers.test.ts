// V1.0125 regression pins: ONE stacking order for the screen and the saved file.
//
// Adam (2026-10-09): whited out "Condo / 485,000 / 2026/10/08" on a Scotiabank
// form; WeavePDF showed white, Preview showed the text. Root cause: the viewer
// painted text → images → shapes (DOM order, all z-20) while the bake drew
// shapes → images → text — so a whiteout covered text on screen and the saved
// file drew the text back on top. Same root cause made "I can't add anything
// over a whiteout": new text was created but painted UNDER the whiteout.
//
// The bake test renders with macOS `sips` (PDFKit — the engine Preview uses)
// and reads pixels with sharp, so it checks what Preview will actually show.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import * as ops from "../../src/renderer/lib/pdf-ops";
import { bakeLayers } from "../../src/renderer/lib/bake-layers";
import {
  availableLayerMoves,
  buriedIds,
  computeLayerMove,
  layerRanks,
  orderLayers,
  restoreZ,
} from "../../src/renderer/lib/layers";
import type { PendingShapeEdit, PendingTextEdit } from "../../src/renderer/stores/document";

const text = (id: string, z: number, extra: Partial<PendingTextEdit> = {}): PendingTextEdit => ({
  id, z, createdAt: z, page: 1, xPt: 100, yPt: 600, size: 24, text: "CONDO", ...extra,
});
const whiteout = (id: string, z: number, extra: Partial<PendingShapeEdit> = {}): PendingShapeEdit => ({
  id, z, createdAt: z, page: 1, kind: "whiteout", xPt: 90, yPt: 590, widthPt: 140, heightPt: 40, ...extra,
} as PendingShapeEdit);

describe("orderLayers: one order for paint AND bake", () => {
  it("a whiteout drawn AFTER a text box sits above it", () => {
    const order = orderLayers({ text: [text("t", 1)], image: [], shape: [whiteout("w", 2)] }, 1);
    expect(order.map((e) => e.edit.id)).toEqual(["t", "w"]);
  });
  it("text typed AFTER a whiteout sits above it (the 'can't add anything over it' bug)", () => {
    const order = orderLayers({ text: [text("t", 5)], image: [], shape: [whiteout("w", 2)] }, 1);
    expect(order.map((e) => e.edit.id)).toEqual(["w", "t"]);
  });
  it("legacy ties fall back to the old bake order: shape < image < text", () => {
    const img = { id: "i", page: 1 };
    const order = orderLayers({ text: [{ id: "t", page: 1 }], image: [img], shape: [{ id: "s", page: 1 }] }, 1);
    expect(order.map((e) => e.edit.id)).toEqual(["s", "i", "t"]);
  });
  it("ranks are per page", () => {
    const r = layerRanks({ text: [text("t", 9), text("t2", 1, { page: 2 })], image: [], shape: [whiteout("w", 3)] }, 1);
    expect([...r.entries()]).toEqual([["w", 1], ["t", 2]]);
  });
});

describe("Arrange: computeLayerMove", () => {
  const arrays = () => ({ text: [text("a", 1), text("c", 3)], image: [], shape: [whiteout("b", 2)] });
  const after = (op: Parameters<typeof computeLayerMove>[2], id: string) => {
    const a = arrays();
    const patches = computeLayerMove(a, id, op, 100);
    const apply = <T extends { id: string; z?: number }>(l: T[]) => l.map((e) => (patches.has(e.id) ? { ...e, z: patches.get(e.id) } : e));
    return orderLayers({ text: apply(a.text), image: [], shape: apply(a.shape) }, 1).map((e) => e.edit.id);
  };
  it("Bring to Front", () => expect(after("front", "a")).toEqual(["b", "c", "a"]));
  it("Send to Back", () => expect(after("back", "c")).toEqual(["c", "a", "b"]));
  it("Bring Forward swaps with the one above", () => expect(after("forward", "a")).toEqual(["b", "a", "c"]));
  it("Send Backward swaps with the one below", () => expect(after("backward", "c")).toEqual(["a", "c", "b"]));
  it("no-op at the ends", () => {
    expect(computeLayerMove(arrays(), "c", "front", 100).size).toBe(0);
    expect(computeLayerMove(arrays(), "a", "back", 100).size).toBe(0);
    expect(availableLayerMoves(arrays(), "c")).toEqual({ up: false, down: true });
    expect(availableLayerMoves(arrays(), "a")).toEqual({ up: true, down: false });
  });
  it("forward works even with legacy tied z values", () => {
    const a = { text: [{ id: "t", page: 1 }], image: [], shape: [{ id: "s", page: 1 }] };
    const p = computeLayerMove(a, "s", "forward", 100);
    const z = (id: string) => p.get(id)!;
    expect(z("s")).toBeGreaterThan(z("t"));
  });
});

describe("restoreZ: reopening reproduces what the file shows", () => {
  it("pre-V1.0125 files (no z) restore in their old bake order shapes → images → text", () => {
    const zs = restoreZ({ text: [{}, {}], image: [{}], shape: [{}, {}] });
    expect(zs).toEqual({ shape: [1, 2], image: [3], text: [4, 5] });
  });
  it("V1.0125 files restore their saved order exactly", () => {
    const zs = restoreZ({ text: [{ z: 10 }], image: [], shape: [{ z: 20 }, { z: 5 }] });
    expect(zs).toEqual({ text: [2], image: [], shape: [3, 1] });
  });
  it("Adam's real Scotiabank metadata (no z): every text box restores ABOVE the whiteouts — which is what Preview shows", () => {
    const pdf = readFileSync(join(__dirname, "fixtures-layers-scotia-meta.json"), "utf8");
    const meta = JSON.parse(pdf) as { textEdits: unknown[]; imageEdits: unknown[]; shapeEdits: unknown[] };
    const zs = restoreZ({ text: meta.textEdits as [], image: meta.imageEdits as [], shape: meta.shapeEdits as [] });
    expect(Math.min(...zs.text)).toBeGreaterThan(Math.max(...zs.shape));
  });
});

describe("buriedIds: what you can't see, you can't click", () => {
  it("text under a later whiteout is buried", () => {
    expect([...buriedIds({ text: [text("t", 1)], image: [], shape: [whiteout("w", 2)] }, 1)]).toEqual(["t"]);
  });
  it("text above the whiteout is not", () => {
    expect(buriedIds({ text: [text("t", 3)], image: [], shape: [whiteout("w", 2)] }, 1).size).toBe(0);
  });
  it("a small whiteout that only nicks a corner doesn't bury", () => {
    const tiny = whiteout("w", 2, { xPt: 95, yPt: 590, widthPt: 10, heightPt: 10 });
    expect(buriedIds({ text: [text("t", 1)], image: [], shape: [tiny] }, 1).size).toBe(0);
  });
  it("a rectangle OUTLINE does not bury (it isn't opaque)", () => {
    const rect = { ...whiteout("r", 2), kind: "rect", color: { r: 0, g: 0, b: 0 }, thickness: 1 } as PendingShapeEdit;
    expect(buriedIds({ text: [text("t", 1)], image: [], shape: [rect] }, 1).size).toBe(0);
  });
});

// ─── The real bake, rendered by PDFKit (Preview's engine) ──────────────────

async function blankPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
}

/** Darkest pixel (0-255 luminance) inside a PDF-space box, as Preview renders it. */
async function darkestIn(bytes: Uint8Array, box: { x: number; y: number; w: number; h: number }): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "weave-layers-"));
  const pdfPath = join(dir, "t.pdf");
  const pngPath = join(dir, "t.png");
  writeFileSync(pdfPath, bytes);
  execFileSync("sips", ["-s", "format", "png", pdfPath, "--out", pngPath], { stdio: "ignore" });
  const img = sharp(pngPath);
  const meta = await img.metadata();
  const scale = (meta.width ?? 612) / 612;
  const { data, info } = await img.flatten({ background: "#ffffff" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let min = 255;
  const x0 = Math.floor(box.x * scale);
  const x1 = Math.ceil((box.x + box.w) * scale);
  const y0 = Math.floor((792 - box.y - box.h) * scale);
  const y1 = Math.ceil((792 - box.y) * scale);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) min = Math.min(min, data[y * info.width + x]);
  return min;
}

const TEXT_BOX = { x: 100, y: 595, w: 90, h: 25 };
const bakeOpts = { pageWidth: () => 612, marginsEnabled: false };

describe("bakeLayers: the saved file matches the screen (rendered by PDFKit)", () => {
  it("text whited out AFTER it was typed is GONE in the saved file (Adam's bug)", async () => {
    const { bytes } = await bakeLayers(ops, await blankPdf(), { text: [text("t", 1)], image: [], shape: [whiteout("w", 2)] }, bakeOpts);
    expect(await darkestIn(bytes, TEXT_BOX)).toBeGreaterThan(240);
  }, 30_000);

  it("text typed AFTER a whiteout is VISIBLE on top of it", async () => {
    const { bytes } = await bakeLayers(ops, await blankPdf(), { text: [text("t", 3)], image: [], shape: [whiteout("w", 2)] }, bakeOpts);
    expect(await darkestIn(bytes, TEXT_BOX)).toBeLessThan(80);
  }, 30_000);

  it("control: the text really is dark where we look (so 'white' above is meaningful)", async () => {
    const { bytes } = await bakeLayers(ops, await blankPdf(), { text: [text("t", 1)], image: [], shape: [] }, bakeOpts);
    expect(await darkestIn(bytes, TEXT_BOX)).toBeLessThan(80);
  }, 30_000);
});

// ─── Viewer wiring pins (the screen half) ──────────────────────────────────
// The viewer can't be rendered here without launching the app, so pin the
// wiring that makes it use the same order: one shared stacking context, every
// element's z-index = its layer rank, Arrange in every right-click menu, and
// no element left on the old flat `z-20` (which let DOM order decide).
describe("viewer uses the shared layer order", () => {
  const src = (f: string) => readFileSync(join(__dirname, "../../src/renderer/components/Viewer", f), "utf8");
  it("PageCanvas puts text, image and shape layers in ONE stacking context", () => {
    const pc = src("PageCanvas.tsx");
    const stack = pc.slice(pc.indexOf('data-testid="pending-layer-stack"'));
    const end = stack.indexOf("</div>");
    for (const layer of ["<PendingTextLayer", "<PendingImageLayer", "<PendingShapeLayer"]) {
      const at = stack.indexOf(layer);
      expect(at, `${layer} must be inside pending-layer-stack`).toBeGreaterThan(-1);
      expect(at).toBeLessThan(end);
    }
  });
  for (const f of ["PendingTextLayer.tsx", "PendingImageLayer.tsx", "PendingShapeLayer.tsx"]) {
    it(`${f}: z-index comes from the layer rank, Arrange is in the menu`, () => {
      const s = src(f);
      expect(s).toContain("zIndex: layer");
      expect(s).toContain("arrangeMenuItems(");
      expect(s).toContain("usePageBuried(");
      expect(s).not.toMatch(/className="absolute z-20/);
      expect(s).not.toContain("z-[19]");
    });
  }
  it("every shape kind has a right-click menu (line/freehand/sticky had none)", () => {
    const s = src("PendingShapeLayer.tsx");
    expect(s.match(/onContextMenu=/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
});
