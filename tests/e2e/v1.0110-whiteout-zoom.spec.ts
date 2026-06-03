// V1.0110 — three Adam reports landed together:
//   1. "you can still see some text faded after whiting out, it should
//      be totally white" — PendingShapeLayer painted whiteout at
//      rgba(255,255,255,0.95) so the canvas-rendered glyphs bled
//      through. Bumped to fully opaque rgb(255,255,255).
//   2. "we should be able to add a text element over a whiteout
//      element" — the pending shape's z-20 wrapper stopped propagation
//      on every pointerdown, so picking the Text tool and clicking on
//      a whiteout selected the whiteout instead. PendingShapeLayer now
//      sets `pointer-events: none` on the wrapper whenever a creation
//      tool is active so the click falls through to the interaction
//      overlay underneath.
//   3. "when doing CMD+ to zoom in, it moves you from your view" —
//      Viewer's `useLayoutEffect` now rescales scrollLeft/scrollTop by
//      the zoom ratio so the viewport-center content point stays put
//      across zoom changes.

import { test, expect } from "@playwright/test";
import { launchApp, openFixture, ensureFixturesExist } from "./helpers";

test.beforeAll(() => {
  ensureFixturesExist();
});

async function dragWhiteoutOnPage(
  page: import("@playwright/test").Page,
  fromOffsetX: number,
  fromOffsetY: number,
  toOffsetX: number,
  toOffsetY: number,
): Promise<void> {
  await page.getByTestId("tool-whiteout").click();
  const layer = page
    .locator('[data-testid="interaction-layer"][data-tool="whiteout"]')
    .first();
  const box = await layer.boundingBox();
  if (!box) throw new Error("Whiteout interaction layer has no bounding box");
  await page.mouse.move(box.x + fromOffsetX, box.y + fromOffsetY);
  await page.mouse.down();
  await page.mouse.move(box.x + toOffsetX, box.y + toOffsetY, { steps: 10 });
  await page.mouse.up();
}

test("V1.0110: whiteout pending overlay is fully opaque", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await dragWhiteoutOnPage(page, 80, 110, 240, 170);

    const shape = page
      .locator('[data-testid="pending-shape"][data-shape-kind="whiteout"]')
      .first();
    await expect(shape).toBeVisible();

    // The visible fill is on the inner child div (the wrapper's children
    // is what gets the background). The PendingShapeLayer renders fill on
    // the FIRST child of the shape wrapper.
    const bg = await shape
      .locator(":scope > div")
      .first()
      .evaluate((el) => window.getComputedStyle(el).backgroundColor);

    // Pre-V1.0110: rgba(255, 255, 255, 0.95). Post-V1.0110: rgb(255, 255, 255).
    // computed style normalizes fully-opaque colors to `rgb(...)` form.
    expect(bg.replace(/\s+/g, "")).toBe("rgb(255,255,255)");
  } finally {
    await app.close();
  }
});

test("V1.0110: Text tool click passes through a pending whiteout shape", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await dragWhiteoutOnPage(page, 80, 110, 260, 180);

    const shape = page
      .locator('[data-testid="pending-shape"][data-shape-kind="whiteout"]')
      .first();
    await expect(shape).toBeVisible();
    const shapeBox = await shape.boundingBox();
    if (!shapeBox) throw new Error("Whiteout shape has no bounding box");

    // Activate the Text tool, then click in the middle of the whiteout.
    // Pre-V1.0110 the click selected the shape (no text prompt). Post-
    // V1.0110 the whiteout's wrapper is pointer-events: none while a
    // creation tool is active, so the click reaches the interaction
    // layer and opens the inline text prompt.
    await page.getByTestId("tool-text").click();
    await page.mouse.click(
      shapeBox.x + shapeBox.width / 2,
      shapeBox.y + shapeBox.height / 2,
    );

    // TextPromptOverlay's input is `data-testid="text-prompt-input"`.
    await expect(page.getByTestId("text-prompt-input")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("V1.0110: CMD+= zoom rescales scroll position so viewport center stays anchored", async () => {
  const { app, page } = await launchApp();
  try {
    // bench-10p.pdf has 10 pages — guaranteed scrollable at zoom=1 on any
    // reasonable viewport. sample.pdf is too short on small screens, so
    // scrollTop=200 wouldn't stick.
    await openFixture(page, "bench-10p.pdf");

    // There are multiple `.acr-scroll` elements (sidebar thumb list,
    // page-count strip, viewer). The viewer is the only one that
    // contains `[data-page]` children — use that to disambiguate.
    await page.waitForSelector("[data-page]", { timeout: 15_000 });
    await page.waitForFunction(() => {
      const el = Array.from(document.querySelectorAll(".acr-scroll")).find(
        (s) => s.querySelector("[data-page]"),
      ) as HTMLElement | undefined;
      if (!el) return false;
      return el.scrollHeight - el.clientHeight > 50;
    }, undefined, { timeout: 15_000 });

    // Get a snapshot of pre-zoom scroll metrics inside the scroller.
    const before = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll(".acr-scroll")).find(
        (s) => s.querySelector("[data-page]"),
      ) as HTMLElement | undefined;
      if (!el) return null;
      // Force a non-trivial scrollTop so we can measure the anchor effect.
      el.scrollTop = 200;
      return {
        zoom: window.__weavepdfTest__.getActiveTab()?.zoom ?? 1,
        scrollTop: el.scrollTop,
        scrollLeft: el.scrollLeft,
        clientHeight: el.clientHeight,
        clientWidth: el.clientWidth,
        scrollHeight: el.scrollHeight,
      };
    });
    expect(before).not.toBeNull();
    if (!before) return;
    expect(before.scrollTop).toBe(200);

    // Trigger the zoom-in hotkey — same path as the user hitting CMD+=.
    await page.keyboard.press("Meta+Equal");

    // Wait briefly for React to flush + the layout effect to run.
    await page.waitForTimeout(120);

    const after = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll(".acr-scroll")).find(
        (s) => s.querySelector("[data-page]"),
      ) as HTMLElement | undefined;
      if (!el) return null;
      return {
        zoom: window.__weavepdfTest__.getActiveTab()?.zoom ?? 1,
        scrollTop: el.scrollTop,
        scrollLeft: el.scrollLeft,
        clientHeight: el.clientHeight,
      };
    });
    expect(after).not.toBeNull();
    if (!after) return;

    // Zoom should have increased by the ~1.1× factor wired in App.tsx.
    expect(after.zoom).toBeGreaterThan(before.zoom);

    // The new scrollTop should anchor the viewport center on the same
    // content point. Formula:
    //   newScrollTop = (oldScrollTop + clientHeight/2) * ratio - clientHeight/2
    // Allow ±2px tolerance for sub-pixel rounding inside the browser.
    const ratio = after.zoom / before.zoom;
    const expected =
      (before.scrollTop + before.clientHeight / 2) * ratio -
      before.clientHeight / 2;
    expect(Math.abs(after.scrollTop - expected)).toBeLessThanOrEqual(2);

    // Sanity: the scroll moved (pre-V1.0110 it stayed at 200 because
    // setZoom never touched scroll).
    expect(after.scrollTop).toBeGreaterThan(before.scrollTop);
  } finally {
    await app.close();
  }
});
