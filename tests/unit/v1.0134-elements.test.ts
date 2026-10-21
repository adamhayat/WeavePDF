// V1.0134 regression pins — five reports from Adam (2026-10-21) on placed
// elements:
//   1. the sidebar thumbnail showed a pasted screenshot as a purple box
//   2. a new text box's dashed frame ran out to the page edge
//   3. ⌘C / ⌘V did nothing for a selected text box
//   4. "selecting both elements, I can only drag the image" (no multi-select)
//   5. Add link didn't colour the text; no font colour control
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  anchorOf,
  clampTranslationToPage,
  stripIdentity,
  translateElement,
  type ElementRef,
} from "../../src/renderer/lib/element-geometry";
import {
  buildClipboard,
  choosePasteSource,
  pastedSelection,
  placePastedElements,
  visibleCenterPt,
  PASTE_OFFSET_PT,
} from "../../src/renderer/lib/element-clipboard";
import { paintPendingOverlays, wrapLines, type ThumbContext } from "../../src/renderer/lib/thumb-overlays";
import { LINK_TEXT_COLOR, rgbCss, TEXT_COLOR_SWATCHES } from "../../src/renderer/lib/text-color";
import type { PendingImageEdit, PendingShapeEdit, PendingTextEdit } from "../../src/renderer/stores/document";

const SRC = join(__dirname, "..", "..", "src", "renderer");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

const text = (over: Partial<PendingTextEdit> = {}): PendingTextEdit => ({
  id: "t1", page: 1, xPt: 100, yPt: 700, size: 12, text: "Hello", widthPt: 200, z: 1, ...over,
});
const image = (over: Partial<PendingImageEdit> = {}): PendingImageEdit => ({
  id: "i1", page: 1, xPt: 50, yPt: 400, widthPt: 120, heightPt: 80, bytes: new Uint8Array([1, 2, 3]), mime: "image/png", z: 2, ...over,
});
const rect = (over: Partial<Extract<PendingShapeEdit, { kind: "rect" }>> = {}): PendingShapeEdit => ({
  id: "s1", page: 1, kind: "rect", xPt: 10, yPt: 10, widthPt: 30, heightPt: 20, color: { r: 0, g: 0, b: 0 }, thickness: 1, z: 3, ...over,
});
const line = (): PendingShapeEdit => ({ id: "s2", page: 1, kind: "line", fromX: 0, fromY: 0, toX: 10, toY: 5, color: { r: 0, g: 0, b: 0 }, thickness: 1 });
const freehand = (): PendingShapeEdit => ({ id: "s3", page: 1, kind: "freehand", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], color: { r: 0, g: 0, b: 0 }, thickness: 1 });

describe("element geometry (group drag + paste share it)", () => {
  it("translates every coordinate an element carries", () => {
    const t = translateElement({ kind: "text", edit: text({ whiteout: { x: 100, y: 690, width: 50, height: 14 } }) }, 5, -7);
    expect([t.xPt, t.yPt]).toEqual([105, 693]);
    expect(t.whiteout).toEqual({ x: 105, y: 683, width: 50, height: 14 });
    const i = translateElement({ kind: "image", edit: image() }, 1, 1);
    expect([i.xPt, i.yPt]).toEqual([51, 401]);
    const l = translateElement({ kind: "shape", edit: line() }, 2, 3);
    expect(l.kind === "line" && [l.fromX, l.fromY, l.toX, l.toY]).toEqual([2, 3, 12, 8]);
    const f = translateElement({ kind: "shape", edit: freehand() }, 1, 1);
    expect(f.kind === "freehand" && f.points).toEqual([{ x: 2, y: 3 }, { x: 4, y: 5 }]);
    const r = translateElement({ kind: "shape", edit: rect() }, -1, -1);
    expect(r.kind === "rect" && [r.xPt, r.yPt]).toEqual([9, 9]);
  });
  it("anchors: xPt/yPt, a line's start, a stroke's first point", () => {
    expect(anchorOf({ kind: "text", edit: text() })).toEqual({ x: 100, y: 700 });
    expect(anchorOf({ kind: "shape", edit: line() })).toEqual({ x: 0, y: 0 });
    expect(anchorOf({ kind: "shape", edit: freehand() })).toEqual({ x: 1, y: 2 });
  });
  it("clamps a translation so the element stays on the page", () => {
    const el: ElementRef = { kind: "image", edit: image({ xPt: 500, yPt: 10, widthPt: 100, heightPt: 50 }) };
    expect(clampTranslationToPage(el, 50, -20, 612, 792)).toEqual({ x: 12, y: -10 });
    expect(clampTranslationToPage(el, -10, 5, 612, 792)).toEqual({ x: -10, y: 5 });
  });
  it("stripIdentity drops id / createdAt / z so the store mints new ones (and the copy lands on top)", () => {
    const s = stripIdentity({ id: "x", createdAt: 5, z: 9, page: 1, text: "a" });
    expect(s).toEqual({ page: 1, text: "a" });
  });
});

describe("element clipboard decisions", () => {
  const clipText = buildClipboard([{ kind: "text", edit: text({ text: "Hello" }) }])!;
  const clipImage = buildClipboard([{ kind: "image", edit: image() }])!;
  const clipShape = buildClipboard([{ kind: "shape", edit: rect() }])!;

  it("writes the text of text boxes and the byte length of an image", () => {
    expect(clipText.text).toBe("Hello");
    expect(clipImage.text).toBeNull();
    expect(clipImage.imageByteLength).toBe(3);
    expect(buildClipboard([])).toBeNull();
    expect(buildClipboard([{ kind: "text", edit: text({ text: "a" }) }, { kind: "text", edit: text({ id: "t2", text: "b" }) }])!.text).toBe("a\nb");
  });
  it("the in-app copy wins only while the system clipboard still holds what it wrote", () => {
    expect(choosePasteSource(clipText, { text: "Hello", imageByteLength: null })).toBe("elements");
    // user copied other text in another app since → that text pastes
    expect(choosePasteSource(clipText, { text: "newer", imageByteLength: null })).toBe("system-text");
    expect(choosePasteSource(clipImage, { text: "", imageByteLength: 3 })).toBe("elements");
    expect(choosePasteSource(clipImage, { text: "", imageByteLength: 999 })).toBe("system-image");
    expect(choosePasteSource(clipImage, { text: "", imageByteLength: null })).toBe("elements");
    expect(choosePasteSource(clipShape, { text: "left over", imageByteLength: null })).toBe("elements");
    expect(choosePasteSource(clipShape, { text: "", imageByteLength: 10 })).toBe("system-image");
    expect(choosePasteSource(null, { text: "  ", imageByteLength: null })).toBe("none");
    expect(choosePasteSource(null, { text: "plain", imageByteLength: null })).toBe("system-text");
  });
  it("pastes copies offset from the source on the same page, stepping per paste, and never off the page", () => {
    const [first] = placePastedElements(clipText, { targetPage: 1, pageW: 612, pageH: 792, marginsEnabled: false, pasteIndex: 0 });
    expect(first.kind).toBe("text");
    expect((first.edit as PendingTextEdit).xPt).toBe(100 + PASTE_OFFSET_PT);
    expect((first.edit as PendingTextEdit).yPt).toBe(700 - PASTE_OFFSET_PT);
    expect("id" in first.edit).toBe(false);
    const [second] = placePastedElements(clipText, { targetPage: 1, pageW: 612, pageH: 792, marginsEnabled: false, pasteIndex: 1 });
    expect((second.edit as PendingTextEdit).xPt).toBe(100 + 2 * PASTE_OFFSET_PT);
    // another page: same position, no offset
    const [other] = placePastedElements(clipText, { targetPage: 2, pageW: 612, pageH: 792, marginsEnabled: false, pasteIndex: 0 });
    expect((other.edit as PendingTextEdit).page).toBe(2);
    expect((other.edit as PendingTextEdit).xPt).toBe(100);
    // an image already at the right edge can't be pushed past it
    const edge = buildClipboard([{ kind: "image", edit: image({ xPt: 500, widthPt: 112 }) }])!;
    const [img] = placePastedElements(edge, { targetPage: 1, pageW: 612, pageH: 792, marginsEnabled: false, pasteIndex: 0 });
    expect((img.edit as PendingImageEdit).xPt).toBe(500);
  });
  it("a system paste lands at the centre of the visible part of the page", () => {
    const page = { left: 0, top: -400, width: 612, height: 792 };
    const viewport = { left: 0, top: 0, width: 612, height: 300 };
    const p = visibleCenterPt(page, viewport, 1, 792);
    expect(p.x).toBe(306);
    expect(p.y).toBeCloseTo(792 - 550); // visible band is page-y 400..700 → centre 550 from top
    // page fully off screen → page centre
    const off = visibleCenterPt({ left: 0, top: 1000, width: 612, height: 792 }, viewport, 1, 792);
    expect(off).toEqual({ x: 306, y: 396 });
  });
  it("a paste selects what it added — all of them when there are several", () => {
    expect(pastedSelection([{ kind: "text", id: "a" }, { kind: "image", id: "b" }])).toEqual({ primary: { kind: "image", id: "b" }, group: ["a", "b"] });
    expect(pastedSelection([{ kind: "text", id: "a" }])).toEqual({ primary: { kind: "text", id: "a" }, group: [] });
  });
});

type Call = [string, ...unknown[]];
function fakeCtx(): { ctx: ThumbContext; calls: Call[] } {
  const calls: Call[] = [];
  const rec = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
  const ctx = {
    fillStyle: "", strokeStyle: "", lineWidth: 1, lineCap: "butt", lineJoin: "miter", font: "", textAlign: "left", textBaseline: "alphabetic", globalAlpha: 1,
    save: rec("save"), restore: rec("restore"), translate: rec("translate"), rotate: rec("rotate"), scale: rec("scale"),
    beginPath: rec("beginPath"), closePath: rec("closePath"), moveTo: rec("moveTo"), lineTo: rec("lineTo"), ellipse: rec("ellipse"), rect: rec("rect"),
    stroke: rec("stroke"), fill: rec("fill"),
    fillRect: (...a: unknown[]) => { calls.push(["fillRect", ctx.fillStyle, ...a]); },
    strokeRect: rec("strokeRect"),
    fillText: (...a: unknown[]) => { calls.push(["fillText", ctx.fillStyle, ...a]); },
    measureText: (s: string) => ({ width: s.length * 6 }),
    drawImage: rec("drawImage"),
  } as unknown as ThumbContext;
  return { ctx, calls };
}

describe("thumbnail paints the real elements", () => {
  it("draws the decoded image, not a placeholder rectangle", () => {
    const { ctx, calls } = fakeCtx();
    const bmp = { tag: "bitmap" } as unknown as CanvasImageSource;
    paintPendingOverlays(ctx, { text: [], image: [image()], shape: [] }, 1, 0.25, 792, () => bmp);
    const draw = calls.find((c) => c[0] === "drawImage");
    expect(draw).toBeTruthy();
    expect(draw![1]).toBe(bmp);
    expect(draw!.slice(4)).toEqual([30, 20]); // 120×80 pt at 0.25
    expect(calls.some((c) => c[0] === "fillRect" && String(c[1]).includes("109, 94, 245"))).toBe(false);
  });
  it("draws the text in its own colour, wrapped to its width, on the right baseline", () => {
    const { ctx, calls } = fakeCtx();
    paintPendingOverlays(ctx, { text: [text({ text: "one two three", widthPt: 48, size: 10, color: LINK_TEXT_COLOR })], image: [], shape: [] }, 1, 1, 792, () => null);
    const texts = calls.filter((c) => c[0] === "fillText");
    expect(texts.map((c) => c[2])).toEqual(["one two", "three"]);
    expect(texts[0][1]).toBe(rgbCss(LINK_TEXT_COLOR));
    expect(texts[0][3]).toBe(100);
    expect(texts[0][4]).toBe(792 - 700);
    expect(texts[1][4]).toBe(792 - 700 + 12);
  });
  it("paints in stacking order — a whiteout above a text box covers it, one below does not", () => {
    const order = (zText: number, zWhite: number) => {
      const { ctx, calls } = fakeCtx();
      paintPendingOverlays(ctx, { text: [text({ z: zText })], image: [], shape: [rect({ kind: "whiteout", z: zWhite } as never)] }, 1, 1, 792, () => null);
      return calls.filter((c) => c[0] === "fillText" || (c[0] === "fillRect" && c[1] === "#ffffff")).map((c) => c[0]);
    };
    expect(order(1, 2)).toEqual(["fillText", "fillRect"]);
    expect(order(2, 1)).toEqual(["fillRect", "fillText"]);
  });
  it("skips other pages", () => {
    const { ctx, calls } = fakeCtx();
    paintPendingOverlays(ctx, { text: [text({ page: 2 })], image: [], shape: [] }, 1, 1, 792, () => null);
    expect(calls.filter((c) => c[0] === "fillText")).toHaveLength(0);
  });
  it("wrapLines breaks on width and keeps explicit newlines", () => {
    expect(wrapLines("aaa bbb ccc", 7 * 6, (s) => s.length * 6)).toEqual(["aaa bbb", "ccc"]);
    expect(wrapLines("a\nb", 100, (s) => s.length * 6)).toEqual(["a", "b"]);
    expect(wrapLines("abcdefgh", 3 * 6, (s) => s.length * 6)).toEqual(["abc", "def", "gh"]);
  });
});

describe("source pins", () => {
  const textLayer = read("components/Viewer/PendingTextLayer.tsx");
  const imageLayer = read("components/Viewer/PendingImageLayer.tsx");
  const shapeLayer = read("components/Viewer/PendingShapeLayer.tsx");
  const sidebar = read("components/Sidebar/Sidebar.tsx");
  const app = read("App.tsx");

  it("the text frame hugs the text at rest and only shows the stored width while the handle is dragged", () => {
    expect(textLayer).toContain('{ top: 0, left: 0, bottom: 0, right: 0 }');
    expect(textLayer).toContain("frameDragWidthPt != null");
    expect(textLayer).not.toMatch(/style=\{\{ top: 0, left: 0, bottom: 0, width: effectiveWidthPt \* zoom \}\}/);
    // the width handle no longer shares the corner with the font-size handle
    expect(textLayer).toContain('data-handle="frame-e"');
    expect(textLayer).not.toContain('data-handle="frame-se"');
  });
  it("every layer treats a group member as selected, and shift-click toggles membership", () => {
    expect(textLayer).toContain("s.selectedPendingTextId === edit.id || s.groupSelectedIds.includes(edit.id)");
    expect(imageLayer).toContain("s.selectedPendingImageId === edit.id || s.groupSelectedIds.includes(edit.id)");
    expect(shapeLayer.match(/s\.selectedPendingShapeId === shape\.id \|\| s\.groupSelectedIds\.includes\(shape\.id\)/g)).toHaveLength(4);
    expect(textLayer).toContain('toggleGroupSelect("text", edit.id)');
    expect(imageLayer).toContain('toggleGroupSelect("image", edit.id)');
    expect(shapeLayer.match(/toggleGroupSelect\("shape", shape\.id\)/g)).toHaveLength(4);
  });
  it("every move drag begins / follows / ends the group move", () => {
    for (const src of [textLayer, imageLayer, shapeLayer]) {
      expect(src).toContain("beginGroupMove(");
      expect(src).toContain("followGroupMove(");
      expect(src).toContain("endGroupMove(");
    }
    // one follow per move site: text 2, image 1, box/line/freehand/sticky 4
    expect(textLayer.match(/followGroupMove\(/g)).toHaveLength(2);
    expect(imageLayer.match(/followGroupMove\(/g)).toHaveLength(1);
    expect(shapeLayer.match(/followGroupMove\(/g)).toHaveLength(4);
  });
  it("the thumbnail no longer paints indigo placeholder rectangles and composites from an offscreen base", () => {
    expect(sidebar).not.toContain("rgba(109, 94, 245, 0.30)");
    expect(sidebar).toContain("paintPendingOverlays(");
    expect(sidebar).toContain("createImageBitmap(");
    // the pdf.js render effect must not depend on the pending arrays (V1.0095 freeze)
    expect(sidebar).toContain("}, [pdf, pageNumber, tab.version, thumbScale]);");
  });
  it("⌘C/⌘X/⌘V are installed once at app mount via clipboard events", () => {
    expect(app).toContain("useEffect(() => installElementClipboard(), []);");
    const actions = read("lib/element-clipboard-actions.ts");
    expect(actions).toContain('document.addEventListener("copy"');
    expect(actions).toContain('document.addEventListener("cut"');
    expect(actions).toContain('document.addEventListener("paste"');
  });
  it("text colour reaches the screen, both bake paths, the saved metadata and the restore", () => {
    expect(textLayer).toContain("const textColorCss = rgbCss(edit.color)");
    expect(textLayer).not.toContain("text-[#0b0b0e]");
    expect(textLayer).not.toContain('color: "#0b0b0e"');
    expect(textLayer).toContain("<TextColorControl");
    const doc = read("stores/document.ts");
    expect(doc.match(/^\s*color: e\.color,$/gm)).toHaveLength(4); // 2 bakes + v3 meta + legacy meta
    expect(read("lib/bake-layers.ts").match(/^\s*color: e\.color,$/gm)).toHaveLength(2);
    expect(app).toContain("color: e.color,");
    expect(read("lib/pdf-ops.ts")).toMatch(/fontName\?: string;\n\s+\/\*\* V1\.0134[^\n]*\n\s+color\?: \{ r: number; g: number; b: number \};/);
  });
  it("applying a link from a whole text box colours it link-blue", () => {
    const popover = read("components/LinkPopover/LinkPopover.tsx");
    expect(popover).toContain("pendingLink.textEditId && pendingLink.coversWholeText");
    expect(popover).toContain("{ color: LINK_TEXT_COLOR }");
    expect(textLayer).toContain("coversWholeText: start === 0 && end === text.length");
    expect(TEXT_COLOR_SWATCHES.some((s) => s.rgb === LINK_TEXT_COLOR)).toBe(true);
  });
});

// ─── store-level: real selection + real group drag + real colour bake ───────
import { PDFDocument, PDFName, PDFArray, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import * as ops from "../../src/renderer/lib/pdf-ops";
import { useDocumentStore, type DocumentTab } from "../../src/renderer/stores/document";
import { useUIStore } from "../../src/renderer/stores/ui";
import { beginGroupMove, endGroupMove, followGroupMove, groupMoveActive, selectedElementIds } from "../../src/renderer/lib/group-move";

function seedTab(patch: Partial<DocumentTab> = {}): string {
  const tab = {
    id: "t", name: "x.pdf", path: null, saveInPlace: false, draftKey: "k", sizeBytes: 0, disk: null,
    bytes: new Uint8Array(), pdf: null, numPages: 1, currentPage: 1, zoom: 1, dirty: false, selectedPages: new Set<number>(),
    pendingTextEdits: [], pendingImageEdits: [], pendingShapeEdits: [], history: [], redoStack: [],
    pendingRedoStack: [], pendingHistory: [], pendingFuture: [], undoOrder: [], redoOrder: [], cleanDepth: 0,
    version: 0, signed: false, ...patch,
  } as unknown as DocumentTab;
  useDocumentStore.setState({ tabs: [tab], activeTabId: "t" });
  return "t";
}

describe("multi-selection (shift-click)", () => {
  const reset = () => useUIStore.getState().clearAllPendingSelections();
  it("a second plain click replaces the selection — the pre-V1.0134 behaviour Adam hit", () => {
    reset();
    const ui = useUIStore.getState();
    ui.setSelectedPendingImage("i1");
    ui.setSelectedPendingText("t1");
    expect(useUIStore.getState().selectedPendingImageId).toBeNull();
    expect(selectedElementIds()).toEqual(["t1"]);
  });
  it("shift-click adds; both stay selected; a plain click on a member keeps the group", () => {
    reset();
    useUIStore.getState().setSelectedPendingImage("i1");
    useUIStore.getState().toggleGroupSelect("text", "t1");
    expect(selectedElementIds().sort()).toEqual(["i1", "t1"]);
    expect(useUIStore.getState().selectedPendingTextId).toBe("t1");
    // starting a drag on the image re-selects it as primary — group survives
    useUIStore.getState().setSelectedPendingImage("i1");
    expect(selectedElementIds().sort()).toEqual(["i1", "t1"]);
    // a plain click on something outside the group dissolves it
    useUIStore.getState().setSelectedPendingShape("s9");
    expect(selectedElementIds()).toEqual(["s9"]);
  });
  it("shift-click on a member drops it; the last survivor stays selected; deselect clears all", () => {
    reset();
    useUIStore.getState().toggleGroupSelect("text", "t1");
    useUIStore.getState().toggleGroupSelect("image", "i1");
    useUIStore.getState().toggleGroupSelect("shape", "s1");
    expect(selectedElementIds().sort()).toEqual(["i1", "s1", "t1"]);
    useUIStore.getState().toggleGroupSelect("shape", "s1"); // primary drops out
    expect(selectedElementIds().sort()).toEqual(["i1", "t1"]);
    useUIStore.getState().toggleGroupSelect("image", "i1");
    expect(selectedElementIds()).toEqual(["t1"]);
    useUIStore.getState().setSelectedPendingText(null);
    expect(selectedElementIds()).toEqual([]);
  });
});

describe("group drag through the real store", () => {
  it("dragging one member moves the others by the same delta, absolute from the drag start", () => {
    seedTab({
      pendingTextEdits: [text({ id: "t1", xPt: 100, yPt: 700, whiteout: { x: 100, y: 690, width: 40, height: 14 } })],
      pendingImageEdits: [image({ id: "i1", xPt: 50, yPt: 400 })],
      pendingShapeEdits: [line(), freehand()],
    });
    useUIStore.getState().setGroupSelection({ kind: "image", id: "i1" }, ["i1", "t1", "s2", "s3"]);
    expect(beginGroupMove("t", "i1")).toBe(true);
    expect(groupMoveActive()).toBe(true);
    const store = useDocumentStore.getState();
    store.updatePendingImageEdit("t", "i1", { xPt: 60, yPt: 390 });
    followGroupMove("i1", { x: 60, y: 390 });
    store.updatePendingImageEdit("t", "i1", { xPt: 80, yPt: 380 });
    followGroupMove("i1", { x: 80, y: 380 });
    const tab = useDocumentStore.getState().tabs[0];
    const t = tab.pendingTextEdits[0];
    expect([t.xPt, t.yPt]).toEqual([130, 680]);
    expect(t.whiteout).toEqual({ x: 130, y: 670, width: 40, height: 14 });
    const l = tab.pendingShapeEdits[0];
    expect(l.kind === "line" && [l.fromX, l.fromY, l.toX, l.toY]).toEqual([30, -20, 40, -15]);
    const f = tab.pendingShapeEdits[1];
    expect(f.kind === "freehand" && f.points).toEqual([{ x: 31, y: -18 }, { x: 33, y: -16 }]);
    endGroupMove("i1");
    expect(groupMoveActive()).toBe(false);
    // after the drag ended, a stray follow does nothing
    followGroupMove("i1", { x: 500, y: 500 });
    expect(useDocumentStore.getState().tabs[0].pendingTextEdits[0].xPt).toBe(130);
  });
  it("a single selection or a drag of a non-member starts no group move", () => {
    seedTab({ pendingTextEdits: [text({ id: "t1" })], pendingImageEdits: [image({ id: "i1" })] });
    useUIStore.getState().clearAllPendingSelections();
    useUIStore.getState().setSelectedPendingText("t1");
    expect(beginGroupMove("t", "t1")).toBe(false);
    useUIStore.getState().setGroupSelection({ kind: "text", id: "t1" }, ["t1", "i1"]);
    expect(beginGroupMove("t", "zzz")).toBe(false);
    expect(groupMoveActive()).toBe(false);
  });
});

describe("text colour is baked into the page", () => {
  async function contentOf(bytes: Uint8Array): Promise<string> {
    const doc = await PDFDocument.load(bytes);
    const contents = doc.getPage(0).node.get(PDFName.of("Contents"));
    const refs = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, i) => contents.get(i)) : [contents];
    return refs
      .map((r) => doc.context.lookup(r as never))
      .filter((s): s is PDFRawStream => s instanceof PDFRawStream)
      .map((s) => new TextDecoder().decode(decodePDFRawStream(s).decode()))
      .join("\n");
  }
  async function blank(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    return doc.save();
  }
  it("drawText and drawWrappedText set the fill colour (rg) the box carries", async () => {
    const single = await ops.drawText(await blank(), 1, { x: 100, y: 700, size: 12, text: "View Our Listing", color: LINK_TEXT_COLOR });
    expect(await contentOf(single.bytes)).toMatch(/0\.05\d* 0\.43\d* 0\.99\d* rg/);
    const wrapped = await ops.drawWrappedText(await blank(), 1, { x: 100, y: 700, widthPt: 200, size: 12, text: "View Our Listing", color: { r: 0.8, g: 0.15, b: 0.15 } });
    expect(await contentOf(wrapped.bytes)).toMatch(/0\.8 0\.15 0\.15 rg/);
    // control: no colour → black
    const black = await ops.drawText(await blank(), 1, { x: 100, y: 700, size: 12, text: "x" });
    expect(await contentOf(black.bytes)).toMatch(/\b0 0 0 rg\b/);
  });
  it("the saved metadata carries the colour and nothing strips it on the way back", async () => {
    const withMeta = await ops.embedWeaveMetadata(await blank(), {
      version: 3,
      pages: [{ rotate: 0, box: [0, 0, 612, 792] }],
      textEdits: [{ page: 1, xPt: 1, yPt: 2, size: 12, text: "a", color: LINK_TEXT_COLOR, z: 1 }],
      imageEdits: [],
      shapeEdits: [],
    } as never);
    const meta = await ops.extractWeaveMetadata(withMeta);
    expect(meta?.textEdits[0].color).toEqual(LINK_TEXT_COLOR);
  });
});

// ─── V1.0135: one keystroke, two clipboard events ────────────────────────────
import { isDuplicateClipboardEvent, CLIPBOARD_EVENT_DEDUPE_MS } from "../../src/renderer/lib/element-clipboard";

describe("V1.0135: the duplicate paste Electron delivers for one ⌘V", () => {
  it("a second event a few ms after a handled one is a duplicate; a later one is a new paste", () => {
    expect(isDuplicateClipboardEvent(null, 1000)).toBe(false);
    expect(isDuplicateClipboardEvent(1000, 1004)).toBe(true);
    expect(isDuplicateClipboardEvent(1000, 1000 + CLIPBOARD_EVENT_DEDUPE_MS - 1)).toBe(true);
    expect(isDuplicateClipboardEvent(1000, 1000 + CLIPBOARD_EVENT_DEDUPE_MS)).toBe(false);
    expect(isDuplicateClipboardEvent(1000, 2000)).toBe(false);
  });
  it("the clipboard text matching is trailing-newline tolerant, so the second delivery can't fall through to a 12 pt system paste", () => {
    const clip = buildClipboard([{ kind: "text", edit: text({ text: "Booking the tour" }) }]);
    expect(choosePasteSource(clip, { text: "Booking the tour\n", imageByteLength: null })).toBe("elements");
    expect(choosePasteSource(clip, { text: "Booking the tour", imageByteLength: null })).toBe("elements");
    expect(choosePasteSource(clip, { text: "Booking the tour now", imageByteLength: null })).toBe("system-text");
  });
  it("both handlers consult the dedupe before doing anything, and stamp only when they handled the event", () => {
    const actions = read("lib/element-clipboard-actions.ts");
    const copyBody = actions.slice(actions.indexOf("function handleCopy"), actions.indexOf("async function pageSizePt"));
    const pasteBody = actions.slice(actions.indexOf("async function handlePaste"), actions.indexOf("export function installElementClipboard"));
    expect(copyBody).toContain("isDuplicateClipboardEvent(lastCopyHandledAt, e.timeStamp)");
    expect(pasteBody).toContain("isDuplicateClipboardEvent(lastPasteHandledAt, e.timeStamp)");
    // the stamp is written right after the preventDefault that claims the event
    expect(copyBody).toMatch(/e\.preventDefault\(\);\n\s+lastCopyHandledAt = e\.timeStamp;/);
    expect(pasteBody).toMatch(/e\.preventDefault\(\);\n\s+lastPasteHandledAt = e\.timeStamp;/);
    // and the duplicate is swallowed before the page is touched
    expect(pasteBody.indexOf("isDuplicateClipboardEvent")).toBeLessThan(pasteBody.indexOf("choosePasteSource("));
  });
});
