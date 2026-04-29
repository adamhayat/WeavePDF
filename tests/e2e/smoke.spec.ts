import { test, expect } from "@playwright/test";
import { launchApp, openFixture, ensureFixturesExist } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

function tabByName(page: import("@playwright/test").Page, name: string) {
  return page.locator(`[data-testid="tab"][data-tab-name="${name}"]`);
}

function closeButton(page: import("@playwright/test").Page, name: string) {
  return page.locator(`[data-testid="tab-close"][data-tab-name="${name}"]`);
}

test("launches with DropZone empty state", async () => {
  const { app, page } = await launchApp();
  try {
    await expect(page.getByText("Drop a PDF to begin")).toBeVisible();
    await expect(page.getByRole("button", { name: /open file/i })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("command palette keeps unavailable commands discoverable", async () => {
  const { app, page } = await launchApp();
  try {
    await page.keyboard.press("Meta+k");
    await page.getByTestId("palette-input").fill("compress");
    const item = page.locator('[data-testid="palette-item"][data-action-id="compress"]');
    await expect(item).toBeVisible();
    await expect(item).toBeDisabled();
    await expect(item).toContainText("Open a PDF first");
  } finally {
    await app.close();
  }
});

test("exposes weavepdf API + platform", async () => {
  const { app, page } = await launchApp();
  try {
    const platform = await page.evaluate(() => window.weavepdf.platform);
    expect(platform).toBe("darwin");
    const hasApi = await page.evaluate(
      () =>
        typeof window.weavepdf.openFileDialog === "function" &&
        typeof window.weavepdf.readFile === "function" &&
        typeof window.weavepdf.getTheme === "function" &&
        typeof window.weavepdf.getPathForFile === "function",
    );
    expect(hasApi).toBe(true);
  } finally {
    await app.close();
  }
});

test("applies system theme via data-theme attribute", async () => {
  const { app, page } = await launchApp();
  try {
    const theme = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme"),
    );
    expect(theme === "light" || theme === "dark").toBe(true);
  } finally {
    await app.close();
  }
});

test("opens a PDF, renders sidebar + canvas + active tab", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");

    await expect(tabByName(page, "sample.pdf")).toBeVisible();
    await expect(page.getByTestId("sidebar-tab-pages")).toBeVisible();
    await expect(page.getByText("1 / 5")).toBeVisible();

    // At least 1 thumbnail canvas + 1 viewer page canvas.
    const canvasCount = await page.locator("canvas").count();
    expect(canvasCount).toBeGreaterThanOrEqual(2);

    // Text layer renders visible page title.
    await expect(page.getByText("Title Page").first()).toBeVisible();
  } finally {
    await app.close();
  }
});

test("\u2318F search finds expected match count", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await tabByName(page, "sample.pdf").waitFor({ timeout: 15_000 });

    await page.keyboard.press("Meta+f");
    const searchInput = page.getByPlaceholder(/find in document/i);
    await expect(searchInput).toBeVisible();
    await searchInput.fill("banana");

    await expect(page.getByText("1 of 2")).toBeVisible({ timeout: 15_000 });

    await searchInput.press("Enter");
    await expect(page.getByText("2 of 2")).toBeVisible();
    await searchInput.press("Shift+Enter");
    await expect(page.getByText("1 of 2")).toBeVisible();

    await searchInput.press("Escape");
    await expect(searchInput).not.toBeVisible();
  } finally {
    await app.close();
  }
});

test("multi-tab: open two PDFs, switch, close one", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await openFixture(page, "sample-short.pdf");

    const shortTab = tabByName(page, "sample-short.pdf");
    const longTab = tabByName(page, "sample.pdf");

    await expect(shortTab).toBeVisible();
    await expect(longTab).toBeVisible();
    await expect(shortTab).toHaveAttribute("data-active", "true");

    // Newly-opened short is single-page.
    await expect(page.getByText("1 / 1")).toBeVisible();

    // Switch to longer doc.
    await longTab.click();
    await expect(longTab).toHaveAttribute("data-active", "true");
    await expect(page.getByText("1 / 5")).toBeVisible();

    // Close the long doc tab.
    await closeButton(page, "sample.pdf").click({ force: true });
    await expect(longTab).toHaveCount(0);
    await expect(shortTab).toBeVisible();
  } finally {
    await app.close();
  }
});

test("closing the last tab returns to DropZone", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample-short.pdf");
    const tab = tabByName(page, "sample-short.pdf");
    await expect(tab).toBeVisible();
    await closeButton(page, "sample-short.pdf").click({ force: true });
    await expect(page.getByText("Drop a PDF to begin")).toBeVisible();
  } finally {
    await app.close();
  }
});
