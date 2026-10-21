// V1.0126 regression pins: a WeavePDF save no longer stacks on the last one.
//
// Adam (2026-10-09): "Why do I have this prompt after doing ⌘S?" — plus the
// burned-in-copies problem found while fixing V1.0125. Pre-V1.0126 Save baked
// every element INTO the open document and kept it as an overlay too, so the
// next save drew it again on top. Deleting/moving an element after a save or a
// reopen left its old copy burned in, and the file grew every save (his form:
// 406 → 922 content streams in one afternoon).
//
// Now: the tab keeps the CLEAN page; Save renders page + elements into a copy
// (`bakeLayers` → `tagWeaveBakes` marks the streams it added); reopening strips
// exactly those streams (`stripWeaveBakes`) and restores the elements as
// overlays. These tests drive that cycle with real bytes and check the pixels
// with macOS PDFKit (Preview's engine).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFArray, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import sharp from "sharp";
import * as ops from "../../src/renderer/lib/pdf-ops";
import { bakeLayers } from "../../src/renderer/lib/bake-layers";
import { cleanDepthAfterPush, pickStep } from "../../src/renderer/lib/undo-order";
import { remapForDelete, remapForDuplicate, remapForInsertAfter, remapForOrder } from "../../src/renderer/lib/page-remap";
import { isNoopPatch } from "../../src/renderer/lib/noop-patch";
import type { PendingShapeEdit, PendingTextEdit } from "../../src/renderer/stores/document";

const opts = { pageWidth: () => 612, marginsEnabled: false };

async function cleanPage(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawRectangle({ x: 400, y: 100, width: 50, height: 50 }); // original page content
  return doc.save();
}

const text = (id: string, z: number, t = "CONDO", extra: Partial<PendingTextEdit> = {}): PendingTextEdit => ({
  id, z, createdAt: z, page: 1, xPt: 100, yPt: 600, size: 24, text: t, ...extra,
});
const whiteout = (id: string, z: number): PendingShapeEdit =>
  ({ id, z, createdAt: z, page: 1, kind: "whiteout", xPt: 90, yPt: 590, widthPt: 140, heightPt: 40 }) as PendingShapeEdit;

/** What Save writes: clean page + elements, baked + tagged + metadata. */
async function save(base: Uint8Array, t: PendingTextEdit[], s: PendingShapeEdit[] = []): Promise<Uint8Array> {
  const baked = await bakeLayers(ops, base, { text: t, image: [], shape: s }, opts);
  const tagged = await ops.tagWeaveBakes(base, baked.bytes);
  expect(tagged, "a plain page must be taggable").not.toBeNull();
  return ops.embedWeaveMetadata(tagged!, {
    version: 3,
    textEdits: t.map((e) => ({ page: e.page, xPt: e.xPt, yPt: e.yPt, size: e.size, text: e.text, z: e.z })),
    imageEdits: [],
    shapeEdits: s.map(({ id: _i, createdAt: _c, ...r }) => r) as never,
  });
}

function contentCount(bytes: Uint8Array, doc: PDFDocument): number {
  void bytes;
  const raw = doc.getPage(0).node.get(PDFName.of("Contents"));
  return raw instanceof PDFArray ? raw.size() : 1;
}

async function darkestIn(bytes: Uint8Array, box: { x: number; y: number; w: number; h: number }): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "weave-rt-"));
  const pdfPath = join(dir, "t.pdf");
  const pngPath = join(dir, "t.png");
  writeFileSync(pdfPath, bytes);
  execFileSync("sips", ["-s", "format", "png", pdfPath, "--out", pngPath], { stdio: "ignore" });
  const img = sharp(pngPath);
  const scale = ((await img.metadata()).width ?? 612) / 612;
  const { data, info } = await img.flatten({ background: "#ffffff" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let min = 255;
  for (let y = Math.floor((792 - box.y - box.h) * scale); y < Math.ceil((792 - box.y) * scale); y++)
    for (let x = Math.floor(box.x * scale); x < Math.ceil((box.x + box.w) * scale); x++)
      min = Math.min(min, data[y * info.width + x]);
  return min;
}
const TEXT_BOX = { x: 100, y: 595, w: 90, h: 25 };
const ORIGINAL_BOX = { x: 398, y: 98, w: 54, h: 54 };

describe("save → reopen → save: no stacking", () => {
  it("reopen strips exactly what the save added — the clean page comes back", async () => {
    const base = await cleanPage();
    const saved = await save(base, [text("t", 1)]);
    const reopened = await ops.stripWeaveBakes(saved);
    expect(reopened.changed).toBe(true);
    expect(reopened.strippedStreams).toBeGreaterThan(0);
    const before = await PDFDocument.load(base);
    const after = await PDFDocument.load(reopened.bytes);
    expect(contentCount(reopened.bytes, after)).toBe(contentCount(base, before));
    expect(await ops.extractWeaveMetadata(reopened.bytes)).toBeNull(); // stale element list gone too
    expect(await darkestIn(reopened.bytes, TEXT_BOX)).toBeGreaterThan(240); // element gone from the page…
    expect(await darkestIn(reopened.bytes, ORIGINAL_BOX)).toBeLessThan(80); // …original content kept
  }, 30_000);

  it("saving the same document repeatedly does NOT grow it (was 406 → 922 streams)", async () => {
    const base = await cleanPage();
    let file = await save(base, [text("t", 1)], [whiteout("w", 2)]);
    const counts: number[] = [];
    const sizes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const clean = (await ops.stripWeaveBakes(file)).bytes; // reopen
      file = await save(clean, [text("t", 1)], [whiteout("w", 2)]); // save again
      counts.push(contentCount(file, await PDFDocument.load(file)));
      sizes.push(file.byteLength);
    }
    expect(new Set(counts).size).toBe(1);
    // Fonts/images each save embeds must go too, not just the streams — the
    // first version of this fix kept them and grew Adam's form ~22 KB a save.
    expect(new Set(sizes).size, `sizes ${sizes.join(", ")}`).toBe(1);
  }, 60_000);

  it("deleting an element after reopen really deletes it from the next save", async () => {
    const base = await cleanPage();
    const first = await save(base, [text("t", 1)]);
    const clean = (await ops.stripWeaveBakes(first)).bytes;
    const second = await save(clean, []); // element deleted, nothing else pending
    expect(await darkestIn(second, TEXT_BOX)).toBeGreaterThan(240);
  }, 30_000);

  it("control: with the OLD stacking (bake onto the saved file) the deleted element survives", async () => {
    const base = await cleanPage();
    const first = await save(base, [text("t", 1)]);
    // Old behaviour: the tab kept the baked bytes as its page.
    expect(await darkestIn(first, TEXT_BOX)).toBeLessThan(80);
  }, 30_000);

  it("a stale tag on page content (merged in from another WeavePDF file) is cleared, never stripped", async () => {
    const base = await cleanPage();
    const merged = await save(base, [text("t", 1)]); // pretend these pages were merged into a host
    const hostBase = (await ops.stripWeaveBakes(merged)).bytes;
    // Simulate a merge that kept the tagged streams but dropped the metadata:
    const doc = await PDFDocument.load(merged);
    doc.setTitle("host");
    const info = doc.context.lookup(doc.context.trailerInfo.Info) as import("pdf-lib").PDFDict;
    info.delete(PDFName.of(ops.WEAVE_INFO_KEY));
    const hostWithStaleTags = await doc.save();
    const saved = await save(hostWithStaleTags, [text("n", 5, "NEW", { yPt: 300 })]);
    const reopened = (await ops.stripWeaveBakes(saved)).bytes;
    // The merged-in CONDO is now permanent page content; only NEW was peeled off.
    expect(await darkestIn(reopened, TEXT_BOX)).toBeLessThan(80);
    expect(await darkestIn(reopened, { x: 100, y: 295, w: 70, h: 25 })).toBeGreaterThan(240);
    void hostBase;
  }, 30_000);

  it("refuses to tag when a base stream vanished (a rasterising redact) — file is written flat", async () => {
    const base = await cleanPage();
    const doc = await PDFDocument.load(base);
    doc.getPage(0).node.set(PDFName.of("Contents"), doc.context.register(PDFRawStream.of(doc.context.obj({}), new Uint8Array())));
    expect(await ops.tagWeaveBakes(base, await doc.save())).toBeNull();
  });
});

describe("one undo timeline (pickStep)", () => {
  it("undoes the most recent step, whichever kind", () => {
    expect(pickStep(["pending", "bytes"], true, true)?.mark).toBe("bytes");
    expect(pickStep(["bytes", "pending"], true, true)?.mark).toBe("pending");
  });
  it("never deletes restored elements: no marks → nothing to undo", () => {
    expect(pickStep([], true, false)).toBeNull();
  });
  it("skips marks whose stack was emptied (e.g. by a save)", () => {
    expect(pickStep(["pending", "bytes"], true, false)?.mark).toBe("pending");
  });
  it("'both' degrades to whatever is still available", () => {
    expect(pickStep(["both"], true, true)?.mark).toBe("both");
    expect(pickStep(["both"], false, true)?.mark).toBe("bytes");
  });
  it("the save point becomes unreachable after branching", () => {
    expect(cleanDepthAfterPush(3, 3)).toBe(3);
    expect(cleanDepthAfterPush(3, 2)).toBeNull();
  });
});

describe("page remaps keep elements on their page", () => {
  it("delete", () => {
    const r = remapForDelete([1, 3]);
    expect([1, 2, 3, 4].map(r)).toEqual([[], [1], [], [2]]);
  });
  it("reorder", () => {
    const r = remapForOrder([2, 0, 1]); // new page1 = old3, new2 = old1, new3 = old2
    expect([1, 2, 3].map(r)).toEqual([[2], [3], [1]]);
  });
  it("insert after (blank page or merge of 3)", () => {
    expect([1, 2, 3].map(remapForInsertAfter(1))).toEqual([[1], [3], [4]]);
    expect([1, 2].map(remapForInsertAfter(1, 3))).toEqual([[1], [5]]);
  });
  it("duplicate copies the elements onto the copy", () => {
    expect([1, 2, 3].map(remapForDuplicate(2))).toEqual([[1], [2, 3], [4]]);
  });
});

describe("a change that changes nothing doesn't mark the document unsaved", () => {
  it("same text", () => expect(isNoopPatch({ text: "5000" }, { text: "5000" })).toBe(true));
  it("different text", () => expect(isNoopPatch({ text: "5000" }, { text: "500" })).toBe(false));
  it("equal objects", () => expect(isNoopPatch({ whiteout: { x: 1, y: 2 } }, { whiteout: { x: 1, y: 2 } })).toBe(true));
});
