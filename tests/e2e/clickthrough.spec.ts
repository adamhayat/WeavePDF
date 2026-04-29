import { test, expect, type Page } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { ensureFixturesExist, launchApp, openFixture } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

async function openPaletteAction(page: Page, actionId: string, query: string) {
  await page.keyboard.press("Meta+K");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.getByTestId("palette-input").fill(query);
  const item = page.locator(`[data-testid="palette-item"][data-action-id="${actionId}"]`);
  await expect(item).toBeVisible();
  await item.click();
}

async function closeModal(page: Page, testId: string) {
  const modal = page.getByTestId(testId);
  await expect(modal).toBeVisible();
  await modal.getByRole("button", { name: "Close" }).first().click();
  await expect(modal).toBeHidden();
}

async function firstLayerBox(page: Page, tool: string) {
  const layer = page.locator(`[data-testid="interaction-layer"][data-tool="${tool}"]`).first();
  await expect(layer).toBeVisible();
  const box = await layer.boundingBox();
  expect(box).toBeTruthy();
  if (!box) throw new Error(`No interaction layer box for ${tool}`);
  return { layer, box };
}

async function dragOnTool(
  page: Page,
  tool: string,
  start: { x: number; y: number } = { x: 300, y: 260 },
) {
  const { box } = await firstLayerBox(page, tool);
  await page.mouse.move(box.x + start.x, box.y + start.y);
  await page.mouse.down();
  await page.mouse.move(box.x + start.x + 110, box.y + start.y + 70, { steps: 8 });
  await page.mouse.up();
}

async function withApp(fn: (page: Page, app: ElectronApplication) => Promise<void>) {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByTestId("toolstrip")).toBeVisible();
    await expect(page.locator('[data-testid="thumb-button"]').first()).toBeVisible();
    await fn(page, app);
  } finally {
    await app.close();
  }
}

test("click-through: every visible toolstrip button is present", async () => {
  await withApp(async (page) => {
    for (const id of [
      "tool-text",
      "tool-edit-text",
      "tool-signature",
      "tool-image",
      "tool-sticky",
      "tool-highlight",
      "tool-whiteout",
      "tool-redact",
      "tool-rect",
      "tool-circle",
      "tool-line",
      "tool-arrow",
      "tool-draw",
      "tool-link",
      "tool-measure",
      "tool-rotate-left",
      "tool-rotate-right",
      "tool-delete",
      "tool-extract",
      "tool-crop",
      "tool-compress",
      "tool-watermark",
      "tool-header-footer",
      "tool-metadata",
      "tool-print",
      "tool-save",
      "tool-export",
      "tool-undo",
      "tool-redo",
    ]) {
      await expect(page.getByTestId(id), id).toBeVisible();
    }
  });
});

test("click-through: annotation tools activate, draw, and expose their editors", async () => {
  await withApp(async (page) => {
    await page.getByTestId("tool-link").click();
    await dragOnTool(page, "link", { x: 580, y: 260 });
    await expect(page.getByTestId("link-popover")).toBeVisible();
    await page.getByTestId("link-url-input").fill("example.com");
    await page.getByTestId("link-apply").click();
    await expect(page.getByTestId("link-popover")).toBeHidden();

    await page.getByTestId("tool-text").click();
    const text = await firstLayerBox(page, "text");
    await page.mouse.click(text.box.x + 120, text.box.y + 150);
    await expect(page.getByTestId("text-prompt")).toBeVisible();
    await page.getByTestId("text-prompt-input").fill("click-through text");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("pending-text").first()).toBeVisible();

    await page.getByTestId("tool-sticky").click();
    const sticky = await firstLayerBox(page, "sticky");
    await page.mouse.click(sticky.box.x + 150, sticky.box.y + 170);
    await expect(page.getByTestId("sticky-prompt")).toBeVisible();
    await page.getByTestId("sticky-prompt-input").fill("click-through note");
    await page.getByTestId("sticky-prompt").getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("pending-shape").first()).toBeVisible();

    const dragTools = [
      "highlight",
      "whiteout",
      "redact",
      "rect",
      "circle",
      "line",
      "arrow",
      "draw",
      "measure",
    ];
    for (const [i, tool] of dragTools.entries()) {
      await page.getByTestId(`tool-${tool}`).click();
      await dragOnTool(page, tool, {
        x: 280 + (i % 3) * 170,
        y: 330 + Math.floor(i / 3) * 120,
      });
      await expect(page.getByTestId("pending-shape").first()).toBeVisible();
    }
  });
});

test("click-through: document modals open from their visible buttons", async () => {
  await withApp(async (page) => {
    for (const [buttonId, modalId] of [
      ["tool-signature", "signature-modal"],
      ["tool-extract", "extract-modal"],
      ["tool-crop", "crop-modal"],
      ["tool-watermark", "watermark-modal"],
      ["tool-header-footer", "headerfooter-modal"],
      ["tool-metadata", "metadata-modal"],
    ] as const) {
      await page.getByTestId(buttonId).click();
      await closeModal(page, modalId);
    }

    await page.getByTestId("tool-compress").click();
    await closeModal(page, "compress-modal");
  });
});

test("click-through: palette-only feature surfaces open and close", async () => {
  await withApp(async (page) => {
    for (const [actionId, query, modalId] of [
      ["recent-drafts", "recent drafts", "recent-drafts-modal"],
      ["fill-form", "fill form", "form-fill-modal"],
      ["batch", "batch", "batch-modal"],
      ["ocr", "ocr", "ocr-modal"],
      ["digital-sign", "digital sign", "digital-sign-modal"],
      ["ai-summarize", "apple intelligence", "ai-modal"],
    ] as const) {
      await openPaletteAction(page, actionId, query);
      await closeModal(page, modalId);
    }

    await openPaletteAction(page, "page-layout", "page layout");
    const layout = page.getByTestId("page-layout-modal");
    await expect(layout).toBeVisible();
    for (const tab of ["nup", "crop", "fit", "booklet", "split"]) {
      await page.getByTestId(`layout-tab-${tab}`).click();
    }
    await closeModal(page, "page-layout-modal");

    const qpdfOk = await page.evaluate(() => window.weavepdf.qpdf.available());
    if (qpdfOk) {
      await openPaletteAction(page, "encrypt-pdf", "encrypt");
      await closeModal(page, "password-modal");
    }
  });
});

test("click-through: keyboard shortcut reference opens from hotkey and palette", async () => {
  await withApp(async (page, app) => {
    const helpShortcut = await app.evaluate(({ Menu }) => {
      const helpMenu = Menu.getApplicationMenu()?.items.find((item) => item.label === "Help");
      const shortcutItem = helpMenu?.submenu?.items.find(
        (item) => item.label === "Keyboard Shortcuts…",
      );
      return shortcutItem
        ? { label: shortcutItem.label, accelerator: shortcutItem.accelerator }
        : null;
    });
    expect(helpShortcut).toEqual({
      label: "Keyboard Shortcuts…",
      accelerator: "CmdOrCtrl+/",
    });

    await page.keyboard.press("Meta+/");
    const modal = page.getByTestId("shortcut-help-modal");
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("heading", { name: "Keyboard Shortcuts" })).toBeVisible();
    await expect(modal.getByText("Add Text")).toBeVisible();
    await expect(modal.getByText("⌘⌥C")).toBeVisible();
    await closeModal(page, "shortcut-help-modal");

    await openPaletteAction(page, "keyboard-shortcuts", "keyboard shortcuts");
    await expect(page.getByTestId("shortcut-help-modal")).toBeVisible();
    await expect(page.getByText("Tool keys work")).toBeVisible();
    await closeModal(page, "shortcut-help-modal");
  });
});

test("click-through: sidebar, search, view mode, context menus, undo, and redo", async () => {
  await withApp(async (page) => {
    await page.getByTestId("sidebar-tab-outline").click();
    await expect(
      page.getByTestId("outline-panel").or(page.getByText("This PDF has no bookmarks.")).first(),
    ).toBeVisible();
    await page.getByTestId("sidebar-tab-pages").click();
    await expect(page.locator('[data-testid="thumb-button"]').first()).toBeVisible();

    await page.getByLabel("Search").click();
    await expect(page.getByPlaceholder("Find in document")).toBeVisible();
    await page.getByPlaceholder("Find in document").fill("WeavePDF");
    await page.getByTestId("toggle-replace").click();
    await expect(page.getByTestId("replace-input")).toBeVisible();
    await page.keyboard.press("Escape");

    const viewToggle = page.getByTestId("view-mode-toggle");
    await viewToggle.click();
    await expect(viewToggle).toHaveAttribute("title", /two-page spread/);
    await viewToggle.click();
    await expect(viewToggle).toHaveAttribute("title", /cover \+ spread/);
    await viewToggle.click();
    await expect(viewToggle).toHaveAttribute("title", /single page/);

    const beforeDup = await page.evaluate(() => window.__weavepdfTest__.getActiveTab()?.numPages ?? 0);
    await page.locator('[data-testid="thumb-button"]').first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Duplicate page" }).click();
    await expect
      .poll(() => page.evaluate(() => window.__weavepdfTest__.getActiveTab()?.numPages ?? 0))
      .toBe(beforeDup + 1);

    await page.locator('[data-testid="thumb-button"]').first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Set page label…" }).click();
    await expect(page.getByTestId("prompt-modal")).toBeVisible();
    await page.getByTestId("prompt-input").fill("QA-");
    await page.getByTestId("prompt-submit").click();
    await expect(page.getByTestId("prompt-modal")).toBeHidden();

    const layer = page.locator('[data-testid="interaction-layer"]').first();
    if ((await layer.count()) === 0) {
      await page.getByTestId("tool-rect").click();
    }
    const contextBox = await page.locator('[data-testid="interaction-layer"]').first().boundingBox();
    expect(contextBox).toBeTruthy();
    if (!contextBox) throw new Error("No page layer for context menu");
    await page.mouse.click(contextBox.x + 120, contextBox.y + 160, { button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Copy page text" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Redact region" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByTestId("tool-rotate-left").click();
    await expect(page.getByTestId("tool-undo")).toBeEnabled();
    await page.getByTestId("tool-undo").click();
    await expect(page.getByTestId("tool-redo")).toBeEnabled();
    await page.getByTestId("tool-redo").click();
    await expect(page.getByTestId("tool-undo")).toBeEnabled();
  });
});

test("click-through: feature keyboard shortcuts activate tools and document panels", async () => {
  await withApp(async (page) => {
    await page.keyboard.press("h");
    await expect(page.locator('[data-testid="interaction-layer"][data-tool="highlight"]').first()).toBeVisible();

    await page.keyboard.press("x");
    await expect(page.locator('[data-testid="interaction-layer"][data-tool="redact"]').first()).toBeVisible();

    await page.keyboard.press("r");
    await expect(page.locator('[data-testid="interaction-layer"][data-tool="rect"]').first()).toBeVisible();

    await page.keyboard.press("k");
    await expect(page.locator('[data-testid="interaction-layer"][data-tool="link"]').first()).toBeVisible();

    await page.keyboard.press("t");
    const textLayer = page.locator('[data-testid="interaction-layer"][data-tool="text"]').first();
    const box = await textLayer.boundingBox();
    expect(box).toBeTruthy();
    if (!box) throw new Error("No text shortcut layer");
    await page.mouse.click(box.x + 120, box.y + 150);
    await expect(page.getByTestId("text-prompt")).toBeVisible();
    await page.getByTestId("text-prompt-input").click();
    await page.keyboard.type("h");
    await expect(page.getByTestId("text-prompt-input")).toHaveValue("h");
    await page.keyboard.press("Escape");

    await page.keyboard.press("Meta+Alt+C");
    await closeModal(page, "compress-modal");

    await page.keyboard.press("Meta+I");
    await closeModal(page, "metadata-modal");

    await page.keyboard.press("Meta+Alt+L");
    await closeModal(page, "page-layout-modal");

    const viewToggle = page.getByTestId("view-mode-toggle");
    await page.keyboard.press("Meta+Alt+2");
    await expect(viewToggle).toHaveAttribute("title", /two-page spread/);
    await page.keyboard.press("Meta+Alt+3");
    await expect(viewToggle).toHaveAttribute("title", /cover \+ spread/);
    await page.keyboard.press("Meta+Alt+1");
    await expect(viewToggle).toHaveAttribute("title", /single page/);

    await expect(page.getByTestId("tool-highlight")).toHaveAttribute("title", /H/);
    await page.getByTestId("tool-highlight").hover();
    await expect(page.getByTestId("shortcut-tooltip")).toContainText("Highlight");
    await expect(page.getByTestId("shortcut-tooltip")).toContainText("H");

    await page.getByTestId("tool-compress").hover();
    await expect(page.getByTestId("shortcut-tooltip")).toContainText("Compress");
    await expect(page.getByTestId("shortcut-tooltip")).toContainText("⌘⌥C");

    await page.getByTestId("view-mode-toggle").hover();
    await expect(page.getByTestId("shortcut-tooltip")).toContainText("View");
    await expect(page.getByTestId("shortcut-tooltip")).toContainText("⌘⌥1/2/3");

    await page.keyboard.press("Meta+K");
    await page.getByTestId("palette-input").fill("highlight");
    await expect(
      page.locator('[data-testid="palette-item"][data-action-id="highlight"] kbd'),
    ).toHaveText("H");
    await page.keyboard.press("Escape");
  });
});
