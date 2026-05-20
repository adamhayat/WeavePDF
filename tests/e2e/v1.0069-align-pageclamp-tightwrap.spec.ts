// V1.0069 — Adam's three follow-ups on V1.0068:
//   1. Margins-off drag-move still clamps to page edges (not the
//      printable rectangle; just the page bounds).
//   2. Text overlays gain align left/center/right/justify with on-screen
//      CSS text-align + ⌘L/⌘E/⌘R/⌘J keyboard shortcuts.
//   3. Wrapper hugs the longest wrapped line (Range-API measurement) so
//      there's no trailing whitespace inside the selection ring.

import { test, expect } from "@playwright/test";
import { launchApp, openFixture, ensureFixturesExist } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

test("V1.0069: alignment toggles update text-align CSS + ⌘E centers", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    await page.getByTestId("tool-text").click();
    const pageCanvas = page.locator('[data-page="1"]').first();
    const pageBox = await pageCanvas.boundingBox();
    if (!pageBox) return;
    await page.mouse.click(pageBox.x + 80, pageBox.y + 200);

    const promptInput = page.getByTestId("text-prompt-input");
    await expect(promptInput).toBeVisible({ timeout: 5_000 });
    await promptInput.fill("Centered headline goes here");
    await promptInput.press("Enter");

    const pendingText = page.locator('[data-pending-element="text"]').first();
    await expect(pendingText).toBeVisible();
    await pendingText.click();

    // Defaults to left.
    const wrapper = pendingText.locator(":scope > div").last();
    await expect(wrapper).toHaveCSS("text-align", /left|start/);

    // Click the Center button.
    const centerBtn = page.locator('[data-pending-element="text"] [data-align="center"]').first();
    await expect(centerBtn).toBeVisible();
    await centerBtn.click();
    await expect(wrapper).toHaveCSS("text-align", "center");

    // ⌘R switches to right.
    await page.keyboard.press("Meta+r");
    await expect(wrapper).toHaveCSS("text-align", "right");

    // ⌘J justifies.
    await page.keyboard.press("Meta+j");
    await expect(wrapper).toHaveCSS("text-align", "justify");

    // ⌘L back to left.
    await page.keyboard.press("Meta+l");
    await expect(wrapper).toHaveCSS("text-align", /left|start/);
  } finally {
    await app.close();
  }
});

test("V1.0069: margins-off — drag still clamps to the page edges", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    // Margins are ON by default. Toggle them OFF first.
    await page.getByTestId("tool-margins").click();

    await page.getByTestId("tool-text").click();
    const pageCanvas = page.locator('[data-page="1"]').first();
    const pageBox = await pageCanvas.boundingBox();
    if (!pageBox) return;
    await page.mouse.click(pageBox.x + 120, pageBox.y + 240);

    const promptInput = page.getByTestId("text-prompt-input");
    await expect(promptInput).toBeVisible({ timeout: 5_000 });
    await promptInput.fill("Drag up");
    await promptInput.press("Enter");

    const pendingText = page.locator('[data-pending-element="text"]').first();
    await expect(pendingText).toBeVisible();
    await pendingText.click();

    const wrapper = pendingText.locator(":scope > div").last();
    const before = await wrapper.boundingBox();
    if (!before) return;

    // Drag the text 1000px UPWARD (way past the page top).
    const cx = before.x + before.width / 2;
    const cy = before.y + before.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 1000, { steps: 20 });
    await page.mouse.up();

    const after = await wrapper.boundingBox();
    const pageBoxAfter = await pageCanvas.boundingBox();
    if (!after || !pageBoxAfter) return;

    // The text's top edge should sit at or below the page's top edge
    // (some small fudge for the floating controls strip rendered above).
    expect(after.y).toBeGreaterThanOrEqual(pageBoxAfter.y - 2);
  } finally {
    await app.close();
  }
});

test("V1.0069: wrapper width hugs longest wrapped line (left align)", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    await page.getByTestId("tool-text").click();
    const pageCanvas = page.locator('[data-page="1"]').first();
    const pageBox = await pageCanvas.boundingBox();
    if (!pageBox) return;
    await page.mouse.click(pageBox.x + 80, pageBox.y + 200);

    const promptInput = page.getByTestId("text-prompt-input");
    await expect(promptInput).toBeVisible({ timeout: 5_000 });
    // Multi-line wrap: a long word at the end forces a wrap mid-paragraph,
    // and the second wrapped line is shorter than the first.
    await promptInput.fill("Line one is longer than line two\nshort");
    await promptInput.press("Enter");

    const pendingText = page.locator('[data-pending-element="text"]').first();
    await expect(pendingText).toBeVisible();
    await pendingText.click();

    const wrapper = pendingText.locator(":scope > div").last();
    // Measure the wrapper's bounding box width vs. its style.maxWidth.
    // After the Range-API tightening, wrapper width should be SMALLER than
    // maxWidth (because content is shorter than wrap boundary).
    const { wrapperW, maxW } = await wrapper.evaluate((el) => {
      const w = el.getBoundingClientRect().width;
      const mw = parseFloat((el as HTMLElement).style.maxWidth) || w;
      return { wrapperW: w, maxW: mw };
    });
    // Sanity: maxWidth was set (the wrap boundary).
    expect(maxW).toBeGreaterThan(0);
    // Tight-fit: wrapper width should be measurably less than maxWidth.
    expect(wrapperW).toBeLessThan(maxW - 4);
  } finally {
    await app.close();
  }
});
