// V1.0071 — both boxes have their own resize handles:
//   - Inner SE handle (data-handle="font-se") on the text wrapper →
//     scales font size proportionally (V1.0060 formula).
//   - Outer SE handle (data-handle="frame-se") on the dashed frame →
//     resizes widthPt (V1.0070 behavior, unchanged).
//
// Adam: "i want the outter box to control the total space alotted for
//        the text, and i want the inner box to control the size of the
//        text, both should be adjustable."

import { test, expect } from "@playwright/test";
import { launchApp, openFixture, ensureFixturesExist } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

test("V1.0071: inner SE handle scales font size proportionally", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    await page.getByTestId("tool-text").click();
    const pageCanvas = page.locator('[data-page="1"]').first();
    const pageBox = await pageCanvas.boundingBox();
    if (!pageBox) return;
    await page.mouse.click(pageBox.x + 80, pageBox.y + 200);
    await page.getByTestId("text-prompt-input").fill("Resize me");
    await page.keyboard.press("Enter");

    const pendingText = page.locator('[data-pending-element="text"]').first();
    await expect(pendingText).toBeVisible();
    await pendingText.click();

    const wrapper = pendingText.locator(":scope > div").last();
    const beforeFontSize = await wrapper.evaluate(
      (el) => parseFloat(getComputedStyle(el).fontSize),
    );

    const innerHandle = page.locator('[data-handle="font-se"]').first();
    await expect(innerHandle).toBeVisible();
    const handleBox = await innerHandle.boundingBox();
    if (!handleBox) return;
    const cx = handleBox.x + handleBox.width / 2;
    const cy = handleBox.y + handleBox.height / 2;

    // Drag down-right — proportional scale → font GROWS.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy + 30, { steps: 10 });
    await page.mouse.up();

    const afterFontSize = await wrapper.evaluate(
      (el) => parseFloat(getComputedStyle(el).fontSize),
    );
    expect(afterFontSize).toBeGreaterThan(beforeFontSize + 1);
  } finally {
    await app.close();
  }
});

test("V1.0071: outer frame handle resizes widthPt without changing font size", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    await page.getByTestId("tool-text").click();
    const pageCanvas = page.locator('[data-page="1"]').first();
    const pageBox = await pageCanvas.boundingBox();
    if (!pageBox) return;
    await page.mouse.click(pageBox.x + 80, pageBox.y + 200);
    await page.getByTestId("text-prompt-input").fill("frame me");
    await page.keyboard.press("Enter");

    const pendingText = page.locator('[data-pending-element="text"]').first();
    await pendingText.click();
    const wrapper = pendingText.locator(":scope > div").last();
    const beforeFontSize = await wrapper.evaluate(
      (el) => parseFloat(getComputedStyle(el).fontSize),
    );

    const outerHandle = page.locator('[data-handle="frame-se"]').first();
    await expect(outerHandle).toBeVisible();
    const handleBox = await outerHandle.boundingBox();
    if (!handleBox) return;
    const cx = handleBox.x + handleBox.width / 2;
    const cy = handleBox.y + handleBox.height / 2;

    // Drag the OUTER handle right — widthPt grows, font stays put.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 100, cy, { steps: 10 });
    await page.mouse.up();

    const afterFontSize = await wrapper.evaluate(
      (el) => parseFloat(getComputedStyle(el).fontSize),
    );
    expect(Math.abs(afterFontSize - beforeFontSize)).toBeLessThan(0.5);
  } finally {
    await app.close();
  }
});
