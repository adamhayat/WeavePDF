// V1.0126 regression pins for the review-found bugs (no app launch needed).
import { describe, it, expect, beforeEach } from "vitest";
import { PDFDocument, PDFName, PDFArray, PDFRawStream, StandardFonts, decodePDFRawStream, degrees } from "pdf-lib";
import * as ops from "../../src/renderer/lib/pdf-ops";
import { overlayFontFamily } from "../../src/renderer/lib/overlay-font";
import { inkBounds } from "../../src/renderer/lib/trim-ink";
import { marksAfterSave, pushStep } from "../../src/renderer/lib/undo-order";
import { useDocumentStore, type DocumentTab } from "../../src/renderer/stores/document";
import { useUIStore } from "../../src/renderer/stores/ui";

async function blank(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
}

describe("text that used to make the whole document unsaveable", () => {
  it("a tab or Windows line ending no longer throws at save", async () => {
    const r = await ops.drawWrappedText(await blank(), 1, {
      x: 72, y: 700, widthPt: 300, size: 12, text: "Name\tAmount\r\nCondo\t485,000",
    });
    expect(r.bytes.byteLength).toBeGreaterThan(100);
    const one = await ops.drawText(await blank(), 1, { x: 72, y: 700, size: 12, text: "a\tb\rc" });
    expect(one.bytes.byteLength).toBeGreaterThan(100);
  });
  it("they're normalised silently, not reported as 'can't be drawn'", () => {
    expect(ops.findUnsupportedStandardFontChars("a\tb\r\nc")).toEqual([]);
    expect(ops.sanitizeStandardFontText("a\tb\r\nc").text).toBe("a    b\nc");
  });
});

describe("Edit Text font: screen and file use the same family", () => {
  it("'sans-serif' is NOT Times (it contains the word 'serif')", () => {
    expect(ops.matchStandardFont("sans-serif", false, false)).toBe(StandardFonts.Helvetica);
    expect(ops.matchStandardFont("serif", false, false)).toBe(StandardFonts.TimesRoman);
  });
  it("the on-screen font follows the saved font", () => {
    for (const f of ["Times-Roman", "Times-Bold", "Courier", "Helvetica", "sans-serif", undefined]) {
      const saved = String(ops.matchStandardFont(f ?? "", false, false));
      const css = overlayFontFamily(f);
      if (saved.startsWith("Times")) expect(css).toContain("Times");
      else if (saved.startsWith("Courier")) expect(css).toContain("Courier");
      else expect(css).toContain("Helvetica");
    }
  });
});

describe("checkmarks / freehand save with round joins and caps", () => {
  it("the stroke sets line join 1 and cap 1 inside its own q/Q", async () => {
    const out = await ops.drawPath(await blank(), 1, [{ x: 100, y: 109 }, { x: 106, y: 100 }, { x: 118, y: 117 }], {});
    const doc = await PDFDocument.load(out);
    const contents = doc.getPage(0).node.get(PDFName.of("Contents"));
    const refs = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, i) => contents.get(i)) : [contents];
    const text = refs
      .map((r) => doc.context.lookup(r as never))
      .filter((s): s is PDFRawStream => s instanceof PDFRawStream)
      .map((s) => new TextDecoder().decode(decodePDFRawStream(s).decode()))
      .join("\n");
    expect(text).toMatch(/\b1 j\b/);
    expect(text).toMatch(/\b1 J\b/);
  });
});

describe("signature trimming", () => {
  it("finds the ink box inside a transparent pad", () => {
    const ink = new Set(["10,5", "30,20"]);
    const b = inkBounds((x, y) => (ink.has(`${x},${y}`) ? 255 : 0), 100, 50);
    expect(b).toEqual({ x: 10, y: 5, w: 21, h: 16 });
    expect(inkBounds(() => 0, 10, 10)).toBeNull();
  });
});

describe("undo timeline after a save / at the cap", () => {
  it("a save keeps only element steps since the last page change", () => {
    expect(marksAfterSave(["pending", "both", "pending", "pending"])).toEqual(["pending", "pending"]);
    expect(marksAfterSave(["pending", "bytes"])).toEqual([]);
    expect(marksAfterSave(["pending", "pending"])).toEqual(["pending", "pending"]);
  });
  it("the save point moves down when the cap drops the oldest step", () => {
    const full = Array.from({ length: 60 }, () => "pending" as const);
    const r = pushStep(full, 60, "pending", 60);
    expect(r.order.length).toBe(60);
    expect(r.cleanDepth).toBe(59); // still "one step after the save"
  });
});

describe("files changed by another tool reopen flat, not misplaced", () => {
  it("weavePagesMatch notices a rotation done elsewhere", async () => {
    const meta = { version: 3 as const, pages: [{ rotate: 0, box: [0, 0, 612, 792] }], textEdits: [], imageEdits: [], shapeEdits: [] };
    const same = await blank();
    expect(await ops.weavePagesMatch(same, meta)).toBe(true);
    const doc = await PDFDocument.load(same);
    doc.getPage(0).setRotation(degrees(90));
    expect(await ops.weavePagesMatch(await doc.save(), meta)).toBe(false);
  });
  it("reopening drops the 'saved by WeavePDF' canary with the metadata", async () => {
    const withMeta = await ops.embedWeaveMetadata(await blank(), { version: 3, textEdits: [], imageEdits: [], shapeEdits: [] });
    const stripped = await ops.stripWeaveBakes(withMeta);
    expect(await ops.detectWeaveCanaryWithoutMetadata(stripped.bytes)).toBe(false);
  });
});

// ─── store-level: the real renderOutput / remove paths ─────────────────────

function seedTab(bytes: Uint8Array, patch: Partial<DocumentTab> = {}): string {
  const tab = {
    id: "t", name: "x.pdf", path: null, saveInPlace: false, draftKey: "k", sizeBytes: bytes.byteLength,
    bytes, pdf: null, numPages: 1, currentPage: 1, zoom: 1, dirty: false, selectedPages: new Set<number>(),
    pendingTextEdits: [], pendingImageEdits: [], pendingShapeEdits: [], history: [], redoStack: [],
    pendingRedoStack: [], pendingHistory: [], pendingFuture: [], undoOrder: [], redoOrder: [], cleanDepth: 0,
    version: 0, signed: false, ...patch,
  } as DocumentTab;
  useDocumentStore.setState({ tabs: [tab], activeTabId: "t" });
  return "t";
}

beforeEach(() => {
  useUIStore.setState({ marginsEnabled: false });
});

describe("store", () => {
  it("a text box that replaces a form field blanks the field in the saved file", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const f = doc.getForm().createTextField("Total");
    f.setText("OLD VALUE");
    f.addToPage(page, { x: 100, y: 600, width: 200, height: 20 });
    const id = seedTab(await doc.save(), {
      pendingTextEdits: [{ id: "e", z: 1, page: 1, xPt: 102, yPt: 605, size: 12, text: "NEW", formField: "Total" }],
    });
    const out = (await useDocumentStore.getState().renderOutput(id))!;
    const fields = await ops.getFormFields(out);
    expect(fields.find((x) => x.name === "Total")).toMatchObject({ value: "" });
  });

  it("an element stranded past the last page doesn't make the save throw", async () => {
    const id = seedTab(await blank(), {
      pendingTextEdits: [{ id: "e", z: 1, page: 3, xPt: 100, yPt: 600, size: 12, text: "ghost" }],
    });
    await expect(useDocumentStore.getState().renderOutput(id)).resolves.toBeInstanceOf(Uint8Array);
  });

  it("saving elements on a signed tab warns and drops the signed flag", async () => {
    const id = seedTab(await blank(), {
      signed: true,
      pendingTextEdits: [{ id: "e", z: 1, page: 1, xPt: 100, yPt: 600, size: 12, text: "x" }],
    });
    await useDocumentStore.getState().renderOutput(id);
    expect(useDocumentStore.getState().tabs[0].signed).toBe(false);
  });

  it("deleting the last element keeps the tab unsaved (the file still has it)", async () => {
    const id = seedTab(await blank(), {
      pendingShapeEdits: [{ id: "s", z: 1, page: 1, kind: "whiteout", xPt: 1, yPt: 1, widthPt: 10, heightPt: 10 }],
    });
    useDocumentStore.getState().removePendingShapeEdit(id, "s");
    expect(useDocumentStore.getState().tabs[0].dirty).toBe(true);
  });

  it("a no-op change does not mark the tab unsaved", async () => {
    const id = seedTab(await blank(), {
      pendingTextEdits: [{ id: "e", z: 1, page: 1, xPt: 100, yPt: 600, size: 12, text: "5000" }],
    });
    useDocumentStore.getState().updatePendingTextEdit(id, "e", { text: "5000" });
    expect(useDocumentStore.getState().tabs[0].dirty).toBe(false);
  });

  it("an edit made while the save was writing leaves the tab unsaved", async () => {
    const id = seedTab(await blank(), {
      dirty: true,
      pendingTextEdits: [{ id: "e", z: 1, page: 1, xPt: 100, yPt: 600, size: 12, text: "a" }],
    });
    const t0 = useDocumentStore.getState().tabs[0];
    const saved = { bytes: t0.bytes, text: t0.pendingTextEdits, image: t0.pendingImageEdits, shape: t0.pendingShapeEdits };
    useDocumentStore.getState().updatePendingTextEdit(id, "e", { text: "ab" }); // typed during the save
    useDocumentStore.getState().markClean(id, "/tmp/x.pdf", saved);
    expect(useDocumentStore.getState().tabs[0].dirty).toBe(true);
  });

  it("selecting one element deselects the others (Delete used to remove two)", () => {
    const ui = useUIStore.getState();
    ui.setSelectedPendingImage("sig");
    ui.setSelectedPendingText("box");
    const s = useUIStore.getState();
    expect([s.selectedPendingImageId, s.selectedPendingTextId]).toEqual([null, "box"]);
  });
});
