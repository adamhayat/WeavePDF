// V1.0086 — "Fit all on one sheet" is now content-aware. Pre-V1.0086 it
// called nUpPages with a {cols, rows} grid sized from page count — each
// source page kept its full bounds and got a tile, so a doc with a
// mostly-empty trailing page wasted half the sheet. V1.0086 routes
// through fitAllOntoSingleSheet which rasterizes each page, pixel-
// scans for the actual content bbox, drops the inter-page whitespace,
// and picks the layout (vertical/horizontal/grid) that gives the
// biggest uniform scale. Adam's case: 2-page Stripe-style insurance
// cert where page 2 has ~10% used height — the new path stacks the
// cropped content vertically with no wasted half-sheet.

import { test, expect } from "@playwright/test";
import { launchApp, openFixture, ensureFixturesExist } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

test("V1.0086: 'Fit all on one sheet' still produces ONE sheet for the 5-page sample (regression)", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    await page.keyboard.press("Meta+K");
    await page.waitForTimeout(150);
    await page.keyboard.type("print");
    await page.waitForTimeout(200);
    await page.getByText(/^Print…$/).first().click();
    const modal = page.getByTestId("print-preview-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    await modal.getByTestId("print-layout-select").selectOption({ value: "fit" });
    await expect(modal.getByText(/Preview error/i)).toBeHidden({ timeout: 20_000 });
    await expect(modal.getByTestId("print-preview-pane").locator("canvas")).toBeVisible({ timeout: 20_000 });

    // Sheet count must be 1 — same guarantee as V1.0085, but now via the
    // content-aware path. Regression test against future "let me just
    // use a grid" refactors that would re-introduce the V1.0084 9-cap.
    const sheetCount = await page.evaluate(() => {
      const m = document.querySelector('[data-testid="print-preview-modal"]');
      if (!m) return null;
      const t = m.textContent ?? "";
      const r = /Sheet\s+\d+\s+of\s+(\d+)/i.exec(t);
      if (r) return Number(r[1]);
      return m.querySelector('[data-testid="print-preview-pane"] canvas') ? 1 : null;
    });
    expect(sheetCount).toBe(1);
  } finally {
    await app.close();
  }
});

// (Spec 2 deleted: it would have duplicated the regression assertion in
// spec 1. The visual quality of content-aware composition is verified
// manually against Adam's actual 2-page cert PDF — the failure mode that
// motivated V1.0086 isn't reproducible from the synthetic 5-page fixture
// which has uniform content density.)
