// V1.0099 — pending overlays can be dragged through the top/bottom
// page bounds onto an adjacent page instead of getting stuck at the
// margin guide.

import { test, expect } from "@playwright/test";
import { ensureFixturesExist, launchApp, openFixture } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

test("V1.0099: pending text drags from one page onto the next page", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible({ timeout: 10_000 });

    const { tabId, editId } = await page.evaluate(() => {
      const tab = window.__weavepdfTest__.getActiveTab();
      if (!tab?.id) throw new Error("active tab missing");
      const addPendingTextEdit = window.__weavepdfTest__.addPendingTextEdit;
      if (!addPendingTextEdit) throw new Error("addPendingTextEdit hook missing");
      const id = addPendingTextEdit(tab.id, {
        page: 1,
        xPt: 180,
        yPt: 54,
        size: 16,
        text: "Cross-page drag",
        widthPt: 220,
      });
      return { tabId: tab.id, editId: id };
    });

    const pending = page.locator(`[data-pending-element="text"][data-edit-id="${editId}"]`);
    await expect(pending).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-page="1"]').evaluate((el) => {
      el.scrollIntoView({ block: "end", inline: "nearest" });
    });
    await expect(page.locator('[data-page="2"]')).toBeVisible({ timeout: 5_000 });

    const start = await pending.boundingBox();
    const page2 = await page.locator('[data-page="2"]').boundingBox();
    if (!start || !page2) throw new Error("drag geometry missing");

    await page.mouse.move(start.x + 12, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + 12, page2.y + 76, { steps: 24 });
    await page.mouse.up();

    await expect
      .poll(async () => {
        return page.evaluate(({ tabId: id, editId: pendingId }) => {
          const getPendingTexts = window.__weavepdfTest__.getPendingTexts;
          if (!getPendingTexts) return null;
          return getPendingTexts(id).find((edit) => edit.id === pendingId)?.page ?? null;
        }, { tabId, editId });
      }, { timeout: 5_000 })
      .toBe(2);
    await expect(page.locator(`[data-pending-element="text"][data-edit-id="${editId}"][data-page-number="2"]`))
      .toBeVisible({ timeout: 5_000 });
  } finally {
    await app.close();
  }
});
