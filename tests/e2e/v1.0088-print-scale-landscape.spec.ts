// V1.0088 / V1.0089 — Print 1-up path. V1.0088 made it auto-fit +
// auto-rotate unconditionally; Adam pushed back: portrait at 100%
// should render the source as-is, NOT auto-zoom the content. V1.0089
// gates the auto-fit behavior behind an explicit "Full page" toggle
// (off by default). When ON: V1.0088 behavior (auto-detect content
// bbox + rotate to match sheet + scale to fill). When OFF: legacy
// V1.0085 behavior (scalePageContent for slider, fitToPaper only when
// paper/orientation differ from Letter portrait).

import { test, expect } from "@playwright/test";
import { launchApp, openFixture, ensureFixturesExist } from "./helpers";
import type { Page } from "@playwright/test";

test.beforeAll(() => {
  ensureFixturesExist();
});

async function openPrintModal(page: Page) {
  await page.keyboard.press("Meta+K");
  await page.waitForTimeout(150);
  await page.keyboard.type("print");
  await page.waitForTimeout(200);
  await page.getByText(/^Print…$/).first().click();
  const modal = page.getByTestId("print-preview-modal");
  await expect(modal).toBeVisible({ timeout: 5_000 });
  return modal;
}

test("V1.0089: Full page toggle defaults to Off + can be flipped On", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    const modal = await openPrintModal(page);
    // The Full page row renders two OrientationButtons labelled On / Off.
    // Off should be active by default (no Full page → render as-is).
    const onBtn = modal.getByRole("button", { name: "On", exact: true });
    const offBtn = modal.getByRole("button", { name: "Off", exact: true });
    await expect(onBtn).toBeVisible();
    await expect(offBtn).toBeVisible();
    // The active button uses an accent-bordered style — we can't read
    // that reliably without a testid, but the preview behavior is the
    // real contract: at 100% scale + portrait + Letter + Off, the
    // bytes don't go through scaleToFitForPrint (auto-fit). We test
    // by toggling and verifying the preview canvas changes.
    await expect(modal.getByText(/Preview error/i)).toBeHidden({ timeout: 15_000 });
    await expect(modal.getByTestId("print-preview-pane").locator("canvas")).toBeVisible({ timeout: 15_000 });

    const canvasOff = await modal
      .getByTestId("print-preview-pane")
      .locator("canvas")
      .first()
      .evaluate((c) => (c as HTMLCanvasElement).toDataURL().length);

    await onBtn.click();
    await page.waitForTimeout(800);
    const canvasOn = await modal
      .getByTestId("print-preview-pane")
      .locator("canvas")
      .first()
      .evaluate((c) => (c as HTMLCanvasElement).toDataURL().length);

    // Off vs On produces different output: Off renders as-is, On
    // auto-fits via scaleToFitForPrint. Different bytes → different
    // rasterized canvas → different data URL length (stable proxy
    // for "did the preview rebuild change anything").
    expect(canvasOff).not.toBe(canvasOn);
  } finally {
    await app.close();
  }
});

test("V1.0089: Full page Off + landscape renders without error", async () => {
  // Regression — V1.0088 introduced the scaleToFitForPrint helper.
  // V1.0089 default (Full page Off + landscape) takes the legacy
  // fitToPaper path. Confirm that path still produces a preview.
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    const modal = await openPrintModal(page);
    await modal.getByText("Landscape").first().click();
    await expect(modal.getByText(/Preview error/i)).toBeHidden({ timeout: 15_000 });
    await expect(modal.getByTestId("print-preview-pane").locator("canvas")).toBeVisible({ timeout: 15_000 });
  } finally {
    await app.close();
  }
});

test("V1.0089: Full page On + landscape activates scaleToFitForPrint without error", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    const modal = await openPrintModal(page);
    await modal.getByText("Landscape").first().click();
    await modal.getByRole("button", { name: "On", exact: true }).click();
    await expect(modal.getByText(/Preview error/i)).toBeHidden({ timeout: 15_000 });
    await expect(modal.getByTestId("print-preview-pane").locator("canvas")).toBeVisible({ timeout: 15_000 });
  } finally {
    await app.close();
  }
});

test("V1.0089: Layout=fit disables both Full page buttons", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    const modal = await openPrintModal(page);
    await modal.getByTestId("print-layout-select").selectOption({ value: "fit" });
    await expect(modal.getByRole("button", { name: "On", exact: true })).toBeDisabled();
    await expect(modal.getByRole("button", { name: "Off", exact: true })).toBeDisabled();
  } finally {
    await app.close();
  }
});
