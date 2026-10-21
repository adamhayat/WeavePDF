// V1.0133 — reopening a file from Finder must show the file ON DISK.
// Adam (2026-10-20): "when you updated a PDF, save it as the exact same
// filename, and reopen it in Weave, it opens the last version. You have to
// close again, then reopen again, and then it shows the correct updated PDF."
import { describe, it, expect } from "vitest";
import { resolveOpenTarget, sameDisk, type OpenCandidate } from "../../src/renderer/lib/open-target";

const A = "/Users/adamhayat/Desktop/Vehicle Receipts/N2/09-03-26 N2 Lottridge Tire Invoice 1423 2391.83.pdf";
const old = { mtimeMs: 1_760_000_000_000, sizeBytes: 440_210 };
const saved = { mtimeMs: 1_760_000_900_000, sizeBytes: 441_880 };

const tab = (o: Partial<OpenCandidate> & { id: string }): OpenCandidate => ({
  path: A,
  dirty: false,
  disk: old,
  ...o,
});

describe("resolveOpenTarget", () => {
  it("reuses the tab when it shows exactly the file on disk", () => {
    expect(resolveOpenTarget([tab({ id: "t1" })], A, old)).toEqual({ action: "activate", tabId: "t1" });
  });

  it("Adam's case: the original tab is stale after a Save As over the same name from another tab — the saved tab wins", () => {
    // t1 = the original invoice, still open. t2 = the edited copy, saved over
    // the same file name (markClean re-stamped it with the write's mtime).
    const tabs = [tab({ id: "t1" }), tab({ id: "t2", disk: saved })];
    expect(resolveOpenTarget(tabs, A, saved)).toEqual({ action: "activate", tabId: "t2" });
  });

  it("a clean tab holding an older version is replaced by a fresh load of the file", () => {
    expect(resolveOpenTarget([tab({ id: "t1" })], A, saved)).toEqual({ action: "replace", tabId: "t1" });
  });

  it("a stale tab with unsaved work is kept and the file opens beside it", () => {
    expect(resolveOpenTarget([tab({ id: "t1", dirty: true })], A, saved)).toEqual({
      action: "open",
      keptDirtyTabIds: ["t1"],
    });
  });

  it("a tab that never recorded a disk stamp is never trusted", () => {
    expect(resolveOpenTarget([tab({ id: "t1", disk: null })], A, old)).toEqual({ action: "replace", tabId: "t1" });
  });

  it("no tab for that path → open", () => {
    expect(resolveOpenTarget([tab({ id: "t1", path: "/elsewhere.pdf" }), tab({ id: "v", path: null })], A, old)).toEqual({
      action: "open",
      keptDirtyTabIds: [],
    });
  });

  it("a same-size rewrite with a newer mtime counts as changed", () => {
    expect(sameDisk(old, { ...old, mtimeMs: old.mtimeMs + 1 })).toBe(false);
    expect(sameDisk(old, { ...old })).toBe(true);
    expect(sameDisk(null, old)).toBe(false);
  });
});
