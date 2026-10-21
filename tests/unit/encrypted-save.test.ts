// Reproduction + fix for Adam's "Couldn't save: No password given" on signed
// insurance PDFs. Those forms are owner-locked (encrypted, but open with an
// empty user password). pdf-lib loads them with ignoreEncryption but can't
// decrypt the streams, so baking an edit yields a file pdf.js then rejects.
// The fix: decrypt with qpdf (empty password) before baking. This proves both.
import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - legacy build has no bundled types
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { drawText, isPdfEncrypted } from "../../src/renderer/lib/pdf-ops";

const QPDF = ["/opt/homebrew/bin/qpdf", "/usr/local/bin/qpdf", "/usr/bin/qpdf"].find(existsSync);

async function plainPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
}

function encryptOwnerOnly(bytes: Uint8Array): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "wp-enc-"));
  const inP = join(dir, "in.pdf");
  const outP = join(dir, "out.pdf");
  writeFileSync(inP, bytes);
  // Empty USER password (opens freely), real OWNER password (restricts editing).
  execFileSync(QPDF!, ["--encrypt", "", "ownerpw", "256", "--", inP, outP]);
  return new Uint8Array(readFileSync(outP));
}

function decryptEmpty(bytes: Uint8Array): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "wp-dec-"));
  const inP = join(dir, "in.pdf");
  const outP = join(dir, "out.pdf");
  writeFileSync(inP, bytes);
  execFileSync(QPDF!, ["--password=", "--decrypt", "--", inP, outP]);
  return new Uint8Array(readFileSync(outP));
}

async function reloadsInPdfJs(bytes: Uint8Array): Promise<boolean> {
  try {
    await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!QPDF)("encrypted (owner-locked) PDF save", () => {
  it("detects encryption via isPdfEncrypted", async () => {
    expect(await isPdfEncrypted(encryptOwnerOnly(await plainPdf()))).toBe(true);
    expect(await isPdfEncrypted(await plainPdf())).toBe(false);
  });

  it("REPRO: baking an encrypted PDF does NOT yield a usable file (the bug)", async () => {
    const enc = encryptOwnerOnly(await plainPdf());
    // Two observed failure modes for encrypted input: drawText throws while
    // reading the encrypted page tree, OR it bakes but pdf.js then rejects the
    // result ("No password given"). Either way the save fails.
    let usable = false;
    try {
      const r = await drawText(enc, 1, { x: 100, y: 100, size: 14, text: "Signed" });
      usable = await reloadsInPdfJs(r.bytes);
    } catch {
      usable = false;
    }
    expect(usable).toBe(false);
  });

  it("FIX: decrypt first → bake → pdf.js reloads AND the baked text is readable", async () => {
    const enc = encryptOwnerOnly(await plainPdf());
    const dec = decryptEmpty(enc);
    expect(await isPdfEncrypted(dec)).toBe(false);
    const r = await drawText(dec, 1, { x: 100, y: 100, size: 14, text: "Signed" });
    // V1.0122: loadability alone can't distinguish "correct" from "silently
    // blank" — the encrypted-page-ops suite's header documents that exact
    // anti-pattern as the reason the V1.0121 bug shipped. Assert the CONTENT.
    const pdf = await pdfjs.getDocument({ data: r.bytes.slice(), isEvalSupported: false }).promise;
    const tc = await (await pdf.getPage(1)).getTextContent();
    const text = tc.items.map((i: unknown) => (i as { str?: string }).str ?? "").join("");
    expect(text).toContain("Signed");
  });
});
