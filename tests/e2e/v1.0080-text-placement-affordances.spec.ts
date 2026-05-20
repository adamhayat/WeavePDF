// V1.0080 — placing Add Text keeps the object selected so the two-handle
// model remains immediately available:
//   - inner handle (font-se) scales font size
//   - outer handle (frame-se) resizes the writing area
//   - the placed text can be dragged right away, without an extra click

import { test, expect } from "@playwright/test";
import { launchApp, openFixture, ensureFixturesExist } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

test("V1.0080: confirmed Add Text shows both handles and drags immediately", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    await page.getByTestId("tool-text").click();
    const pageCanvas = page.locator('[data-page="1"]').first();
    const pageBox = await pageCanvas.boundingBox();
    if (!pageBox) return;

    await page.mouse.click(pageBox.x + 95, pageBox.y + 210);
    await page.getByTestId("text-prompt-input").fill("Selected after placement");
    await page.getByTestId("text-prompt-confirm").click();

    const pendingText = page.locator('[data-pending-element="text"]').first();
    await expect(pendingText).toBeVisible();

    const fontHandle = page.locator('[data-handle="font-se"]').first();
    const frameHandle = page.locator('[data-handle="frame-se"]').first();
    await expect(fontHandle).toBeVisible();
    await expect(frameHandle).toBeVisible();

    const fontBox = await fontHandle.boundingBox();
    const frameBox = await frameHandle.boundingBox();
    expect(fontBox).not.toBeNull();
    expect(frameBox).not.toBeNull();
    if (!fontBox || !frameBox) return;
    expect(Math.abs(fontBox.x - frameBox.x)).toBeGreaterThan(10);

    const beforeX = Number(await pendingText.getAttribute("data-x-pt"));
    const wrapper = pendingText.locator(":scope > div").last();
    const wrapperBox = await wrapper.boundingBox();
    if (!wrapperBox) return;
    const cx = wrapperBox.x + wrapperBox.width / 2;
    const cy = wrapperBox.y + wrapperBox.height / 2;

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy + 30, { steps: 10 });
    await page.mouse.up();

    const afterX = Number(await pendingText.getAttribute("data-x-pt"));
    expect(afterX).toBeGreaterThan(beforeX + 20);
  } finally {
    await app.close();
  }
});
