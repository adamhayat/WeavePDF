// V1.0097 covers two interaction regressions Adam hit on Dispute.pdf:
// 1. Image-only / scanned pages no longer block edit-click behind a native
//    "Run OCR?" confirmation.
// 2. Inserting a blank page uses an instant structural scroll, so the viewer
//    is settled before the next pointer gesture starts.

import { test, expect } from "@playwright/test";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { ensureFixturesExist, launchApp, openFixture } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

const onePixelPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

async function writeImageOnlyPdf(): Promise<string> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const image = await pdf.embedPng(Buffer.from(onePixelPngBase64, "base64"));
  page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  const outPath = path.join(os.tmpdir(), `weavepdf-v1.0097-image-only-${Date.now()}.pdf`);
  writeFileSync(outPath, Buffer.from(await pdf.save()));
  return outPath;
}

test("V1.0097: image-only edit-click starts OCR without a confirmation prompt", async () => {
  const pdfPath = await writeImageOnlyPdf();
  const { app, page } = await launchApp();
  try {
    await page.evaluate(async (filePath: string) => {
      await window.__weavepdfTest__.openPdfByPath(filePath);
    }, pdfPath);
    await expect(page.getByText("1 / 1")).toBeVisible({ timeout: 10_000 });

    await page.evaluate(() => {
      const w = window as unknown as { __weaveConfirmCalls: number };
      w.__weaveConfirmCalls = 0;
      window.confirm = (() => {
        w.__weaveConfirmCalls += 1;
        return false;
      }) as typeof window.confirm;
      window.alert = (() => {}) as typeof window.alert;
    });

    const pageCanvas = page.locator('[data-page="1"]').first();
    await expect(pageCanvas).toBeVisible({ timeout: 10_000 });
    const box = await pageCanvas.boundingBox();
    if (!box) throw new Error("page bbox missing");
    await page.mouse.click(box.x + 200, box.y + 200);

    await expect
      .poll(() =>
        page.evaluate(() => {
          const w = window as unknown as { __weaveConfirmCalls: number };
          return w.__weaveConfirmCalls;
        }),
      )
      .toBe(0);
  } finally {
    await app.close();
    if (existsSync(pdfPath)) unlinkSync(pdfPath);
  }
});

test("V1.0097: New page scroll settles instantly after the structural edit", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(100);

    await page.evaluate(() => {
      const w = window as unknown as {
        __weaveScrollCalls: Array<{ top?: number; behavior?: ScrollBehavior }>;
        __weaveScrollSpyInstalled?: boolean;
      };
      w.__weaveScrollCalls = [];
      if (!w.__weaveScrollSpyInstalled) {
        w.__weaveScrollSpyInstalled = true;
        HTMLElement.prototype.scrollTo = function scrollToSpy(
          this: HTMLElement,
          arg1?: ScrollToOptions | number,
          arg2?: number,
        ) {
          if (typeof arg1 === "object") {
            w.__weaveScrollCalls.push({ top: arg1.top, behavior: arg1.behavior });
            if (typeof arg1.top === "number") this.scrollTop = arg1.top;
            if (typeof arg1.left === "number") this.scrollLeft = arg1.left;
            return;
          }
          if (typeof arg1 === "number") {
            this.scrollLeft = arg1;
            this.scrollTop = arg2 ?? 0;
          }
        };
      }
    });

    await page.getByTestId("sidebar-new-page").click();
    await expect(page.getByText(/\d+\s*\/\s*6/i)).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(() =>
        page.evaluate(() => {
          const w = window as unknown as {
            __weaveScrollCalls: Array<{ top?: number; behavior?: ScrollBehavior }>;
          };
          return w.__weaveScrollCalls.some((call) => call.behavior === "auto");
        }),
      )
      .toBe(true);
  } finally {
    await app.close();
  }
});
