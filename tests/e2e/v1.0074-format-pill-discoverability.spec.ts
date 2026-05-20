// V1.0074 — discoverability: format-bar editing on form fields without
// having to click Edit Text first.
//
// Adam: "i dont see editing options for the highlighted eidited text, do
//        you?" — he was in Margins mode, not Edit, so the V1.0073 path
//        didn't kick in. A small "Aa ▸" pill now sits above each focused
//        form field; clicking it spawns the same pending text overlay
//        the V1.0073 click-target would, regardless of the active tool.

import { test, expect } from "@playwright/test";
import { launchApp, openFixture, ensureFixturesExist } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

test("V1.0074: format pill on a form field spawns a pending text overlay", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample-form.pdf");
    await expect(page.locator('[data-testid="acroform-layer"]')).toBeVisible();

    // Focus the form field (NOT in Edit Text mode — we're testing
    // discoverability from any tool mode).
    const input = page.locator('[data-testid="acroform-text"]').first();
    await input.focus();

    // The format pill should now be visible (group-focus-within reveals it).
    const pill = page.locator('[data-testid="acroform-format-pill"]').first();
    await expect(pill).toBeVisible();

    // Click the pill → spawns a pending text overlay, pre-filled with
    // the field's value.
    await pill.click();
    await expect(page.locator('[data-pending-element="text"]')).toHaveCount(1);

    const promptInput = page.getByTestId("pending-text-input");
    await expect(promptInput).toBeVisible({ timeout: 5_000 });
    await expect(promptInput).toHaveValue("Suite 700, Toronto, ON M2N 5X5");

    // Whiteout covers the baked widget appearance.
    await expect(
      page.locator('[data-testid="pending-text-whiteout"]'),
    ).toHaveCount(1);
  } finally {
    await app.close();
  }
});
