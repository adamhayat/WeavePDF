// V1.0075 — verifies the EXACT user flow Adam reported broken in
// V1.0074:
//   1. Open a PDF with a filled-in AcroForm text field.
//   2. Focus the field (NOT in Edit Text mode).
//   3. Click the "Aa ▸" pill.
//   4. Format bar MUST be visible (font size input + B / I / alignment
//      buttons), even though the spawned pending text overlay is in
//      EDITING mode (textarea active).
//   5. Each format-bar control MUST function while the textarea is
//      focused — clicking ± / B / I does NOT close the editor.
//
// Pre-V1.0075 the format bar was buried inside the read-mode branch of
// PendingTextLayer and only appeared AFTER the textarea blurred.

import { test, expect } from "@playwright/test";
import { launchApp, openFixture, ensureFixturesExist } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

test("V1.0075: Aa pill → format bar visible immediately (textarea still active)", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample-form.pdf");
    await expect(page.locator('[data-testid="acroform-layer"]')).toBeVisible();

    // Focus the form field (NOT in Edit Text mode).
    const input = page.locator('[data-testid="acroform-text"]').first();
    await input.focus();

    // Click the format pill.
    const pill = page.locator('[data-testid="acroform-format-pill"]').first();
    await expect(pill).toBeVisible();
    await pill.click();

    // A pending text overlay spawns.
    await expect(page.locator('[data-pending-element="text"]')).toHaveCount(1);

    // The textarea is open (overlay is in editing mode).
    const textarea = page.getByTestId("pending-text-input");
    await expect(textarea).toBeVisible({ timeout: 5_000 });
    await expect(textarea).toHaveValue("Suite 700, Toronto, ON M2N 5X5");

    // CRITICAL: the format bar MUST be visible right now, even though
    // the overlay is in editing mode. Pre-V1.0075 it was hidden until
    // the textarea blurred — that's the bug Adam reported.
    const formatBar = page.locator('[data-testid="pending-text-format-bar"]').first();
    await expect(formatBar).toBeVisible({ timeout: 2_000 });

    // The format bar contains:
    //  - a typeable font-size input
    //  - bold + italic buttons
    //  - alignment buttons (wrap-mode overlay, so all 4 align buttons
    //    are present)
    await expect(page.getByTestId("font-size-input")).toBeVisible();
    await expect(page.getByTestId("format-bar-bold")).toBeVisible();
    await expect(page.getByTestId("format-bar-italic")).toBeVisible();
    await expect(
      page.locator('[data-pending-element="text"] [data-align="center"]'),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test("V1.0075: clicking Bold while textarea is active toggles bold WITHOUT closing the editor", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample-form.pdf");
    const input = page.locator('[data-testid="acroform-text"]').first();
    await input.focus();
    await page.locator('[data-testid="acroform-format-pill"]').first().click();
    const textarea = page.getByTestId("pending-text-input");
    await expect(textarea).toBeVisible();

    // Click Bold while the textarea is still open.
    const boldBtn = page.getByTestId("format-bar-bold");
    await boldBtn.click();

    // Textarea is STILL visible (the format bar didn't blur it).
    await expect(textarea).toBeVisible();

    // The bold style applied to the textarea's rendered text.
    await expect(textarea).toHaveCSS("font-weight", "700");

    // Click Bold again to toggle off — still works mid-edit.
    await boldBtn.click();
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveCSS("font-weight", "400");
  } finally {
    await app.close();
  }
});

test("V1.0075: font-size input commits the text edit, applies new size, format bar stays", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample-form.pdf");
    const input = page.locator('[data-testid="acroform-text"]').first();
    await input.focus();
    await page.locator('[data-testid="acroform-format-pill"]').first().click();
    const textarea = page.getByTestId("pending-text-input");
    await expect(textarea).toBeVisible();

    const before = await textarea.evaluate(
      (el) => parseFloat(getComputedStyle(el).fontSize),
    );

    // Type a new font size in the format bar's input. Clicking the
    // size input transfers focus to it — the textarea commits + closes,
    // and the overlay transitions to read mode. Selection persists, so
    // the format bar stays visible above the now-larger text.
    const fontInput = page.getByTestId("font-size-input");
    await fontInput.click();
    await fontInput.fill("28");
    await fontInput.press("Enter");

    // The text wrapper (read mode) now shows the new size.
    const wrapper = page
      .locator('[data-pending-element="text"] > div')
      .last();
    await expect(wrapper).toBeVisible();
    const after = await wrapper.evaluate(
      (el) => parseFloat(getComputedStyle(el).fontSize),
    );
    expect(after).toBeGreaterThan(before);

    // CRITICAL: format bar STILL visible after the size change (selection
    // persists across edit-mode commit — pre-V1.0075 the bar would
    // disappear because commitEdit cleared selection).
    await expect(
      page.locator('[data-testid="pending-text-format-bar"]'),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});
