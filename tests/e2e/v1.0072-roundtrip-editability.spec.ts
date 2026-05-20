// V1.0072 — round-trip editability for text overlays.
//
// Adam: "If I make a file with weave and save and exit, it should
//        maintain editability exactly as it was when i made it, when i
//        reopen." Option 1: stash overlay JSON in the PDF Info
//        dictionary, restore on reopen with `whiteout` set to the
//        previously-baked region so the editable overlay covers (not
//        stacks on) the flat content underneath.
//
// This spec walks the full cycle: add a text overlay → save → reopen
// the saved file → verify the pending text overlay reappears editable.

import { test, expect } from "@playwright/test";
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { launchApp, openFixture, ensureFixturesExist } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

test("V1.0072: text overlay survives save + reopen as an editable pending edit", async () => {
  const { app, page } = await launchApp();
  const out = path.join(os.tmpdir(), `weavepdf-roundtrip-${Date.now()}.pdf`);
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    // Create a wrap-mode text overlay.
    await page.getByTestId("tool-text").click();
    const pageCanvas = page.locator('[data-page="1"]').first();
    const pageBox = await pageCanvas.boundingBox();
    if (!pageBox) return;
    await page.mouse.click(pageBox.x + 100, pageBox.y + 220);
    await page.getByTestId("text-prompt-input").fill("round trip me");
    await page.keyboard.press("Enter");

    // Confirm the pending overlay is in the DOM before save.
    await expect(page.locator('[data-pending-element="text"]')).toHaveCount(1);

    // Save via the test hook (avoids the native file dialog).
    const ok = await page.evaluate(
      (p: string) => window.__weavepdfTest__.saveActiveAs(p),
      out,
    );
    expect(ok).toBe(true);
    await expect.poll(() => existsSync(out), { timeout: 5_000 }).toBe(true);

    // Close the current document.
    await app.close();
  } catch (err) {
    if (existsSync(out)) unlinkSync(out);
    await app.close();
    throw err;
  }

  // Relaunch the app and open the saved file. The overlay should
  // reappear as a pending text edit (editable, draggable).
  const { app: app2, page: page2 } = await launchApp();
  try {
    await page2.evaluate(async (filePath: string) => {
      await window.__weavepdfTest__.openPdfByPath(filePath);
    }, out);

    await expect(page2.getByText("1 / 5")).toBeVisible();

    // The pending-text overlay is restored.
    const pendingText = page2.locator('[data-pending-element="text"]').first();
    await expect(pendingText).toBeVisible({ timeout: 10_000 });

    // Verify the text content survived.
    const wrapper = pendingText.locator(":scope > div").last();
    await expect(wrapper).toContainText("round trip me");

    // The restored edit should ALSO have a whiteout layer so it covers
    // the previously-baked content (not stacked on top of it).
    await expect(
      page2.locator('[data-testid="pending-text-whiteout"]'),
    ).toHaveCount(1);

    // Verify it's editable: click + change size via the type-in input.
    await pendingText.click();
    const fontInput = page2.getByTestId("font-size-input");
    await expect(fontInput).toBeVisible();
    await fontInput.click();
    await fontInput.fill("28");
    await fontInput.press("Enter");
    const fs = await wrapper.evaluate(
      (el) => parseFloat(getComputedStyle(el).fontSize),
    );
    // 28pt rendered at ~1.5× zoom → 42+ px. Loose lower bound.
    expect(fs).toBeGreaterThan(20);
  } finally {
    await app2.close();
    if (existsSync(out)) unlinkSync(out);
  }
});
