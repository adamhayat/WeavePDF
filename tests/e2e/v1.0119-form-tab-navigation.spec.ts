// V1.0119 — Tab should jump from one fillable form field to the NEXT field.
//
// Adam: "When filling out a form like this, I should be able to jump from one
// fillable text to the next by clicking tab. That doesn't work."
//
// Root cause: each AcroForm text widget renders an "Aa ▸" format pill <button>
// in the DOM immediately after its <input>, inside the same wrapper (added in
// V1.0074 — AFTER the V1.0039 "Tab survives the async commit" fix). The pill is
// focusable, so pressing Tab from field A focused A's pill (a near-invisible,
// opacity-0 control) instead of field B. Two Tabs were needed to cross one
// field, and the intermediate stop looked like "Tab did nothing." Fix:
// tabIndex={-1} on the pill removes it from the keyboard tab order while
// keeping it clickable by mouse.

import { test, expect, type Page } from "@playwright/test";
import { launchApp, openFixture, ensureFixturesExist } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

async function activeInfo(page: Page): Promise<{ testid: string | null; label: string | null }> {
  return page.evaluate(() => {
    const el = document.activeElement;
    return {
      testid: el?.getAttribute("data-testid") ?? null,
      label: el?.getAttribute("aria-label") ?? null,
    };
  });
}

test("V1.0119: Tab moves from one form text field to the next (not the Aa pill)", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample-form.pdf");
    await expect(page.locator('[data-testid="acroform-layer"]')).toBeVisible();

    // sample-form.pdf has two text fields in reading order: "address" (top)
    // then "city" (below it).
    const address = page.locator('[data-testid="acroform-text"][aria-label="address"]');
    const city = page.locator('[data-testid="acroform-text"][aria-label="city"]');
    await expect(address).toBeVisible();
    await expect(city).toBeVisible();

    await address.focus();
    expect((await activeInfo(page)).label).toBe("address");

    await page.keyboard.press("Tab");

    // Must land on the NEXT text field — not on "address"'s format pill.
    const after = await activeInfo(page);
    expect(after.testid).toBe("acroform-text");
    expect(after.label).toBe("city");
  } finally {
    await app.close();
  }
});

test("V1.0119: Shift+Tab moves back to the previous form text field", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample-form.pdf");
    const city = page.locator('[data-testid="acroform-text"][aria-label="city"]');
    await city.focus();
    expect((await activeInfo(page)).label).toBe("city");

    await page.keyboard.press("Shift+Tab");

    const after = await activeInfo(page);
    expect(after.testid).toBe("acroform-text");
    expect(after.label).toBe("address");
  } finally {
    await app.close();
  }
});
