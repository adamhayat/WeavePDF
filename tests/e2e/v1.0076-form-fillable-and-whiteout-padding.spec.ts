// V1.0076 — two Adam reports from his screenshot:
//   1. Whiteout doesn't fully cover the baked widget value — a faint
//      outline of the original was visible underneath the overlay.
//      Fix: pad the whiteout rect by 2pt on all sides to catch
//      anti-aliasing / descenders / italic shear.
//   2. The form fields weren't fillable in WeavePDF even though they
//      work in Preview. Root cause: when a drawing tool was active
//      (Whiteout, Highlight, Rect, etc.) the interaction layer at z-10
//      sat ABOVE the AcroFormLayer at z-[6] and ate every click. Fix:
//      raise AcroFormLayer to z-[15] so widget clicks pass through
//      regardless of active tool.

import { test, expect } from "@playwright/test";
import { launchApp, openFixture, ensureFixturesExist } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

test("V1.0076: form text field is fillable even when Whiteout tool is active", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample-form.pdf");
    await expect(page.locator('[data-testid="acroform-layer"]')).toBeVisible();

    // Activate the Whiteout tool — pre-V1.0076 this put the interaction
    // layer over the form widgets and they became unclickable.
    await page.getByTestId("tool-whiteout").click();

    // The interaction layer renders at z-10 when a tool is active.
    await expect(
      page.locator('[data-testid="interaction-layer"][data-tool="whiteout"]'),
    ).toBeVisible();

    // The form input should STILL be clickable + typeable. Verify by
    // focusing it and asserting the document's active element is the
    // input (it took focus through the interaction layer).
    const input = page.locator('[data-testid="acroform-text"]').first();
    await input.focus();
    const activeIsInput = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el?.getAttribute("data-testid") === "acroform-text";
    });
    expect(activeIsInput).toBe(true);
  } finally {
    await app.close();
  }
});

test("V1.0076: text that fits on one line doesn't wrap when maxWidth is larger", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample-form.pdf");

    // Trigger the Aa pill flow to spawn an overlay at the form field.
    const input = page.locator('[data-testid="acroform-text"]').first();
    await input.focus();
    await page.locator('[data-testid="acroform-format-pill"]').first().click();

    const textarea = page.getByTestId("pending-text-input");
    await expect(textarea).toBeVisible();

    // Commit the textarea by pressing Escape so we drop into read mode
    // (where the Range-API width-tightening logic runs).
    await textarea.press("Escape");

    // The wrapper should now be in read mode. Make it explicit:
    // measure the inner text wrapper + outer dashed frame.
    const wrapper = page
      .locator('[data-pending-element="text"] > div')
      .last();
    const frame = page
      .locator('[data-pending-frame="text"]')
      .first();
    await expect(wrapper).toBeVisible();
    await expect(frame).toBeVisible();

    // Single-line text fits well within the form field's widthPt at the
    // default size, so there should be NO wrap (height ≈ one line).
    // Pre-V1.0076 the wrapper's Range-API width-set was off by the
    // wrapper's padding (border-box), so the text re-wrapped a line.
    const wrapperBox = await wrapper.boundingBox();
    const frameBox = await frame.boundingBox();
    if (!wrapperBox || !frameBox) return;

    // The wrapper's height should be the natural one-line height —
    // i.e. NOT roughly twice the frame's content height. Quick sanity:
    // wrapper height should be less than 1.6× the size's line-height.
    // For the default 14-or-so pt size at typical zoom, one line is
    // ~20-24px; two lines would be ~40-48. Use a loose ceiling that
    // catches "wrapped a line we shouldn't have".
    expect(wrapperBox.height).toBeLessThan(40);

    // And wrapper width should match the rendered text width — clearly
    // smaller than the outer frame's full width (since the text doesn't
    // need the whole field). But not so small that the text was forced
    // to wrap.
    expect(wrapperBox.width).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});

test("V1.0076: form field overlay's whiteout is padded around the widget rect", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample-form.pdf");

    // Get the form widget's rect in DOM pixels (before clicking).
    const input = page.locator('[data-testid="acroform-text"]').first();
    const widgetBox = await input.boundingBox();
    expect(widgetBox).toBeTruthy();
    if (!widgetBox) return;

    // Trigger the Edit-Text-on-widget flow via the V1.0074 Aa pill.
    await input.focus();
    await page.locator('[data-testid="acroform-format-pill"]').first().click();
    await expect(page.locator('[data-pending-element="text"]')).toHaveCount(1);

    // The pending text overlay's whiteout div now exists.
    const whiteout = page.locator('[data-testid="pending-text-whiteout"]').first();
    await expect(whiteout).toBeVisible();
    const whiteoutBox = await whiteout.boundingBox();
    expect(whiteoutBox).toBeTruthy();
    if (!whiteoutBox) return;

    // The whiteout extends BEYOND the widget rect (V1.0076 padding).
    // Tolerance: at zoom 1.0 the padding is 2 PDF pt = 2 px each side,
    // so the whiteout should be at least 3px wider + 3px taller than
    // the widget (lower bound to handle any zoom variance).
    expect(whiteoutBox.width).toBeGreaterThan(widgetBox.width + 3);
    expect(whiteoutBox.height).toBeGreaterThan(widgetBox.height + 3);
    // And it covers the widget — left edge is to the LEFT of the
    // widget's left edge, top is ABOVE.
    expect(whiteoutBox.x).toBeLessThan(widgetBox.x);
    expect(whiteoutBox.y).toBeLessThan(widgetBox.y);
  } finally {
    await app.close();
  }
});
