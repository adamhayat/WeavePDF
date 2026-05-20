// V1.0078 — Adam's two pain points:
//   1. Text entry should feel like typing on the PDF page, not inside a
//      dark detached capsule that wraps into a skinny column.
//   2. Saved WeavePDF elements should restore as editable elements on reopen.

import { test, expect } from "@playwright/test";
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { launchApp, openFixture, ensureFixturesExist } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

test("V1.0078: add-text and edit-text inputs are page-native, transparent, and readable", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    await page.getByTestId("tool-text").click();
    const pageCanvas = page.locator('[data-page="1"]').first();
    const pageBox = await pageCanvas.boundingBox();
    if (!pageBox) throw new Error("page box missing");
    await page.mouse.click(pageBox.x + 100, pageBox.y + 220);

    const prompt = page.getByTestId("text-prompt-input");
    await expect(prompt).toBeVisible({ timeout: 5_000 });
    const promptStyle = await prompt.evaluate((el) => {
      const cs = getComputedStyle(el as HTMLElement);
      const rect = (el as HTMLElement).getBoundingClientRect();
      return { bg: cs.backgroundColor, color: cs.color, width: rect.width };
    });
    expect(promptStyle.bg).toBe("rgba(0, 0, 0, 0)");
    expect(promptStyle.color).toBe("rgb(11, 11, 14)");
    expect(promptStyle.width).toBeGreaterThan(300);

    await prompt.fill("Hello whats going on");
    await page.keyboard.press("Enter");

    const pendingText = page.locator('[data-pending-element="text"]').first();
    await expect(pendingText).toBeVisible();
    await pendingText.dblclick();

    const editor = page.getByTestId("pending-text-input");
    await expect(editor).toBeVisible();
    const editorStyle = await editor.evaluate((el) => {
      const cs = getComputedStyle(el as HTMLElement);
      const rect = (el as HTMLElement).getBoundingClientRect();
      return { bg: cs.backgroundColor, color: cs.color, width: rect.width };
    });
    expect(editorStyle.bg).toBe("rgba(0, 0, 0, 0)");
    expect(editorStyle.color).toBe("rgb(11, 11, 14)");
    expect(editorStyle.width).toBeGreaterThan(300);
  } finally {
    await app.close();
  }
});

test("V1.0078: saved text and shape elements reopen as editable WeavePDF elements", async () => {
  const { app, page } = await launchApp();
  const out = path.join(os.tmpdir(), `weavepdf-layer-roundtrip-${Date.now()}.pdf`);
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    const pageCanvas = page.locator('[data-page="1"]').first();
    const pageBox = await pageCanvas.boundingBox();
    if (!pageBox) throw new Error("page box missing");

    await page.getByTestId("tool-text").click();
    await page.mouse.click(pageBox.x + 100, pageBox.y + 220);
    await page.getByTestId("text-prompt-input").fill("editable after reopen");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-pending-element="text"]')).toHaveCount(1);

    await page.getByTestId("tool-rect").click();
    await page.mouse.move(pageBox.x + 140, pageBox.y + 330);
    await page.mouse.down();
    await page.mouse.move(pageBox.x + 260, pageBox.y + 390);
    await page.mouse.up();
    await expect(page.locator('[data-pending-element="shape"][data-shape-kind="rect"]')).toHaveCount(1);

    const ok = await page.evaluate(
      (p: string) => window.__weavepdfTest__.saveActiveAs(p),
      out,
    );
    expect(ok).toBe(true);
    await expect.poll(() => existsSync(out), { timeout: 5_000 }).toBe(true);
  } finally {
    await app.close();
  }

  const { app: app2, page: page2 } = await launchApp();
  try {
    await page2.evaluate(async (filePath: string) => {
      await window.__weavepdfTest__.openPdfByPath(filePath);
    }, out);

    await expect(page2.getByText("1 / 5")).toBeVisible();
    await expect(page2.locator('[data-pending-element="text"]')).toHaveCount(1);
    await expect(
      page2.locator('[data-pending-element="shape"][data-shape-kind="rect"]'),
    ).toHaveCount(1);
    await expect(page2.getByTestId("toast")).toContainText("2 editable WeavePDF elements");
  } finally {
    await app2.close();
    if (existsSync(out)) unlinkSync(out);
  }
});
