// V1.0077 — three Adam follow-ups against V1.0076:
//
//   1. Alignment options should be relative to the actual rendered text
//      bounds, not the wider outer wrap frame.
//   2. Roomier paragraph editing — bigger textarea, auto-grow as you
//      type new lines.
//   3. Visible confirmation when round-trip metadata restores overlays
//      on reopen.

import { test, expect } from "@playwright/test";
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { launchApp, openFixture, ensureFixturesExist } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

test("V1.0077 #1: wrapper width matches longest wrapped line for ALL alignments", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    await page.getByTestId("tool-text").click();
    const pageCanvas = page.locator('[data-page="1"]').first();
    const pageBox = await pageCanvas.boundingBox();
    if (!pageBox) throw new Error("page box missing");
    await page.mouse.click(pageBox.x + 80, pageBox.y + 200);

    const promptInput = page.getByTestId("text-prompt-input");
    await expect(promptInput).toBeVisible({ timeout: 5_000 });
    // Two lines of very different length so the difference between
    // "wrapper hugs longest line" and "wrapper fills wrap box" is
    // measurable as a meaningful pixel delta.
    await promptInput.fill("Heading text\nshort");
    await promptInput.press("Enter");

    const pendingText = page.locator('[data-pending-element="text"]').first();
    await expect(pendingText).toBeVisible();
    await pendingText.click();

    const wrapper = pendingText.locator(":scope > div").last();

    // Capture wrapper width across alignments. With V1.0077, wrapper width
    // shrinks to the longest line (so it stays roughly constant regardless
    // of alignment); pre-V1.0077 the wrapper widened for non-left
    // alignments to fill the wrap-box's full width.
    async function measureWrapperWidth(): Promise<number> {
      return await wrapper.evaluate((el) => Math.round((el as HTMLElement).getBoundingClientRect().width));
    }

    const leftW = await measureWrapperWidth();

    await page.locator('[data-pending-element="text"] [data-align="center"]').first().click();
    const centerW = await measureWrapperWidth();

    await page.locator('[data-pending-element="text"] [data-align="right"]').first().click();
    const rightW = await measureWrapperWidth();

    // All three widths should be within ~4 px of each other — the wrapper
    // tracks the longest line, not the wrap box.
    expect(Math.abs(centerW - leftW)).toBeLessThanOrEqual(4);
    expect(Math.abs(rightW - leftW)).toBeLessThanOrEqual(4);
  } finally {
    await app.close();
  }
});

test("V1.0077 #2: paragraph editing textarea has roomy default + grows with content", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    await page.getByTestId("tool-text").click();
    const pageCanvas = page.locator('[data-page="1"]').first();
    const pageBox = await pageCanvas.boundingBox();
    if (!pageBox) throw new Error("page box missing");
    await page.mouse.click(pageBox.x + 80, pageBox.y + 200);

    const promptInput = page.getByTestId("text-prompt-input");
    await expect(promptInput).toBeVisible({ timeout: 5_000 });
    await promptInput.fill("Seed");
    await promptInput.press("Enter");

    const pendingText = page.locator('[data-pending-element="text"]').first();
    await pendingText.dblclick();

    const ta = page.getByTestId("pending-text-input");
    await expect(ta).toBeVisible();
    const startH = await ta.evaluate((el) => (el as HTMLTextAreaElement).clientHeight);

    // Minimum should accommodate at least ~4 lines of the rendered font.
    // At 14pt × 1.5 zoom × 1.2 line-height × 4 lines ≈ 100 px. Allow a
    // generous floor so we're not coupled to the exact font/zoom math.
    expect(startH).toBeGreaterThanOrEqual(60);

    // Now type several lines and confirm the textarea grows.
    await ta.fill("Line A\nLine B\nLine C\nLine D\nLine E\nLine F\nLine G");
    const grownH = await ta.evaluate((el) => (el as HTMLTextAreaElement).clientHeight);
    expect(grownH).toBeGreaterThan(startH + 20);
  } finally {
    await app.close();
  }
});

test("V1.0077 #3: opening a file with saved overlays shows a restore toast", async () => {
  const { app, page } = await launchApp();
  const out = path.join(os.tmpdir(), `weavepdf-toast-${Date.now()}.pdf`);
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    await page.getByTestId("tool-text").click();
    const pageCanvas = page.locator('[data-page="1"]').first();
    const pageBox = await pageCanvas.boundingBox();
    if (!pageBox) throw new Error("page box missing");
    await page.mouse.click(pageBox.x + 100, pageBox.y + 220);
    await page.getByTestId("text-prompt-input").fill("hello round trip");
    await page.keyboard.press("Enter");

    const ok = await page.evaluate(
      (p: string) => window.__weavepdfTest__.saveActiveAs(p),
      out,
    );
    expect(ok).toBe(true);
    await expect.poll(() => existsSync(out), { timeout: 5_000 }).toBe(true);
    await app.close();
  } catch (err) {
    if (existsSync(out)) unlinkSync(out);
    await app.close();
    throw err;
  }

  const { app: app2, page: page2 } = await launchApp();
  try {
    await page2.evaluate(async (filePath: string) => {
      await window.__weavepdfTest__.openPdfByPath(filePath);
    }, out);
    const toast = page2.getByTestId("toast");
    await expect(toast).toBeVisible({ timeout: 5_000 });
    await expect(toast).toContainText(/Restored/i);
    await expect(toast).toContainText(/element/i);
  } finally {
    await app2.close();
    if (existsSync(out)) unlinkSync(out);
  }
});
