// V1.0132: ↑/↓ scrolled the sidebar instead of moving to the next/previous
// page (only ←/→ were bound). Pins the step rule and the key wiring.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pageStep } from "../../src/renderer/lib/page-step";

const SRC = join(__dirname, "..", "..", "src", "renderer");

describe("pageStep", () => {
  it("moves one page and clamps at both ends", () => {
    expect(pageStep(1, 5, 1, 1).page).toBe(2);
    expect(pageStep(5, 5, 1, 1).page).toBe(5);
    expect(pageStep(1, 5, 1, -1).page).toBe(1);
    expect(pageStep(3, 5, 0, -1).page).toBe(2);
  });
  it("moves the selection only when exactly one page is selected", () => {
    expect(pageStep(1, 5, 1, 1).moveSelection).toBe(true);
    expect(pageStep(1, 5, 0, 1).moveSelection).toBe(false);
    expect(pageStep(1, 5, 3, 1).moveSelection).toBe(false);
  });
});

describe("arrow-key wiring", () => {
  const app = readFileSync(join(SRC, "App.tsx"), "utf8");
  it("binds ↓ with → and ↑ with ← to the page step, preventing native scroll", () => {
    expect(app).toMatch(/useHotkeys\("arrowright,arrowdown,pagedown", \(e\) => arrowPageKey\(e, 1\)\)/);
    expect(app).toMatch(/useHotkeys\("arrowleft,arrowup,pageup", \(e\) => arrowPageKey\(e, -1\)\)/);
    const handler = app.slice(app.indexOf("const arrowPageKey"), app.indexOf('useHotkeys("arrowright'));
    expect(handler).toContain("canRunFeatureShortcut(e)");
    expect(handler).toContain('ui.tool === "crop"');
    expect(handler).toContain("selectedPendingShapeId");
    expect(handler).toContain("e.preventDefault()");
  });
  it("sidebar keeps the current page's thumbnail in view", () => {
    const sb = readFileSync(join(SRC, "components", "Sidebar", "Sidebar.tsx"), "utf8");
    expect(sb).toMatch(/data-page-number="\$\{currentPage\}"[\s\S]{0,80}scrollIntoView\(\{ block: "nearest" \}\)/);
  });
});
