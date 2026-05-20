// V1.0098 — page insertion lives between thumbnails. Hover below a page
// number to reveal a slim "Add page" segment, then click to insert after
// that page.

import { test, expect } from "@playwright/test";
import { ensureFixturesExist, launchApp, openFixture } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

test("V1.0098: hover segment below a thumbnail number inserts a page after it", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible({ timeout: 10_000 });

    const addAfter2Slot = page.getByTestId("sidebar-add-page-slot-2");
    const addAfter2 = page.getByTestId("sidebar-add-page-after-2");
    await expect(addAfter2).toHaveCSS("opacity", "0");

    await expect
      .poll(async () => {
        const slotBox = await addAfter2Slot.boundingBox();
        if (!slotBox) return 0;
        await page.mouse.move(slotBox.x + slotBox.width / 2, slotBox.y + slotBox.height / 2);
        return Number(await addAfter2.evaluate((el) => getComputedStyle(el).opacity));
      })
      .toBeGreaterThan(0.75);

    const slotBox = await addAfter2Slot.boundingBox();
    if (!slotBox) throw new Error("add-page slot bbox missing");
    await page.mouse.click(slotBox.x + slotBox.width / 2, slotBox.y + slotBox.height / 2);
    await expect(page.getByText(/\d+\s*\/\s*6/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("3 / 6")).toBeVisible({ timeout: 10_000 });
  } finally {
    await app.close();
  }
});
