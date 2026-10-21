// V1.0123 regression pins: closing a tab must not silently destroy work.
//
// Closing the WINDOW or quitting always showed a Save / Cancel / Don't Save
// dialog. Closing a single TAB did not — ⌘W, the tab ✕ and the "Close tab"
// context item called closeTab() directly, so a placed-but-unbaked signature,
// a drawn shape, typed text or a deleted page vanished with no warning.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { requestCloseTab, requestCloseTabs, setTabSaver } from "../../src/renderer/lib/close-tab";
import { useDocumentStore } from "../../src/renderer/stores/document";

type FakeTab = { id: string; name: string; dirty: boolean };

const closeTab = vi.fn();
let confirmResult: "save" | "cancel" | "discard" = "cancel";
let confirmThrows = false;
const confirmCloseTab = vi.fn(async () => {
  if (confirmThrows) throw new Error("dialog unavailable");
  return confirmResult;
});

function seed(tabs: FakeTab[]) {
  useDocumentStore.setState({ tabs, closeTab } as never);
}

beforeEach(() => {
  closeTab.mockClear();
  confirmCloseTab.mockClear();
  confirmThrows = false;
  setTabSaver(null);
  (globalThis as unknown as { window: unknown }).window = {
    weavepdf: { confirmCloseTab },
  };
});

describe("V1.0123: requestCloseTab", () => {
  it("closes a clean tab immediately, with no prompt", async () => {
    seed([{ id: "t1", name: "clean.pdf", dirty: false }]);
    await expect(requestCloseTab("t1")).resolves.toBe(true);
    expect(confirmCloseTab).not.toHaveBeenCalled();
    expect(closeTab).toHaveBeenCalledWith("t1");
  });

  it("asks before closing a dirty tab, and keeps it on Cancel", async () => {
    seed([{ id: "t1", name: "signed.pdf", dirty: true }]);
    confirmResult = "cancel";
    await expect(requestCloseTab("t1")).resolves.toBe(false);
    expect(confirmCloseTab).toHaveBeenCalledWith("signed.pdf");
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("closes without saving on Don't Save", async () => {
    seed([{ id: "t1", name: "scratch.pdf", dirty: true }]);
    confirmResult = "discard";
    await expect(requestCloseTab("t1")).resolves.toBe(true);
    expect(closeTab).toHaveBeenCalledWith("t1");
  });

  it("saves first on Save, and only then closes", async () => {
    seed([{ id: "t1", name: "form.pdf", dirty: true }]);
    confirmResult = "save";
    const order: string[] = [];
    setTabSaver(async (id) => {
      order.push(`save:${id}`);
      return true;
    });
    closeTab.mockImplementation((id: string) => order.push(`close:${id}`));
    await expect(requestCloseTab("t1")).resolves.toBe(true);
    expect(order).toEqual(["save:t1", "close:t1"]);
  });

  it("KEEPS the tab when the save fails or Save-As is cancelled", async () => {
    // Closing anyway here would destroy exactly the work the user asked to keep.
    seed([{ id: "t1", name: "form.pdf", dirty: true }]);
    confirmResult = "save";
    setTabSaver(async () => false);
    await expect(requestCloseTab("t1")).resolves.toBe(false);
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("KEEPS the tab when the confirmation dialog itself fails", async () => {
    seed([{ id: "t1", name: "form.pdf", dirty: true }]);
    confirmThrows = true;
    await expect(requestCloseTab("t1")).resolves.toBe(false);
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("is a no-op for a tab that no longer exists", async () => {
    seed([]);
    await expect(requestCloseTab("gone")).resolves.toBe(false);
    expect(closeTab).not.toHaveBeenCalled();
  });
});

// V1.0126: "Close other tabs" / "Close tabs to the right" called the store
// directly and threw away every unsaved tab they hit without asking.
describe("V1.0126: requestCloseTabs (close others / to the right)", () => {
  it("asks about each dirty tab and closes the clean ones silently", async () => {
    seed([
      { id: "a", name: "clean.pdf", dirty: false },
      { id: "b", name: "edited.pdf", dirty: true },
    ]);
    confirmResult = "discard";
    await requestCloseTabs(["a", "b"]);
    expect(confirmCloseTab).toHaveBeenCalledTimes(1);
    expect(confirmCloseTab).toHaveBeenCalledWith("edited.pdf");
    expect(closeTab.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
  });

  it("Cancel stops there and keeps the remaining tabs open", async () => {
    seed([
      { id: "a", name: "edited.pdf", dirty: true },
      { id: "b", name: "other.pdf", dirty: false },
    ]);
    confirmResult = "cancel";
    await requestCloseTabs(["a", "b"]);
    expect(closeTab).not.toHaveBeenCalled();
  });
});
