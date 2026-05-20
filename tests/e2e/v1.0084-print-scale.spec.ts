// V1.0085 — Print modal: Scale becomes an always-visible slider (10-400%),
// Layout absorbs "Fit all on one sheet" with a dynamic grid (no 9-cap).
//
// V1.0084's approach was wrong on three counts:
//   - "Shrink to one sheet" was a Layout decision masquerading as Scale.
//   - Custom percentage was nested behind a dropdown (Adam: "should always
//     be there").
//   - Custom % used a text input ("doesn't work well for it" → use a
//     slider).
//
// V1.0085 separates the two axes (mirrors macOS Preview / Chrome / Word):
// Layout picks "how many source pages tile onto one sheet" — now with a
// new "fit" option that computes ceil(sqrt(n))×ceil(n/cols) dynamically
// so 30 pages actually fits on one sheet. Scale picks "how big each page
// prints within its tile" — always visible slider + numeric readout.

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

test("V1.0085: Scale slider always visible, defaults to 100%", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    const modal = await openPrintModal(page);
    const slider = modal.getByTestId("print-scale-slider");
    const number = modal.getByTestId("print-scale-input");

    // Both visible at modal open — not nested behind a "Custom…" option.
    await expect(slider).toBeVisible();
    await expect(number).toBeVisible();
    await expect(slider).toHaveValue("100");
    await expect(number).toHaveValue("100");

    // Slider drives the number readout. React's controlled <input>
    // only respects value changes that go through the React-internal
    // native setter — bypass with the standard React-test trick.
    await slider.evaluate((el: HTMLInputElement) => {
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter?.call(el, "75");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(number).toHaveValue("75");

    // And vice-versa: typing in the number drives the slider.
    await number.fill("125");
    await number.blur();
    await expect(slider).toHaveValue("125");

    // Clamp: 500 → 400.
    await number.fill("500");
    await number.blur();
    await expect(number).toHaveValue("400");
  } finally {
    await app.close();
  }
});

test("V1.0085: 'Fit all on one sheet' is a Layout option, not a Scale option", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    const modal = await openPrintModal(page);
    const layout = modal.getByTestId("print-layout-select");
    await layout.selectOption({ value: "fit" });

    // Scale slider + numeric input both disable (auto-fit takes over).
    await expect(modal.getByTestId("print-scale-slider")).toBeDisabled({ timeout: 2_000 });
    await expect(modal.getByTestId("print-scale-input")).toBeDisabled();

    // Preview renders without error.
    await expect(modal.getByText(/Preview error/i)).toBeHidden({ timeout: 15_000 });
    await expect(modal.getByTestId("print-preview-pane").locator("canvas")).toBeVisible({ timeout: 15_000 });

    // Switching back to "1" re-enables Scale.
    await layout.selectOption({ value: "1" });
    await expect(modal.getByTestId("print-scale-slider")).toBeEnabled();
    await expect(modal.getByTestId("print-scale-input")).toBeEnabled();
  } finally {
    await app.close();
  }
});

test("V1.0085: 'Fit all on one sheet' produces ONE preview sheet for the 5-page sample", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    const modal = await openPrintModal(page);
    await modal.getByTestId("print-layout-select").selectOption({ value: "fit" });

    // Wait for preview rebuild.
    await expect(modal.getByText(/Preview error/i)).toBeHidden({ timeout: 15_000 });
    await expect(modal.getByTestId("print-preview-pane").locator("canvas")).toBeVisible({ timeout: 15_000 });

    // The modal's sheet pager shows total sheets. With "Fit all on one
    // sheet" + a 5-page source, output must be EXACTLY 1 sheet — that's
    // the whole point. Pre-V1.0085 the 9-cap meant 5 pages → 6-up which
    // happened to be 1 sheet, but a 30-page doc would've been 4 sheets.
    // Locator covers either "Sheet 1 of 1" or pageless single-sheet UI.
    const sheetCount = await page.evaluate(() => {
      // Look for any "X of Y" text inside the modal; capture the Y.
      const modal = document.querySelector('[data-testid="print-preview-modal"]');
      if (!modal) return null;
      const text = modal.textContent ?? "";
      const m = /Sheet\s+\d+\s+of\s+(\d+)/i.exec(text);
      if (m) return Number(m[1]);
      // Single sheet UI may not show the pager. If no pager AND a canvas
      // is rendered, treat as 1.
      const hasCanvas = modal.querySelector('[data-testid="print-preview-pane"] canvas');
      return hasCanvas ? 1 : null;
    });
    expect(sheetCount).toBe(1);
  } finally {
    await app.close();
  }
});
