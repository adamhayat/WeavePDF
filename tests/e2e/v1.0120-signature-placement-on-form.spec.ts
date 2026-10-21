// V1.0120 — click-to-place gestures (signature, image, text, checkmark) must
// work on a form PDF.
//
// Adam: opened the signature modal, clicked OK, "then nothing happens, can't
// place down the signature." Root cause: the AcroFormLayer container is a
// full-page `absolute inset-0 z-[15]` div sitting ABOVE the z-10 interaction
// layer that actually handles placement clicks. With pointer-events on, it
// swallowed every click in the gaps between fields — so after OK armed
// tool="signature", the placement click hit this layer and did nothing. Fix:
// container is pointer-events-none (gap clicks fall through), each widget is
// pointer-events-auto (a click ON a field still fills it — V1.0076 intact).
//
// Signature placement needs a Keychain-stored signature, so this guards the
// SHARED root cause with the Keychain-free checkmark tool — it routes through
// the exact same z-10 interaction handler.

import { test, expect } from "@playwright/test";
import { launchApp, openFixture, ensureFixturesExist } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

test("V1.0120: a placement tool can drop in a gap on a form PDF (click not eaten)", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample-form.pdf");
    await expect(page.locator('[data-testid="acroform-layer"]')).toBeVisible();

    // Arm the checkmark tool (stand-in for the signature/image click-to-place
    // path — all route through the same interaction handler).
    await page.getByTestId("tool-checkmark").click();

    // Click a GAP well below the two fields (which sit near the page top).
    const box = await page.locator('[data-testid="acroform-layer"]').boundingBox();
    expect(box).toBeTruthy();
    if (!box) return;
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.6);

    // The checkmark lands as a pending shape. Pre-V1.0120 the form layer ate
    // the click and nothing happened.
    await expect(page.locator('[data-testid="pending-shape"]')).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test("V1.0120: clicking a field still fills it under an active tool (V1.0076 intact)", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample-form.pdf");
    await page.getByTestId("tool-checkmark").click();

    // Click ON the address field — the widget must win over the placement
    // tool: the field takes focus and NO checkmark is placed on top of it.
    const address = page.locator('[data-testid="acroform-text"][aria-label="address"]');
    await address.click();

    const focusedLabel = await page.evaluate(
      () => document.activeElement?.getAttribute("aria-label") ?? null,
    );
    expect(focusedLabel).toBe("address");
    await expect(page.locator('[data-testid="pending-shape"]')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
