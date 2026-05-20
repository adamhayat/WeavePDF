// V1.0081 — right-click "Align to page" centers on the INNER rendered
// text bounds, not the outer wrap-frame widthPt. Adam: "The align
// options in right click, work based on the outer box. For example,
// align centre but based on the outer box. We should make the
// alignment based on the inner box because that's the true size."

import { test, expect } from "@playwright/test";
import { launchApp, openFixture, ensureFixturesExist } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

test("V1.0081: Center horizontally centers on the visible text, not the wrap frame", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await expect(page.getByText("1 / 5")).toBeVisible();

    // Place a Text overlay near the LEFT margin so the default widthPt
    // (= rightBound − clickX) is much wider than the rendered glyphs.
    // That gap is what the bug was about — the wrap frame is wide, the
    // text is short, "center" placed the FRAME center on pageW/2.
    await page.getByTestId("tool-text").click();
    const pageCanvas = page.locator('[data-page="1"]').first();
    const pageBox = await pageCanvas.boundingBox();
    if (!pageBox) throw new Error("page box missing");
    await page.mouse.click(pageBox.x + 60, pageBox.y + 240);

    const promptInput = page.getByTestId("text-prompt-input");
    await expect(promptInput).toBeVisible({ timeout: 5_000 });
    await promptInput.fill("Short");
    await promptInput.press("Enter");

    const pendingText = page.locator('[data-pending-element="text"]').first();
    await expect(pendingText).toBeVisible();
    await pendingText.click();

    const wrapper = pendingText.locator(":scope > div").last();
    const innerCssW = await wrapper.evaluate((el) => {
      const cs = window.getComputedStyle(el as HTMLElement);
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padR = parseFloat(cs.paddingRight) || 0;
      const borL = parseFloat(cs.borderLeftWidth) || 0;
      const borR = parseFloat(cs.borderRightWidth) || 0;
      return (el as HTMLElement).getBoundingClientRect().width - padL - padR - borL - borR;
    });

    // Right-click the overlay → Center horizontally.
    await pendingText.click({ button: "right" });
    await page.getByText("Center horizontally").click();

    // After centering, the wrapper's visible HORIZONTAL center should
    // sit at the page's horizontal center. We compare in CSS pixels —
    // both numbers come from the same DOM and the page container, so
    // zoom cancels out.
    const center = await page.evaluate(({ pageSel, wrapSel }) => {
      const pageEl = document.querySelector(pageSel) as HTMLElement | null;
      const wrapEl = document.querySelector(wrapSel) as HTMLElement | null;
      if (!pageEl || !wrapEl) return null;
      const pageRect = pageEl.getBoundingClientRect();
      const wrapRect = wrapEl.getBoundingClientRect();
      const cs = window.getComputedStyle(wrapEl);
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padR = parseFloat(cs.paddingRight) || 0;
      const borL = parseFloat(cs.borderLeftWidth) || 0;
      const borR = parseFloat(cs.borderRightWidth) || 0;
      const innerLeft = wrapRect.left + padL + borL;
      const innerW = wrapRect.width - padL - padR - borL - borR;
      const innerCenter = innerLeft + innerW / 2;
      const pageCenter = pageRect.left + pageRect.width / 2;
      return { pageCenter, innerCenter, innerW };
    }, { pageSel: '[data-page="1"]', wrapSel: '[data-pending-element="text"] > div:last-of-type' });

    expect(center).not.toBeNull();
    if (!center) return;
    // Visible inner center should be within a few px of the page's
    // horizontal center. Pre-V1.0081 it landed off by ~half of
    // (widthPt − rendered width) at zoom.
    expect(Math.abs(center.innerCenter - center.pageCenter)).toBeLessThanOrEqual(4);
    // Sanity: the inner width really is much narrower than the wrap
    // frame, otherwise the test wouldn't be exercising the bug.
    expect(innerCssW).toBeLessThan(160);
  } finally {
    await app.close();
  }
});
