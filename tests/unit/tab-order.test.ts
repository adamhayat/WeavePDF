// V1.0129 — tab order. Adam (2026-10-13): "I should be able to move tabs
// around, also why when I open all it doesn't just auto open them in the
// right order?" (5 N5 Lottridge invoices selected in Finder opened as
// 09-08, 08-04, 09-29, 09-28 … — the order their loads happened to finish.)
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activeAfterClose, compareFileNames, createOpenBatcher, moveId, sortPathsForOpen } from "../../src/renderer/lib/tab-order";

const ROOT = join(__dirname, "..", "..");
const N5 = "/Users/adamhayat/Desktop/Vehicle Receipts/N5/";
const ADAM_FILES = [
  "08-04-26 N5 Lottridge Tire Invoice 1357 929.85.pdf",
  "09-05-26 N5 Lottridge Tire Inspection 10569.pdf",
  "09-08-26 N5 Lottridge Tire Invoice 1428 415.27.pdf",
  "09-28-26 N5 Lottridge Tire Inspection 10621.pdf",
  "09-29-26 N5 Lottridge Tire Invoice 1465 4290.68.pdf",
].map((f) => N5 + f);

describe("open order", () => {
  it("sorts Adam's N5 invoices into Finder's Name order", () => {
    const scrambled = [ADAM_FILES[2], ADAM_FILES[0], ADAM_FILES[4], ADAM_FILES[3], ADAM_FILES[1]];
    expect(sortPathsForOpen(scrambled)).toEqual(ADAM_FILES);
  });

  it("natural order: 2 before 10, case-insensitive, by file name not folder", () => {
    expect(sortPathsForOpen(["/z/page10.pdf", "/a/Page2.pdf", "/m/page1.pdf"])).toEqual([
      "/m/page1.pdf",
      "/a/Page2.pdf",
      "/z/page10.pdf",
    ]);
    expect(compareFileNames("/x/b.pdf", "/a/a.pdf")).toBeGreaterThan(0);
  });

  it("files that finish loading in a random order still open as tabs in name order", async () => {
    const opened: string[] = [];
    // Each open takes a different time (as real PDFs of different sizes do);
    // the slowest is the first file. Concurrent loading would finish them
    // out of order; the batcher must not.
    const delays = [40, 5, 25, 1, 15];
    const batcher = createOpenBatcher(async (p) => {
      await new Promise((r) => setTimeout(r, delays[ADAM_FILES.indexOf(p)]));
      opened.push(p);
    }, 20);
    for (const p of [ADAM_FILES[2], ADAM_FILES[0], ADAM_FILES[4], ADAM_FILES[3], ADAM_FILES[1]]) batcher.push(p);
    await batcher.idle();
    expect(opened).toEqual(ADAM_FILES);
  });

  it("one file failing doesn't stop the others; duplicates open once", async () => {
    const opened: string[] = [];
    const batcher = createOpenBatcher(async (p) => {
      if (p.endsWith("b.pdf")) throw new Error("bad");
      opened.push(p);
    }, 5);
    ["/c.pdf", "/b.pdf", "/a.pdf", "/a.pdf"].forEach((p) => batcher.push(p));
    await batcher.idle();
    expect(opened).toEqual(["/a.pdf", "/c.pdf"]);
  });

  it("a second batch waits for the first (no interleaving)", async () => {
    const opened: string[] = [];
    const batcher = createOpenBatcher(async (p) => {
      await new Promise((r) => setTimeout(r, p.startsWith("/1") ? 20 : 1));
      opened.push(p);
    }, 5);
    batcher.push("/1b.pdf");
    batcher.push("/1a.pdf");
    await new Promise((r) => setTimeout(r, 10)); // first batch flushed, still opening
    batcher.push("/2a.pdf");
    await new Promise((r) => setTimeout(r, 15));
    await batcher.idle();
    expect(opened).toEqual(["/1a.pdf", "/1b.pdf", "/2a.pdf"]);
  });
});

describe("V1.0130 regression: works with Chromium's setTimeout", () => {
  // V1.0129 stored `setTimeout` in an object and called `timers.set(...)`.
  // Chromium throws "Illegal invocation" when setTimeout's `this` isn't the
  // window (verified in a real Chromium tab); Node doesn't care, so every
  // test passed while every Finder open in the app failed. This stub behaves
  // like Chromium.
  it("the DEFAULT timers never call setTimeout with a foreign `this`", async () => {
    const real = globalThis.setTimeout;
    const strict = function (this: unknown, fn: () => void, ms?: number) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return real(fn, ms);
    } as unknown as typeof setTimeout;
    globalThis.setTimeout = strict;
    try {
      const opened: string[] = [];
      const batcher = createOpenBatcher(async (p) => void opened.push(p), 5);
      expect(() => batcher.push("/b.pdf")).not.toThrow();
      batcher.push("/a.pdf");
      await new Promise((r) => real(r, 30));
      await batcher.idle();
      expect(opened).toEqual(["/a.pdf", "/b.pdf"]);
    } finally {
      globalThis.setTimeout = real;
    }
  });
});

describe("moving tabs", () => {
  const tabs = ["a", "b", "c", "d"].map((id) => ({ id }));
  const ids = (t: { id: string }[]) => t.map((x) => x.id).join("");

  it("moves a tab right, left, to the ends", () => {
    expect(ids(moveId(tabs, "a", 2))).toBe("bcad");
    expect(ids(moveId(tabs, "d", 0))).toBe("dabc");
    expect(ids(moveId(tabs, "b", 99))).toBe("acdb");
    expect(ids(moveId(tabs, "c", -5))).toBe("cabd");
  });

  it("returns the same array when nothing moves (no store churn)", () => {
    expect(moveId(tabs, "b", 1)).toBe(tabs);
    expect(moveId(tabs, "zz", 0)).toBe(tabs);
  });
});

describe("wiring (source pins)", () => {
  const titlebar = readFileSync(join(ROOT, "src/renderer/components/Titlebar/Titlebar.tsx"), "utf8");
  const app = readFileSync(join(ROOT, "src/renderer/App.tsx"), "latin1");
  it("tabs are sortable by drag, with a click-safe activation distance", () => {
    expect(titlebar).toMatch(/<SortableContext items=\{tabs\.map\(\(t\) => t\.id\)\}/);
    expect(titlebar).toMatch(/activationConstraint: \{ distance: 5 \}/);
    expect(titlebar).toMatch(/moveTab\(String\(e\.active\.id\), to\)/);
  });
  it("right-click offers Move Tab Left / Right (keyboard-free parity)", () => {
    expect(titlebar).toMatch(/label: "Move Tab Left", onClick: \(\) => moveTab\(t\.id, idx - 1\)/);
    expect(titlebar).toMatch(/label: "Move Tab Right", onClick: \(\) => moveTab\(t\.id, idx \+ 1\)/);
  });
  it("Finder opens go through the sorted batcher, with a direct-open fallback", () => {
    expect(app).toMatch(/batcher\.push\(filePath\);\s*\} catch \(err\) \{\s*console\.error\("open batcher", err\);\s*void openOne\(filePath\);/);
    expect(app).not.toMatch(/onOpenFilePath\(async/);
  });
  it("the Open dialog also opens in name order", () => {
    expect(app).toMatch(/for \(const file of ordered\)/);
  });
});

describe("V1.0131: which tab is selected after a close", () => {
  // Adam: "when closing a tab … the last tab is auto selected, we should
  // revert back to the first tab not last."
  const t = (...ids: string[]) => ids.map((id) => ({ id }));
  it("closing the ACTIVE tab selects the FIRST remaining tab", () => {
    expect(activeAfterClose(t("a", "b", "d"), "c")).toBe("a");
  });
  it("closing another tab keeps the current one", () => {
    expect(activeAfterClose(t("a", "c", "d"), "c")).toBe("c");
  });
  it("no tabs left → nothing selected", () => {
    expect(activeAfterClose([], "a")).toBeNull();
  });
  it("the store uses it for close and close-to-the-right (no 'last tab' fallback left)", () => {
    const store = readFileSync(join(ROOT, "src/renderer/stores/document.ts"), "utf8");
    expect(store.match(/activeTabId: activeAfterClose\(nextTabs, s\.activeTabId\)/g)?.length).toBe(2);
    expect(store).not.toMatch(/nextTabs\[nextTabs\.length - 1\]/);
  });
});

describe("V1.0131: pdf.js worker teardown", () => {
  // "Preview error: PDFWorker.fromPort - the worker is being destroyed" —
  // pdf.js throws it when a document starts loading while another on the
  // shared worker port is still being destroyed. V1.0128's Full-page trim
  // did `void pdfJsDoc.destroy()` right before the preview's getDocument.
  const ops = readFileSync(join(ROOT, "src/renderer/lib/pdf-ops.ts"), "utf8");
  const modal = readFileSync(
    join(ROOT, "src/renderer/components/PrintPreviewModal/PrintPreviewModal.tsx"),
    "utf8",
  );
  it("every pdf-ops helper AWAITS its pdf.js destroy", () => {
    expect(ops).not.toMatch(/void (pdf|pdfJsDoc|doc)\.destroy\(\)/);
  });
  it("the preview retries once the teardown finishes", async () => {
    expect(modal).toMatch(/if \(attempt >= 2 \|\| !isWorkerTeardownError\(err\)\) throw err;/);
  });
});
