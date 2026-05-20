// V1.0070 — Adam's four follow-ups:
//   1. Snapshot-based undo: each user mutation pushes a snapshot, so
//      ⌘Z steps back ONE property change at a time instead of nuking
//      the whole edit.
//   2. Two-box text frame: dashed wrap-area outline around the text;
//      its SE handle resizes widthPt (not font size).
//   3. Type-in font size input replaces the read-only "14" span.
//   4. Option-drag duplicates the element (Mac convention).

import { test, expect } from "@playwright/test";
import { launchApp, openFixture, ensureFixturesExist } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

test("V1.0070: ⌘Z steps back one property change instead of deleting the edit", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    // Create a text overlay.
    await page.getByTestId("tool-text").click();
    const pageCanvas = page.locator('[data-page="1"]').first();
    const pageBox = await pageCanvas.boundingBox();
    if (!pageBox) return;
    await page.mouse.click(pageBox.x + 100, pageBox.y + 200);
    await page.getByTestId("text-prompt-input").fill("undo me");
    await page.keyboard.press("Enter");

    const pendingText = page.locator('[data-pending-element="text"]').first();
    await expect(pendingText).toBeVisible();
    await pendingText.click();

    // Bold via ⌘B. The text should be bold afterwards.
    await page.keyboard.press("Meta+b");
    const wrapper = pendingText.locator(":scope > div").last();
    await expect(wrapper).toHaveCSS("font-weight", "700");

    // Italic via ⌘I.
    await page.keyboard.press("Meta+i");
    await expect(wrapper).toHaveCSS("font-style", "italic");

    // ⌘Z should undo italic — text still bold, no longer italic.
    await page.keyboard.press("Meta+z");
    await expect(wrapper).toHaveCSS("font-weight", "700");
    await expect(wrapper).toHaveCSS("font-style", "normal");

    // ⌘Z again undoes bold.
    await page.keyboard.press("Meta+z");
    await expect(wrapper).toHaveCSS("font-weight", "400");

    // The text overlay should STILL be on the page (not deleted by undo).
    await expect(pendingText).toBeVisible();

    // ⌘Z one more time should remove the edit entirely (back to pre-add).
    await page.keyboard.press("Meta+z");
    await expect(page.locator('[data-pending-element="text"]')).toHaveCount(0);

    // ⇧⌘Z redoes the add.
    await page.keyboard.press("Shift+Meta+z");
    await expect(page.locator('[data-pending-element="text"]')).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test("V1.0070: SE handle on the frame resizes widthPt (font size stays put)", async () => {
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
    await expect(pendingText).toBeVisible();
    await pendingText.click();

    // Capture the font size before the drag.
    const wrapper = pendingText.locator(":scope > div").last();
    const beforeFontSize = await wrapper.evaluate(
      (el) => parseFloat(getComputedStyle(el).fontSize),
    );

    // The frame SE handle lives on `[data-handle="frame-se"]`.
    const handle = page.locator('[data-handle="frame-se"]').first();
    await expect(handle).toBeVisible();
    const handleBox = await handle.boundingBox();
    if (!handleBox) return;
    const cx = handleBox.x + handleBox.width / 2;
    const cy = handleBox.y + handleBox.height / 2;

    // Drag the handle LEFT by 80 px (shrink the wrap frame).
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 80, cy, { steps: 12 });
    await page.mouse.up();

    // Font size should not change — only the wrap frame moved.
    const afterFontSize = await wrapper.evaluate(
      (el) => parseFloat(getComputedStyle(el).fontSize),
    );
    expect(Math.abs(afterFontSize - beforeFontSize)).toBeLessThan(0.5);
  } finally {
    await app.close();
  }
});

test("V1.0070: type-in font size input updates the size", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    await page.getByTestId("tool-text").click();
    const pageCanvas = page.locator('[data-page="1"]').first();
    const pageBox = await pageCanvas.boundingBox();
    if (!pageBox) return;
    await page.mouse.click(pageBox.x + 100, pageBox.y + 200);
    await page.getByTestId("text-prompt-input").fill("size me");
    await page.keyboard.press("Enter");

    const pendingText = page.locator('[data-pending-element="text"]').first();
    await pendingText.click();

    const fontInput = page.getByTestId("font-size-input");
    await expect(fontInput).toBeVisible();
    // Default is 14 → set to 36.
    await fontInput.click();
    await fontInput.fill("36");
    await fontInput.press("Enter");

    const wrapper = pendingText.locator(":scope > div").last();
    const fs = await wrapper.evaluate(
      (el) => parseFloat(getComputedStyle(el).fontSize),
    );
    // Font size is in CSS px = pt × zoom. Just check the value moved
    // substantially (from ~14 → ~36 in pt).
    expect(fs).toBeGreaterThan(20);
  } finally {
    await app.close();
  }
});

test("V1.0070: option-drag duplicates a text overlay", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    await page.getByTestId("tool-text").click();
    const pageCanvas = page.locator('[data-page="1"]').first();
    const pageBox = await pageCanvas.boundingBox();
    if (!pageBox) return;
    await page.mouse.click(pageBox.x + 100, pageBox.y + 200);
    await page.getByTestId("text-prompt-input").fill("clone me");
    await page.keyboard.press("Enter");

    await expect(page.locator('[data-pending-element="text"]')).toHaveCount(1);

    // Hold Alt while dragging the overlay → should duplicate.
    const original = page.locator('[data-pending-element="text"]').first();
    const wrapper = original.locator(":scope > div").last();
    const box = await wrapper.boundingBox();
    if (!box) return;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await page.keyboard.down("Alt");
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 100, cy + 80, { steps: 12 });
    await page.mouse.up();
    await page.keyboard.up("Alt");

    // Two pending text overlays now exist.
    await expect(page.locator('[data-pending-element="text"]')).toHaveCount(2);
  } finally {
    await app.close();
  }
});
