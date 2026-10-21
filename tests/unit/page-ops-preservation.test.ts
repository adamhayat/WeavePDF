// Regression pins for V1.0121: page operations must not destroy everything in
// the document that isn't page content.
//
// The bug: deletePages / extractPages / reorderPages each built a brand-new
// `PDFDocument.create()` and copied the surviving pages into it. copyPages
// carries page content ONLY — so the new catalog had no AcroForm, no outline,
// no page labels and an empty Info dict. Deleting one page of a filled-in form
// therefore threw away the answers on every other page too, and
// `getFormFields` then returned [] so the fields stopped being editable.
// Printing a page range goes through extractPages, so range printing silently
// flattened forms as well.
//
// The fix: mutate the loaded document (removePage / insertPage) so the catalog
// is preserved. These tests assert the SURVIVING document still carries the
// things a user would notice losing.
import { describe, it, expect } from "vitest";
import { PDFDocument, PDFDict, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream } from "pdf-lib";
import {
  deletePages,
  extractPages,
  reorderPages,
  getFormFields,
} from "../../src/renderer/lib/pdf-ops";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - legacy build has no bundled types
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

/** 3 pages, each with a filled text field and a visible marker, plus document
 *  metadata. Mirrors the shape of the forms Adam actually fills. */
async function filledForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  for (let i = 1; i <= 3; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`PAGE_${i}`, { x: 60, y: 700, size: 18, font });
    const field = form.createTextField(`field_${i}`);
    field.setText(`VALUE_${i}`);
    field.addToPage(page, { x: 60, y: 600, width: 200, height: 24 });
  }
  doc.setTitle("My Insurance Form");
  doc.setAuthor("Adam");
  return doc.save();
}

const reload = (b: Uint8Array) =>
  PDFDocument.load(b, { updateMetadata: false, ignoreEncryption: true });

async function pageMarkers(bytes: Uint8Array): Promise<string[]> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    out.push(tc.items.map((it: unknown) => (it as { str?: string }).str ?? "").join(""));
  }
  return out;
}

describe("page ops preserve the document catalog", () => {
  it("deletePages keeps the filled form fields on the surviving pages", async () => {
    const out = await deletePages(await filledForm(), [2]);
    const fields = await getFormFields(out);
    const byName = Object.fromEntries(fields.map((f) => [f.name, "value" in f ? f.value : undefined]));
    expect(byName["field_1"]).toBe("VALUE_1");
    expect(byName["field_3"]).toBe("VALUE_3");
    // The deleted page's field has no widget left to render into.
    expect(byName["field_2"]).toBeUndefined();
  });

  it("deletePages keeps document metadata", async () => {
    const doc = await reload(await deletePages(await filledForm(), [2]));
    expect(doc.getTitle()).toBe("My Insurance Form");
    expect(doc.getAuthor()).toBe("Adam");
  });

  it("deletePages removes the right page and keeps order", async () => {
    const markers = await pageMarkers(await deletePages(await filledForm(), [2]));
    expect(markers).toHaveLength(2);
    expect(markers[0]).toContain("PAGE_1");
    expect(markers[1]).toContain("PAGE_3");
  });

  it("extractPages (the range-print path) keeps the form and metadata", async () => {
    const out = await extractPages(await filledForm(), [1]);
    expect((await getFormFields(out)).map((f) => f.name)).toContain("field_1");
    expect((await reload(out)).getTitle()).toBe("My Insurance Form");
    expect(await pageMarkers(out)).toEqual([expect.stringContaining("PAGE_1")]);
  });

  it("extractPages honours the requested order", async () => {
    const markers = await pageMarkers(await extractPages(await filledForm(), [3, 1]));
    expect(markers[0]).toContain("PAGE_3");
    expect(markers[1]).toContain("PAGE_1");
  });

  it("reorderPages keeps the form, metadata and applies the new order", async () => {
    const out = await reorderPages(await filledForm(), [2, 0, 1]);
    const markers = await pageMarkers(out);
    expect(markers[0]).toContain("PAGE_3");
    expect(markers[1]).toContain("PAGE_1");
    expect(markers[2]).toContain("PAGE_2");
    const byName = Object.fromEntries((await getFormFields(out)).map((f) => [f.name, "value" in f ? f.value : undefined]));
    expect(byName["field_1"]).toBe("VALUE_1");
    expect(byName["field_2"]).toBe("VALUE_2");
    expect(byName["field_3"]).toBe("VALUE_3");
    expect((await reload(out)).getTitle()).toBe("My Insurance Form");
  });

  it("deleting every page is still refused", async () => {
    await expect(deletePages(await filledForm(), [1, 2, 3])).rejects.toThrow(/Cannot delete all/);
  });

  it("a no-op delete returns a document that still works", async () => {
    const out = await deletePages(await filledForm(), [99]);
    expect(await pageMarkers(out)).toHaveLength(3);
  });

  it("output stays loadable by pdf.js after every op", async () => {
    const base = await filledForm();
    for (const bytes of [
      await deletePages(base, [2]),
      await extractPages(base, [2]),
      await reorderPages(base, [2, 1, 0]),
    ]) {
      await expect(pageMarkers(bytes)).resolves.toBeInstanceOf(Array);
    }
  });
});

/** Count /Type /Page dicts in the OBJECT TABLE (not the page tree). An orphan
 *  page dict is one a conforming viewer never shows but a one-line
 *  `pushLeafNode` resurrects — the recoverability channel the V1.0122 sweep
 *  closes. */
async function pageDictsInObjectTable(bytes: Uint8Array): Promise<number> {
  const doc = await reload(bytes);
  return doc.context
    .enumerateIndirectObjects()
    .filter(([, obj]) =>
      obj instanceof PDFDict && obj.get(PDFName.of("Type")) === PDFName.of("Page"),
    ).length;
}

/** Decode every stream in the file and report whether `text` survives
 *  anywhere — as a literal or in pdf-lib's hex string encoding. qpdf-style
 *  external tools GC on rewrite, so the check must read the raw object
 *  table, not a normalized copy. */
async function contentRecoverable(bytes: Uint8Array, text: string): Promise<boolean> {
  const hexNeedle = Buffer.from(text, "latin1").toString("hex").toLowerCase();
  const doc = await reload(bytes);
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    let decoded: string;
    try {
      decoded = Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1");
    } catch {
      decoded = Buffer.from(obj.getContents()).toString("latin1");
    }
    if (decoded.includes(text) || decoded.toLowerCase().includes(hexNeedle)) return true;
  }
  return false;
}

describe("V1.0122: removed pages leave no recoverable residue", () => {
  it("deletePages purges the deleted page's dict and content from the file", async () => {
    const base = await filledForm();
    // Control first: the marker must be findable in the source, or the
    // absence assertion below proves nothing.
    expect(await contentRecoverable(base, "PAGE_2")).toBe(true);
    const out = await deletePages(base, [2]);
    expect(await pageDictsInObjectTable(out)).toBe(2);
    expect(await contentRecoverable(out, "PAGE_2")).toBe(false);
    // The survivors are untouched.
    expect(await contentRecoverable(out, "PAGE_1")).toBe(true);
    expect(await contentRecoverable(out, "PAGE_3")).toBe(true);
  });

  it("extractPages output carries only the extracted pages' objects", async () => {
    const base = await filledForm();
    const out = await extractPages(base, [1]);
    expect(await pageDictsInObjectTable(out)).toBe(1);
    expect(await contentRecoverable(out, "PAGE_1")).toBe(true);
    expect(await contentRecoverable(out, "PAGE_2")).toBe(false);
    expect(await contentRecoverable(out, "PAGE_3")).toBe(false);
  });

  it("extracting one page of a large doc yields a small file, not ~the whole source", async () => {
    // The pre-sweep algorithm emitted 99.7% of the source bytes when
    // extracting a single page of a 500-page doc.
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 40; i++) {
      const page = doc.addPage([612, 792]);
      for (let l = 0; l < 30; l++) {
        page.drawText(`page ${i} line ${l} — padding content so each page carries real weight`, {
          x: 40, y: 740 - l * 22, size: 11, font,
        });
      }
    }
    const base = await doc.save();
    const out = await extractPages(base, [1]);
    expect(out.length).toBeLessThan(base.length * 0.3);
  });
});

describe("V1.0122: mixed-/P widgets never get a live field deleted", () => {
  it("keeps a filled field whose surviving-page widget lacks /P", async () => {
    // /P is optional when the widget sits in the page's /Annots array. A
    // field with a /P-less widget on the KEPT page and a /P widget on the
    // DELETED page used to be judged orphaned and removed with its value.
    const doc = await PDFDocument.create();
    const p1 = doc.addPage([612, 792]);
    const p2 = doc.addPage([612, 792]);
    const form = doc.getForm();
    const field = form.createTextField("name");
    field.setText("Adam Hayat");
    field.addToPage(p1, { x: 60, y: 600, width: 200, height: 24 });
    field.addToPage(p2, { x: 60, y: 600, width: 200, height: 24 });
    // Strip /P from the page-1 widget only.
    field.acroField.getWidgets()[0].dict.delete(PDFName.of("P"));
    const base = await doc.save();

    const out = await deletePages(base, [2]);
    const byName = Object.fromEntries(
      (await getFormFields(out)).map((f) => [f.name, "value" in f ? f.value : undefined]),
    );
    expect(byName["name"]).toBe("Adam Hayat");
  });
});
