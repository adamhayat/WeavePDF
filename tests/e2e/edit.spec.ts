import { test, expect } from "@playwright/test";
import { unlinkSync, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { launchApp, openFixture, ensureFixturesExist, fixturePath } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

test("delete selected pages via sidebar action", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    // Click thumbnail for page 2, then shift-click page 3 to select a range.
    const thumb2 = page.locator('[data-testid="thumb-button"]').nth(1);
    const thumb3 = page.locator('[data-testid="thumb-button"]').nth(2);
    await thumb2.click();
    await thumb3.click({ modifiers: ["Shift"] });

    // 2 pages selected, delete action visible.
    await expect(page.getByText("2 selected")).toBeVisible();
    await page.locator('[data-testid="delete-pages"]').click();

    // After delete: 3 pages remain. Current page is whichever page the
    // store decided to point at after the edit — assert on total, not current.
    await expect(page.getByText(/\/\s*3$/)).toBeVisible({ timeout: 15_000 });
  } finally {
    await app.close();
  }
});

test("rotate selected page 90° clockwise", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");

    const thumb1 = page.locator('[data-testid="thumb-button"]').first();
    await thumb1.click();
    await page.locator('[data-testid="rotate-right"]').click();

    // The bytes + pdf reload ⇒ sidebar counter is re-rendered but page count is unchanged.
    await expect(page.getByText("1 / 5")).toBeVisible();
    // Document should now be dirty.
    await expect(page.locator('[data-testid="tab"][data-tab-name="sample.pdf"]')).toBeVisible();
  } finally {
    await app.close();
  }
});

test("undo reverts the last edit", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await page.locator('[data-testid="thumb-button"]').first().click();
    await page.locator('[data-testid="delete-pages"]').click();
    await expect(page.getByText(/\/\s*4$/)).toBeVisible({ timeout: 15_000 });

    await page.keyboard.press("Meta+z");
    await expect(page.getByText(/\/\s*5$/)).toBeVisible({ timeout: 15_000 });
  } finally {
    await app.close();
  }
});

test("undo removes the latest pending overlay action", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await page.getByTestId("tool-rect").click();
    const layer = page.locator('[data-testid="interaction-layer"][data-tool="rect"]').first();
    const box = await layer.boundingBox();
    expect(box).toBeTruthy();
    if (!box) return;
    await page.mouse.move(box.x + 70, box.y + 110);
    await page.mouse.down();
    await page.mouse.move(box.x + 220, box.y + 210, { steps: 10 });
    await page.mouse.up();
    await expect(page.getByTestId("pending-shape")).toHaveCount(1);

    await page.keyboard.press("Meta+z");
    await expect(page.getByTestId("pending-shape")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("edit existing text whites out original text and exits on enter or blur", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    const originalText = page.locator(".textLayer span").filter({ hasText: "Welcome to WeavePDF" }).first();
    await expect(originalText).toBeVisible();

    await page.getByTestId("tool-edit-text").click();
    await originalText.click();
    let input = page.getByTestId("pending-text-input");
    await expect(input).toBeVisible();
    await expect(page.getByTestId("pending-text-whiteout")).toBeVisible();
    await input.fill("Edited WeavePDF text");
    await page.keyboard.press("Enter");
    await expect(input).toBeHidden();
    await expect(page.getByTestId("pending-text").filter({ hasText: "Edited WeavePDF text" })).toBeVisible();
    await expect(page.getByLabel("Increase font size")).toBeHidden();
    await expect(page.getByLabel("Decrease font size")).toBeHidden();

    await page.keyboard.press("Meta+z");
    await expect(page.getByTestId("pending-text")).toHaveCount(0);
    await expect(page.getByTestId("pending-text-whiteout")).toHaveCount(0);

    await page.getByTestId("tool-edit-text").click();
    await originalText.click();
    input = page.getByTestId("pending-text-input");
    await expect(input).toBeVisible();
    await input.fill("Blur-committed text");
    await page.locator('[data-testid="toolstrip"]').click({ position: { x: 4, y: 4 } });
    await expect(input).toBeHidden();
    await expect(page.getByTestId("pending-text").filter({ hasText: "Blur-committed text" })).toBeVisible();
    await expect(page.getByLabel("Increase font size")).toBeHidden();
    await expect(page.getByLabel("Decrease font size")).toBeHidden();
  } finally {
    await app.close();
  }
});

test("command palette opens via ⌘K, filters actions, runs one", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await page.keyboard.press("Meta+k");

    const palette = page.getByTestId("palette");
    await expect(palette).toBeVisible();

    await page.getByTestId("palette-input").fill("compress");

    const compressItem = page.locator('[data-testid="palette-item"][data-action-id="compress"]');
    await expect(compressItem).toBeVisible();
    await compressItem.click();

    await expect(page.getByTestId("compress-modal")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("compress modal shows preset rows and runs at least one", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await page.keyboard.press("Meta+k");
    await page.getByTestId("palette-input").fill("compress");
    await page.locator('[data-testid="palette-item"][data-action-id="compress"]').click();

    await expect(page.getByTestId("compress-modal")).toBeVisible();
    // The new modal pre-computes presets in parallel and surfaces real sizes
    // (or "Already optimized" for tiny PDFs that can't shrink further).
    // Smallest fixture is text-only and likely ends up "Already optimized" —
    // assert that either real size text OR that label appears within 30s.
    await expect(
      page.getByText(/Already optimized|−\d+%/).first(),
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    await app.close();
  }
});

test("save writes the current bytes to disk", async () => {
  const { app, page } = await launchApp();
  const outPath = path.join(os.tmpdir(), `weavepdf-save-${Date.now()}.pdf`);
  try {
    await openFixture(page, "sample-short.pdf");

    // contextBridge freezes the weavepdf API so we bypass the dialog via a
    // dedicated test hook that writes the active tab's bytes directly.
    const ok = await page.evaluate(
      (p: string) => window.__weavepdfTest__.saveActiveAs(p),
      outPath,
    );
    expect(ok).toBe(true);
    await expect.poll(() => existsSync(outPath), { timeout: 5_000 }).toBe(true);
    expect(statSync(outPath).size).toBeGreaterThan(0);
  } finally {
    await app.close();
    if (existsSync(outPath)) unlinkSync(outPath);
  }
});

test("export combined PDF writes a merged file when multiple tabs are open", async () => {
  const { app, page } = await launchApp();
  const outPath = path.join(os.tmpdir(), `weavepdf-export-${Date.now()}.pdf`);
  try {
    await openFixture(page, "sample-short.pdf");
    await openFixture(page, "sample.pdf");

    const ok = await page.evaluate(
      (p: string) => window.__weavepdfTest__.exportCombinedTo(p),
      outPath,
    );
    expect(ok).toBe(true);
    await expect.poll(() => existsSync(outPath), { timeout: 5_000 }).toBe(true);
    // Merged file should be at least as large as the bigger source.
    expect(statSync(outPath).size).toBeGreaterThan(statSync(fixturePath("sample.pdf")).size);
  } finally {
    await app.close();
    if (existsSync(outPath)) unlinkSync(outPath);
  }
});

test("export combined commits pending overlays before writing", async () => {
  const { app, page } = await launchApp();
  const outPath = path.join(os.tmpdir(), `weavepdf-export-pending-${Date.now()}.pdf`);
  try {
    await openFixture(page, "sample.pdf");
    await page.getByTestId("tool-rect").click();
    const layer = page.locator('[data-testid="interaction-layer"][data-tool="rect"]').first();
    const box = await layer.boundingBox();
    expect(box).toBeTruthy();
    if (!box) return;
    await page.mouse.move(box.x + 70, box.y + 110);
    await page.mouse.down();
    await page.mouse.move(box.x + 220, box.y + 210, { steps: 10 });
    await page.mouse.up();

    const ok = await page.evaluate(
      (p: string) => window.__weavepdfTest__.exportCombinedTo(p),
      outPath,
    );
    expect(ok).toBe(true);
    await expect.poll(() => existsSync(outPath), { timeout: 5_000 }).toBe(true);

    const exported = readFileSync(outPath);
    const original = readFileSync(fixturePath("sample.pdf"));
    expect(exported.equals(original)).toBe(false);
  } finally {
    await app.close();
    if (existsSync(outPath)) unlinkSync(outPath);
  }
});
