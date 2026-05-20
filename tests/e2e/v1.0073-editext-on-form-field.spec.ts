// V1.0073 — Edit Text on an AcroForm widget value.
//
// Adam's screenshot showed a form-field value ("Suite 700, Toronto, ON
// M2N 5X5") with no format bar. Form-fill mode never had one. Now,
// clicking a form-field value with the Edit tool active converts it to
// a pending WeavePDF text overlay — whiteout + editable, full format
// bar.

import { test, expect } from "@playwright/test";
import { launchApp, openFixture, ensureFixturesExist } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

test("V1.0073: Edit Text on a form-field value spawns a pending text overlay", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample-form.pdf");
    // The AcroFormLayer should render the field.
    await expect(page.locator('[data-testid="acroform-layer"]')).toBeVisible();

    // Switch to Edit Text mode.
    await page.getByTestId("tool-edit-text").click();

    // The form-field overlay turns into a click-target for Edit Text.
    const target = page.locator('[data-testid="acroform-edit-text-target"]').first();
    await expect(target).toBeVisible();
    await target.click();

    // A pending text overlay appears, in edit mode, pre-filled with the
    // form's value.
    await expect(page.locator('[data-pending-element="text"]')).toHaveCount(1);
    const input = page.getByTestId("pending-text-input");
    await expect(input).toBeVisible({ timeout: 5_000 });
    await expect(input).toHaveValue("Suite 700, Toronto, ON M2N 5X5");

    // Whiteout layer covers the original baked widget appearance.
    await expect(
      page.locator('[data-testid="pending-text-whiteout"]'),
    ).toHaveCount(1);

    // The format bar is available — type-in font size input is present.
    // Commit the edit first (blur the textarea) so the size input is
    // visible (it only shows in non-editing read mode).
    await input.fill("Suite 800, Toronto, ON L1L 1L1");
    await input.press("Escape");
    await page.locator('[data-pending-element="text"]').first().click();
    await expect(page.getByTestId("font-size-input")).toBeVisible();
  } finally {
    await app.close();
  }
});
