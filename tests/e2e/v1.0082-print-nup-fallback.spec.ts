// V1.0082 / V1.0083 — N-up print preview must survive PDFs that break
// pdf-lib's `embedPdf` resolver. Adam: "Printing multiple sheets per
// page doesnt seem to work or at least the preview." Preview banner:
// "Expected instance of t, but got instance of undefined" — a minified
// pdf-lib instanceof check inside the content-stream resolver. V1.0082
// added a fallback but its try/catch only wrapped `embedPdf` itself;
// pdf-lib defers stream resolution to `save()` so the throw escaped.
// V1.0083 wraps the entire vector pipeline (load → embed → draw →
// save) and falls back to pdf.js rasterization if anything throws.
//
// Two specs:
//   1. Happy path: 2-up on the clean sample fixture renders without an
//      error banner via the vector path.
//   2. Forced raster: with `__weavepdfTest__.forceRasterNUp = true`,
//      the same 2-up render uses the pdf.js → PNG → embedPng path and
//      still produces a working preview. This is what protects Adam's
//      certificate-of-insurance PDF (and every other PDF that trips
//      pdf-lib's resolver), without needing to ship a curated bad
//      fixture.

import { test, expect } from "@playwright/test";
import { launchApp, openFixture, ensureFixturesExist } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

async function openPrintModalWithTwoUp(page: import("@playwright/test").Page) {
  await page.keyboard.press("Meta+K");
  await page.waitForTimeout(150);
  await page.keyboard.type("print");
  await page.waitForTimeout(200);
  // Click the matched entry directly — ⌘K's filter order isn't stable
  // enough for keyboard-Enter to land on the right row.
  await page.getByText(/^Print…$/).first().click();
  const modal = page.getByTestId("print-preview-modal");
  await expect(modal).toBeVisible({ timeout: 5_000 });

  // Find the "pages per sheet" select by option text — index isn't
  // stable across printer enumeration differences.
  const allSelects = await modal.locator("select").all();
  let layoutEl: import("@playwright/test").Locator | null = null;
  for (const s of allSelects) {
    const text = await s.innerText();
    if (text.includes("pages per sheet")) {
      layoutEl = s;
      break;
    }
  }
  expect(layoutEl).not.toBeNull();
  if (!layoutEl) throw new Error("layout select not found");
  await layoutEl.selectOption({ value: "2" });
  return modal;
}

test("V1.0082: 2-up preview renders via the vector path on a clean PDF", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    const modal = await openPrintModalWithTwoUp(page);
    await expect(modal.getByText(/Preview error/i)).toBeHidden({ timeout: 10_000 });
    await expect(modal.getByTestId("print-preview-pane").locator("canvas")).toBeVisible({ timeout: 10_000 });
  } finally {
    await app.close();
  }
});

test("V1.0083: forced raster fallback still produces a working 2-up preview", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    // Flip the test hook BEFORE opening the modal so the first preview
    // rebuild already takes the raster branch. This is the exact path
    // Adam's broken cert PDF triggers in production.
    await page.evaluate(() => {
      window.__weavepdfTest__.forceRasterNUp = true;
    });

    const modal = await openPrintModalWithTwoUp(page);
    await expect(modal.getByText(/Preview error/i)).toBeHidden({ timeout: 15_000 });
    await expect(modal.getByTestId("print-preview-pane").locator("canvas")).toBeVisible({ timeout: 15_000 });
  } finally {
    await app.close();
  }
});
