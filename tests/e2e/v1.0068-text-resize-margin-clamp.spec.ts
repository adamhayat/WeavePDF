// V1.0068 — proportional text resize + 4-margin drag clamp.
//
// Validates Adam's reverted resize model:
//   1. SE handle drag scales the TEXT (font size grows) — not just the
//      box width like V1.0066's frame model.
//   2. When margins are on, dragging the text past the right margin
//      doesn't move the text past the margin guide.
//
// Uses the packaged `.app` via Playwright's Electron API. Requires
// `npm run package:test` first (sets VITE_E2E=1 so test hooks are in).

import { test, expect } from "@playwright/test";
import { launchApp, openFixture, ensureFixturesExist } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

// (V1.0068's "SE handle scales font size" test was removed in V1.0070 —
//  Adam reversed that behavior: the SE handle now resizes the wrap
//  frame width and font size is controlled via the typeable input.
//  V1.0070's spec covers the new behavior.)

test("V1.0068: dragging text past the right margin clamps at the boundary", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    // Margins are on by default in fresh sessions. Create a small text.
    await page.getByTestId("tool-text").click();
    const pageCanvas = page.locator('[data-page="1"]').first();
    const pageBox = await pageCanvas.boundingBox();
    if (!pageBox) return;
    await page.mouse.click(pageBox.x + 80, pageBox.y + 200);

    const promptInput = page.getByTestId("text-prompt-input");
    await expect(promptInput).toBeVisible({ timeout: 5_000 });
    await promptInput.fill("Drag me");
    await promptInput.press("Enter");

    const pendingText = page.locator('[data-pending-element="text"]').first();
    await expect(pendingText).toBeVisible();
    await pendingText.click();

    const wrapper = pendingText.locator(":scope > div").last();
    const beforeBox = await wrapper.boundingBox();
    if (!beforeBox) return;

    // Drag the text 1500px to the right (well past the right margin).
    const cx = beforeBox.x + beforeBox.width / 2;
    const cy = beforeBox.y + beforeBox.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 1500, cy, { steps: 20 });
    await page.mouse.up();

    const afterBox = await wrapper.boundingBox();
    if (!afterBox) return;
    const pageBoxAfter = await pageCanvas.boundingBox();
    if (!pageBoxAfter) return;

    // After the clamp, the wrapper's right edge should sit at or before
    // the margin guide (page right minus ~36pt × zoom).
    const wrapperRight = afterBox.x + afterBox.width;
    const pageRight = pageBoxAfter.x + pageBoxAfter.width;
    expect(wrapperRight).toBeLessThan(pageRight - 10);
  } finally {
    await app.close();
  }
});

test("V1.0068: text prompt has a visible checkmark confirm button", async () => {
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
    await promptInput.fill("Click the check");

    const confirm = page.getByTestId("text-prompt-confirm");
    await expect(confirm).toBeVisible();
    await confirm.click();

    // The pending text was committed by clicking the check.
    await expect(page.locator('[data-pending-element="text"]')).toBeVisible();
    await expect(promptInput).toBeHidden();
  } finally {
    await app.close();
  }
});
