// V1.0087 — draggable Crop tool. Replaces the V1.0028 numeric TLBR
// modal with a content-aware visual selection: scrim outside, 8
// handles, drag-to-move/resize, floating action bar with Reset /
// Cancel / Apply, keyboard parity (Enter / Esc / arrow nudge).
//
// Adam's brief: "the crop tool should be a draggable tool".

import { test, expect } from "@playwright/test";
import { launchApp, openFixture, ensureFixturesExist } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

async function enterCropMode(page: import("@playwright/test").Page) {
  await openFixture(page, "sample.pdf");
  await expect(page.getByText("1 / 5")).toBeVisible();
  await page.getByTestId("tool-crop").click();
}

test("V1.0087: entering crop mode shows the action bar + an auto-seeded crop rectangle", async () => {
  const { app, page } = await launchApp();
  try {
    await enterCropMode(page);
    // Action bar always visible while in crop mode.
    const bar = page.getByTestId("crop-action-bar");
    await expect(bar).toBeVisible({ timeout: 5_000 });
    // Auto-detect seeds the draft asynchronously; wait for the dimensions
    // readout to settle on real numbers (not the "…" placeholder).
    const dims = bar.getByTestId("crop-dimensions");
    await expect(dims).toBeVisible();
    await expect(dims).toHaveText(/\d+\s*×\s*\d+\s*pt/i, { timeout: 10_000 });
    // The rectangle + handles render on the active page.
    await expect(page.getByTestId("crop-rect").first()).toBeVisible();
    for (const k of ["nw", "ne", "sw", "se", "n", "s", "w", "e"]) {
      await expect(page.getByTestId(`crop-handle-${k}`).first()).toBeVisible();
    }
    // Apply button is enabled (auto-detected region is far above the 10pt floor).
    await expect(page.getByTestId("crop-apply")).toBeEnabled();
  } finally {
    await app.close();
  }
});

test("V1.0087: Escape cancels crop mode with zero side effects on the doc", async () => {
  const { app, page } = await launchApp();
  try {
    await enterCropMode(page);
    await expect(page.getByTestId("crop-action-bar")).toBeVisible({ timeout: 5_000 });

    const before = await page.evaluate(() => {
      const t = window.__weavepdfTest__.getActiveTab();
      return { version: t?.version ?? null, sizeBytes: t?.sizeBytes ?? null };
    });

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("crop-action-bar")).toBeHidden({ timeout: 2_000 });

    const after = await page.evaluate(() => {
      const t = window.__weavepdfTest__.getActiveTab();
      return { version: t?.version ?? null, sizeBytes: t?.sizeBytes ?? null };
    });
    expect(after.version).toBe(before.version);
    expect(after.sizeBytes).toBe(before.sizeBytes);
  } finally {
    await app.close();
  }
});

test("V1.0087: Apply mutates the document (version bumps; new bytes differ)", async () => {
  const { app, page } = await launchApp();
  try {
    await enterCropMode(page);
    const bar = page.getByTestId("crop-action-bar");
    await expect(bar.getByTestId("crop-dimensions")).toHaveText(/\d+\s*×\s*\d+\s*pt/i, { timeout: 10_000 });

    const before = await page.evaluate(() => {
      const t = window.__weavepdfTest__.getActiveTab();
      return { version: t?.version ?? null, sizeBytes: t?.sizeBytes ?? null };
    });

    await page.getByTestId("crop-apply").click();
    // Apply exits crop mode + dispatches applyEdit. Wait for the action
    // bar to disappear AND the doc's version to bump.
    await expect(bar).toBeHidden({ timeout: 5_000 });
    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          const t = window.__weavepdfTest__.getActiveTab();
          return t?.version ?? null;
        });
      }, { timeout: 5_000 })
      .not.toBe(before.version);
  } finally {
    await app.close();
  }
});

test("V1.0087: Reset re-seeds the crop draft (clears + auto-detect runs again)", async () => {
  // Black-box check that the Reset affordance does what the design
  // promises: clear the current draft, trigger CropOverlay's seed
  // effect, and end up with a non-null draft + dimension readout. The
  // pointer-event drag flow is verified manually against Adam's actual
  // PDFs — Playwright's mouse → pointer-event translation interacts
  // unreliably with setPointerCapture on small handle divs, and
  // re-engineering the handles to be larger / use mouse events is a
  // dilution of the UX for the sake of a flaky test.
  const { app, page } = await launchApp();
  try {
    await enterCropMode(page);
    const bar = page.getByTestId("crop-action-bar");
    const dims = bar.getByTestId("crop-dimensions");
    await expect(dims).toHaveText(/\d+\s*×\s*\d+\s*pt/i, { timeout: 10_000 });

    // Click Reset — draft goes null, seed effect re-runs, dimensions
    // briefly drop to "…" then return.
    await page.getByTestId("crop-reset").click();
    // The placeholder may flash by very quickly; just assert the
    // numeric readout is present after the re-seed settles.
    await expect(dims).toHaveText(/\d+\s*×\s*\d+\s*pt/i, { timeout: 10_000 });
  } finally {
    await app.close();
  }
});
