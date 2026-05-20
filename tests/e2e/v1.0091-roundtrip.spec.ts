// V1.0091 — PSD-level editability round-trip + image layer styles.
//
//   1. The V1.0090 image format options (rotation, opacity, flipH, flipV)
//      now round-trip on save+reopen (pre-V1.0091 they were silently
//      lost because the WeavePdfImageEdit schema didn't carry them).
//   2. New image "layer style" attributes — border and drop shadow —
//      both render live in the toolbar, bake into the PDF, and round-
//      trip through the v:2 metadata schema.
//   3. Acrobat-strip detection: every save stamps a `WeavePDFv2:` canary
//      into the PDF's /Keywords field. If a reopened file has the
//      canary but no WeavePDFEdits, we toast a "metadata was stripped"
//      warning.

import { test, expect } from "@playwright/test";
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { launchApp, openFixture, ensureFixturesExist } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

test("V1.0091 #1: image rotation + opacity round-trip on save+reopen", async () => {
  const { app, page } = await launchApp();
  const out = path.join(os.tmpdir(), `weavepdf-v1.0091-img-${Date.now()}.pdf`);
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    // Inject a pending image edit directly via the document store so
    // we don't depend on file-picker availability. Use a tiny 1×1 PNG
    // and set every V1.0090/V1.0091 image-format field.
    await page.evaluate(() => {
      const png = Uint8Array.from([
        0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,
        0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,0x08,0x06,0x00,0x00,0x00,0x1f,0x15,0xc4,
        0x89,0x00,0x00,0x00,0x0d,0x49,0x44,0x41,0x54,0x78,0x9c,0x63,0x00,0x01,0x00,0x00,
        0x05,0x00,0x01,0x0d,0x0a,0x2d,0xb4,0x00,0x00,0x00,0x00,0x49,0x45,0x4e,0x44,0xae,
        0x42,0x60,0x82,
      ]);
      const tab = window.__weavepdfTest__.getActiveTab();
      if (!tab) throw new Error("no tab");
      const addPendingImageEdit = window.__weavepdfTest__.addPendingImageEdit;
      if (!addPendingImageEdit) throw new Error("test hook addPendingImageEdit missing");
      addPendingImageEdit(tab.id, {
        page: 1, xPt: 100, yPt: 600, widthPt: 80, heightPt: 80,
        bytes: png, mime: "image/png",
        rotation: 45, opacity: 0.65, flipH: true, flipV: false,
        border: { widthPt: 2, color: { r: 0.05, g: 0.05, b: 0.1 } },
        dropShadow: { offsetXPt: 3, offsetYPt: -3, blurPt: 4, opacity: 0.4, color: { r: 0, g: 0, b: 0 } },
      });
    });

    // Save the file.
    const ok = await page.evaluate(
      (p: string) => window.__weavepdfTest__.saveActiveAs(p),
      out,
    );
    expect(ok).toBe(true);
    await expect.poll(() => existsSync(out), { timeout: 5_000 }).toBe(true);
    await app.close();
  } catch (err) {
    if (existsSync(out)) unlinkSync(out);
    await app.close();
    throw err;
  }

  // Relaunch + reopen the saved file. Verify the image overlay's
  // V1.0090 + V1.0091 fields survived the round-trip.
  const { app: app2, page: page2 } = await launchApp();
  try {
    await page2.evaluate(async (filePath: string) => {
      await window.__weavepdfTest__.openPdfByPath(filePath);
    }, out);
    await expect(page2.getByText(/^1\s*\/\s*5$/)).toBeVisible({ timeout: 10_000 });
    const restored = await page2.evaluate(() => {
      const tab = window.__weavepdfTest__.getActiveTab();
      if (!tab) return null;
      const getter = window.__weavepdfTest__.getPendingImages;
      if (!getter) return null;
      return getter(tab.id);
    });
    expect(Array.isArray(restored)).toBe(true);
    expect(restored).not.toBeNull();
    const arr = restored as Array<{ rotation?: number; opacity?: number; flipH?: boolean; border?: unknown; dropShadow?: unknown }>;
    expect(arr.length).toBeGreaterThan(0);
    const img = arr[0];
    expect(img.rotation).toBe(45);
    expect(img.opacity).toBeCloseTo(0.65, 2);
    expect(img.flipH).toBe(true);
    expect(img.border).toBeTruthy();
    expect(img.dropShadow).toBeTruthy();
  } finally {
    await app2.close();
    if (existsSync(out)) unlinkSync(out);
  }
});

test("V1.0091 #2: Acrobat-strip canary triggers warning toast", async () => {
  // Earlier variants of this spec called `page.keyboard.press("Enter")`
  // to commit a text overlay before saving — that hung at Press inside
  // Playwright's CDP handshake (the focused textarea unmounted under
  // the press as `commit()` ran `setTextPrompt(null)`, and Playwright
  // hung waiting for the in-flight keydown to confirm). This rewrite
  // bypasses the keyboard entirely by injecting a pending image via
  // the V1.0091 `addPendingImageEdit` test hook — same effect (gives
  // us metadata to strip) without the keyboard race.
  const { app, page } = await launchApp();
  const out = path.join(os.tmpdir(), `weavepdf-v1.0091-canary-${Date.now()}.pdf`);
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    // Inject a pending image so `commitAllPending` has something to
    // bake — that's what triggers `embedWeaveMetadata` (which stamps
    // the canary into /Keywords).
    await page.evaluate(() => {
      const png = Uint8Array.from([
        0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,
        0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,0x08,0x06,0x00,0x00,0x00,0x1f,0x15,0xc4,
        0x89,0x00,0x00,0x00,0x0d,0x49,0x44,0x41,0x54,0x78,0x9c,0x63,0x00,0x01,0x00,0x00,
        0x05,0x00,0x01,0x0d,0x0a,0x2d,0xb4,0x00,0x00,0x00,0x00,0x49,0x45,0x4e,0x44,0xae,
        0x42,0x60,0x82,
      ]);
      const tab = window.__weavepdfTest__.getActiveTab();
      if (!tab) throw new Error("no tab");
      const addEdit = window.__weavepdfTest__.addPendingImageEdit;
      if (!addEdit) throw new Error("test hook missing");
      addEdit(tab.id, {
        page: 1, xPt: 100, yPt: 600, widthPt: 40, heightPt: 40,
        bytes: png, mime: "image/png",
      });
    });

    const ok = await page.evaluate(
      (p: string) => window.__weavepdfTest__.saveActiveAs(p),
      out,
    );
    expect(ok).toBe(true);
    await expect.poll(() => existsSync(out), { timeout: 5_000 }).toBe(true);

    // Strip the WeavePDFEdits Info key but keep the /Keywords canary —
    // mimics Acrobat's "Optimize PDF".
    await page.evaluate(async (filePath: string) => {
      const strip = window.__weavepdfTest__.stripWeaveMetadataKeepingCanary;
      if (!strip) throw new Error("strip hook missing");
      await strip(filePath);
    }, out);

    // Let any "Restored N elements" toast from the prior open auto-
    // dismiss (4s timer in ToastHost) so the next toast isn't a
    // stale match.
    await page.waitForTimeout(4500);
    await expect(page.getByTestId("toast")).toBeHidden({ timeout: 2_000 });

    // Reopen the stripped file. Canary detection should fire.
    await page.evaluate(async (filePath: string) => {
      await window.__weavepdfTest__.openPdfByPath(filePath);
    }, out);

    const toast = page.getByTestId("toast");
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast).toContainText(/strip/i);
  } finally {
    await app.close();
    if (existsSync(out)) unlinkSync(out);
  }
});
