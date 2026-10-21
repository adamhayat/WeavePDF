// V1.0123 regression pins: a character the PDF standard fonts can't encode
// must never take the whole save down with it.
//
// Found in live QA: typing "Total → ₹500 中文" into a text overlay rendered
// perfectly on screen, then ⌘S failed outright with
//   Couldn't save: WinAnsi cannot encode "→" (0x2192)
// and NOTHING was written — the document could not be saved at all until the
// character was hunted down and deleted. pdf-lib's StandardFonts are
// WinAnsi-encoded and throw on the first unrepresentable code point, from
// `drawText` AND from `widthOfTextAtSize` (so wrapping threw too).
import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  drawText,
  drawWrappedText,
  drawStickyNote,
  sanitizeStandardFontText,
  findUnsupportedStandardFontChars,
} from "../../src/renderer/lib/pdf-ops";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - legacy build has no bundled types
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

async function blankPage(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
}

async function pageText(bytes: Uint8Array): Promise<string> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const tc = await (await doc.getPage(1)).getTextContent();
  return tc.items.map((i: unknown) => (i as { str?: string }).str ?? "").join("");
}

describe("V1.0123: unencodable characters never break the save", () => {
  it("CONTROL: raw pdf-lib really does throw on these characters", async () => {
    // Proves the hazard is real and that the tests below aren't vacuous.
    const doc = await PDFDocument.load(await blankPage());
    const font = await doc.embedFont(StandardFonts.Helvetica);
    expect(() => font.widthOfTextAtSize("Total → ₹500", 14)).toThrow(/WinAnsi|cannot encode/i);
  });

  it("drawText survives arrows, currency and CJK", async () => {
    const r = await drawText(await blankPage(), 1, {
      x: 60, y: 400, size: 14, text: "Total → ₹500 中文",
    });
    const text = await pageText(r.bytes);
    expect(text).toContain("Total");
    expect(text).toContain("->"); // arrow substituted, not dropped
    expect(r.bbox).not.toBeNull(); // width measured, so the overlay round-trips
  });

  it("drawWrappedText survives them too (widthOfTextAtSize also throws)", async () => {
    const r = await drawWrappedText(await blankPage(), 1, {
      x: 60, y: 400, widthPt: 300, size: 12,
      text: "Deliver → 中文 warehouse ₹500 today",
    });
    expect(await pageText(r.bytes)).toContain("Deliver");
  });

  it("drawStickyNote survives them", async () => {
    const bytes = await drawStickyNote(await blankPage(), 1, { x: 100, y: 500 }, "note → 中文");
    expect(await pageText(bytes)).toContain("note");
  });

  it("keeps every character WinAnsi CAN represent, untouched", async () => {
    // Accented Latin, curly quotes, en/em dashes, bullet, ½, € — all legal
    // WinAnsi, and all common in the documents Adam actually edits.
    const original = "Café Québec – ½ àé “quoted” • €50 — ok";
    const { text, unsupported } = sanitizeStandardFontText(original);
    expect(text).toBe(original);
    expect(unsupported).toEqual([]);
    const r = await drawText(await blankPage(), 1, { x: 40, y: 400, size: 12, text: original });
    expect(await pageText(r.bytes)).toContain("Café Québec");
  });

  it("reports exactly which characters were substituted, for the warning toast", () => {
    expect(findUnsupportedStandardFontChars("a → b ₹ c 中")).toEqual(["→", "₹", "中"]);
    expect(findUnsupportedStandardFontChars("plain ascii")).toEqual([]);
    // Newlines must survive — drawWrappedText splits paragraphs on them.
    expect(sanitizeStandardFontText("one\ntwo").text).toBe("one\ntwo");
  });

  it("falls back to '?' for characters with no ASCII stand-in, never dropping them silently", () => {
    const { text } = sanitizeStandardFontText("中");
    expect(text).toBe("?");
  });
});
