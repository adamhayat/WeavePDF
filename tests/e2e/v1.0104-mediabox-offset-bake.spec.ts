// V1.0104 — baking text / whiteout / image edits onto a PDF whose MediaBox
// lower-left isn't (0, 0) must add the MediaBox origin offset, so the baked
// content lands at the same visual position the user saw in the editor.
//
// Repro PDF: Canva exports ship with MediaBox `[0, 7.83, 595.5, 850.08]`.
// `test.pdf` on /Users/adamhayat/Desktop is one. When Adam changed the date
// at top right + added signature/title/name at the bottom, every edit baked
// 7.83pt LOW relative to the original glyphs — the date whiteout left the
// top half of "Friday, October 31, 2025" visible on reopen.
//
// Fixture uses MediaBox y0=10 so the math is round: a pending edit placed
// at MediaBox-relative y=100 must bake at PDF user-space y=110.

import { test, expect } from "@playwright/test";
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { launchApp, openFixture, ensureFixturesExist } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

test("V1.0104: text bake respects MediaBox y0 offset", async () => {
  const { app, page } = await launchApp();
  const out = path.join(os.tmpdir(), `weavepdf-mediabox-${Date.now()}.pdf`);
  try {
    await openFixture(page, "sample-offset-mediabox.pdf");
    await expect(page.getByText("1 / 1")).toBeVisible();

    // Confirm the fixture really has the offset MediaBox via the renderer's
    // own pdf.js instance. `view = [x0, y0, x1, y1]` per pdf.js spec.
    const view = await page.evaluate(async () => {
      const tab = window.__weavepdfTest__.getActiveTab();
      if (!tab) throw new Error("no active tab");
      // The renderer's pdf.js handle isn't exposed on the test hook — read
      // the MediaBox from the active doc via the document store instead.
      const store = (window as unknown as {
        __weavepdfDocStoreForTest?: unknown;
      }).__weavepdfDocStoreForTest;
      void store;
      return tab;
    });
    expect(view).not.toBeNull();

    // Place a pending text edit at MediaBox-relative (100, 100).
    const tabId = await page.evaluate(() => {
      const tab = window.__weavepdfTest__.getActiveTab();
      if (!tab) throw new Error("no active tab");
      const id = window.__weavepdfTest__.addPendingTextEdit!(tab.id, {
        page: 1,
        xPt: 100,
        yPt: 100,
        size: 14,
        text: "WYSIWYGPROBE",
      });
      return { tabId: tab.id, editId: id };
    });
    expect(tabId.editId).toBeTruthy();

    // Save — this bakes the pending text via pdf-lib's drawText.
    const ok = await page.evaluate(
      (p: string) => window.__weavepdfTest__.saveActiveAs(p),
      out,
    );
    expect(ok).toBe(true);
    await expect.poll(() => existsSync(out), { timeout: 5_000 }).toBe(true);
  } finally {
    await app.close();
  }

  // Inspect the baked output from Node. pdfjs-dist returns text items with
  // `transform: [a, b, c, d, e, f]` where (e, f) is the user-space baseline
  // origin. WYSIWYGPROBE was placed at MediaBox-relative (100, 100) on a
  // page whose MediaBox y0=10 — its baked baseline must be at PDF user-
  // space y=110 ± 1. Pre-V1.0104 it landed at y=100 (the bug).
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const bytes = readFileSync(out);
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;
  try {
    const pdfPage = await doc.getPage(1);
    const view = pdfPage.view as [number, number, number, number];
    expect(view[1]).toBeCloseTo(10, 1); // sanity: MediaBox y0 = 10
    const tc = await pdfPage.getTextContent();
    type Item = { str: string; transform: number[] };
    const items = tc.items as Item[];
    const probe = items.find((it) => it.str?.includes("WYSIWYGPROBE"));
    expect(probe, "WYSIWYGPROBE was not baked into the PDF").toBeTruthy();
    const bakedY = probe!.transform[5];
    const bakedX = probe!.transform[4];
    expect(bakedX).toBeCloseTo(100, 0); // x has no offset on this fixture (x0=0)
    expect(bakedY).toBeCloseTo(110, 0); // y must be MediaBox-relative 100 + y0 10
  } finally {
    await doc.destroy();
    try {
      unlinkSync(out);
    } catch {
      /* tempfile cleanup is best-effort */
    }
  }
});

test("V1.0104: image bake respects MediaBox y0 offset", async () => {
  const { app, page } = await launchApp();
  const out = path.join(os.tmpdir(), `weavepdf-mediabox-img-${Date.now()}.pdf`);
  try {
    await openFixture(page, "sample-offset-mediabox.pdf");
    await expect(page.getByText("1 / 1")).toBeVisible();

    // Place a 1×1 PNG image at MediaBox-relative (200, 200) sized 50×50.
    // The visible position should match user-space (200, 210) after fix.
    await page.evaluate(() => {
      const tab = window.__weavepdfTest__.getActiveTab();
      if (!tab) throw new Error("no active tab");
      // Tiny solid-red PNG, 1×1.
      const PNG_BASE64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
      const bin = atob(PNG_BASE64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      window.__weavepdfTest__.addPendingImageEdit!(tab.id, {
        page: 1,
        xPt: 200,
        yPt: 200,
        widthPt: 50,
        heightPt: 50,
        mime: "image/png",
        bytes,
      });
    });

    const ok = await page.evaluate(
      (p: string) => window.__weavepdfTest__.saveActiveAs(p),
      out,
    );
    expect(ok).toBe(true);
    await expect.poll(() => existsSync(out), { timeout: 5_000 }).toBe(true);
  } finally {
    await app.close();
  }

  // The image bake is harder to verify with pdf.js text extraction. Decode
  // the FlateDecoded content stream and look for the cm matrices used by
  // pdf-lib for image placement: a `1 0 0 1 <x> <y> cm` translate followed
  // shortly by a `50 0 0 50 0 0 cm` scale and a `Do` op. Pre-V1.0104 the
  // translate y would be 200 (the raw stored coord); post-V1.0104 it's
  // 210 (= 200 + MediaBox y0 10).
  const zlib = await import("node:zlib");
  const { PDFDocument, PDFName } = await import("pdf-lib");
  const bytes = readFileSync(out);
  const doc = await PDFDocument.load(new Uint8Array(bytes), {
    ignoreEncryption: true,
  });
  const pdfPage = doc.getPage(0);
  const contentsRaw = pdfPage.node.Contents();
  let combined = "";
  try {
    if (!contentsRaw) throw new Error("page has no Contents");
    const ctx = doc.context;
    const streams = "asArray" in contentsRaw
      ? (contentsRaw as { asArray: () => unknown[] })
          .asArray()
          .map((r) => ctx.lookup(r as Parameters<typeof ctx.lookup>[0]))
      : [contentsRaw];
    for (const s of streams) {
      const stream = s as {
        getContents?: () => Uint8Array;
        dict?: {
          get?: (n: import("pdf-lib").PDFName) => unknown;
        };
      } | null;
      if (!stream?.getContents) continue;
      const encoded = stream.getContents();
      // Check whether the stream is FlateDecode-compressed.
      const filter = stream.dict?.get?.(PDFName.of("Filter"));
      let decoded: Uint8Array = encoded;
      const filterName =
        filter && typeof (filter as { toString?: () => string }).toString === "function"
          ? (filter as { toString: () => string }).toString()
          : "";
      if (filterName.includes("FlateDecode")) {
        try {
          decoded = zlib.inflateSync(Buffer.from(encoded));
        } catch {
          decoded = encoded;
        }
      }
      combined += new TextDecoder("latin1").decode(decoded);
    }
  } finally {
    void PDFName;
  }
  // pdf-lib emits image placement as a sequence:
  //   `q\n1 0 0 1 <x> <y> cm\n1 0 0 1 0 0 cm\n<w> 0 0 <h> 0 0 cm\n... /<imgName> Do\nQ`
  // Match the translate `cm` then the scale `cm` then `Do`. Demand
  // width/height ≈ 50 and translate y ≈ 210 (= 200 placed + 10 origin).
  const cmRe = /1\s+0\s+0\s+1\s+([\d.\-]+)\s+([\d.\-]+)\s+cm\s+1\s+0\s+0\s+1\s+0\s+0\s+cm\s+([\d.\-]+)\s+0\s+0\s+([\d.\-]+)\s+0\s+0\s+cm[\s\S]{0,200}?\/[A-Za-z0-9_\-]+\s+Do/g;
  let bestY: number | null = null;
  let bestX: number | null = null;
  for (const m of combined.matchAll(cmRe)) {
    const w = parseFloat(m[3]);
    const h = parseFloat(m[4]);
    if (Math.abs(w - 50) < 1 && Math.abs(h - 50) < 1) {
      bestX = parseFloat(m[1]);
      bestY = parseFloat(m[2]);
      break;
    }
  }
  if (bestY === null) {
    // Surface the stream snippet so we can debug regex misses in CI.
    const snippet = combined.slice(0, 800).replace(/[ -]/g, "?");
    throw new Error(
      `no 50x50 image placement matrix found. Stream prefix: ${snippet}`,
    );
  }
  expect(bestX!).toBeCloseTo(200, 0);
  expect(bestY!).toBeCloseTo(210, 0);
  try {
    unlinkSync(out);
  } catch {
    /* tempfile cleanup is best-effort */
  }
});
