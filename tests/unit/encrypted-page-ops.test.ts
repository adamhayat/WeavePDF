// Regression pins for Adam's CVOR_Certificate report (V1.0121):
//   "I can't delete page 2 or print just page 1"
//
// The file is owner-locked: encrypted with an EMPTY user password, so pdf.js
// opens it with NO password prompt. The open path only decrypted when pdf.js
// THREW a password error, so the tab kept encrypted bytes, and every
// structural op (delete / extract / rotate / reorder) copied undecryptable
// content streams into a fresh container. pdf.js then LOADS that result
// happily and renders a BLANK page.
//
// WHY THE EXISTING SUITE MISSED IT: encrypted-save.test.ts asserts
// `reloadsInPdfJs(...)` — i.e. "does pdf.js accept these bytes". For a
// content-bearing page the broken output DOES load; only the text is gone. A
// loadability assertion cannot distinguish "correct" from "silently blank".
// Every assertion below therefore checks EXTRACTED TEXT, not loadability.
import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - legacy build has no bundled types
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { deletePages, extractPages, rotatePages, reorderPages, isPdfEncrypted } from "../../src/renderer/lib/pdf-ops";

const QPDF = ["/opt/homebrew/bin/qpdf", "/usr/local/bin/qpdf", "/usr/bin/qpdf"].find(existsSync);

/** A 2-page PDF with distinct, unmistakable text on each page. The text is the
 *  whole point: a blank fixture cannot detect content loss. */
async function twoPagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const label of ["PAGEONEMARKER", "PAGETWOMARKER"]) {
    const page = doc.addPage([612, 792]);
    page.drawText(label, { x: 72, y: 700, size: 24, font });
  }
  return doc.save();
}

function qpdfRun(bytes: Uint8Array, args: (inP: string, outP: string) => string[]): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "wp-enc-ops-"));
  const inP = join(dir, "in.pdf");
  const outP = join(dir, "out.pdf");
  writeFileSync(inP, bytes);
  execFileSync(QPDF!, args(inP, outP));
  return new Uint8Array(readFileSync(outP));
}

/** Owner-locked: EMPTY user password (opens with no prompt), owner password set
 *  so the document is flagged "modify: not allowed". This is the CVOR shape —
 *  the real file is `AESv2`, i.e. the `128` + `--use-aes=y` variant below.
 *  Modern qpdf refuses to WRITE RC4 without --allow-weak-crypto; that guard is
 *  about generating new files, and says nothing about our ability to READ the
 *  legacy RC4 documents still in circulation, so the flag is correct here. */
const encryptOwnerOnly = (b: Uint8Array, flavour: EncFlavour = "aes-128") =>
  qpdfRun(b, (i, o) => [
    // NOTE: --allow-weak-crypto is a GLOBAL option and must precede --encrypt;
    // placed after the bit count qpdf rejects it ("128-bit encryption options
    // must be terminated with --").
    ...(ENC_ARGS[flavour].weak ? ["--allow-weak-crypto"] : []),
    "--encrypt",
    "",
    "ownerpw",
    ...ENC_ARGS[flavour].opts,
    "--",
    i,
    o,
  ]);

type EncFlavour = "rc4-40" | "rc4-128" | "aes-128" | "aes-256";
const ENC_ARGS: Record<EncFlavour, { opts: string[]; weak: boolean }> = {
  "rc4-40": { opts: ["40"], weak: true },
  "rc4-128": { opts: ["128", "--use-aes=n"], weak: true },
  "aes-128": { opts: ["128", "--use-aes=y"], weak: false },
  "aes-256": { opts: ["256"], weak: false },
};

const decryptEmpty = (b: Uint8Array) =>
  qpdfRun(b, (i, o) => ["--password=", "--decrypt", "--", i, o]);

/** Text actually extractable from each page — the only assertion that can tell
 *  a correct result from a silently blank one. */
async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    // TextContent items are TextItem | TextMarkedContent; only the former has `str`.
    out.push(tc.items.map((it: unknown) => (it as { str?: string }).str ?? "").join(""));
  }
  return out;
}

describe.skipIf(!QPDF)("owner-locked PDFs: structural page ops", () => {
  it("the fixture reproduces the CVOR shape (opens with no password, reports encrypted)", async () => {
    const enc = encryptOwnerOnly(await twoPagePdf());
    // pdf.js opens it WITHOUT throwing — this is why the open-time
    // 'catch (password error)' branch never fired for these files.
    const texts = await pageTexts(enc);
    expect(texts[0]).toContain("PAGEONEMARKER");
    expect(await isPdfEncrypted(enc)).toBe(true);
  });

  // The bug has TWO failure modes depending on how the producer wrote the
  // file, and asserting only one of them would let the other ship:
  //   (a) pdf-lib THROWS while parsing the encrypted structure (qpdf-produced
  //       files land here) — the user sees an error;
  //   (b) pdf-lib succeeds and emits a container of undecryptable streams;
  //       pdf.js LOADS it and renders a BLANK page (Adam's real CVOR lands
  //       here) — the user sees no error at all, which is how a blank file
  //       reached disk.
  // The invariant that covers both: an op on encrypted bytes never yields the
  // original content.
  async function contentSurvives(run: () => Promise<Uint8Array>): Promise<boolean> {
    try {
      return (await pageTexts(await run()))[0].includes("PAGEONEMARKER");
    } catch {
      return false; // mode (a)
    }
  }

  it("REPRO: deleting a page from encrypted bytes loses page 1's content", async () => {
    const enc = encryptOwnerOnly(await twoPagePdf());
    expect(await contentSurvives(() => deletePages(enc, [2]))).toBe(false);
  });

  it("REPRO: extracting page 1 (the 'print just page 1' path) loses it too", async () => {
    const enc = encryptOwnerOnly(await twoPagePdf());
    expect(await contentSurvives(() => extractPages(enc, [1]))).toBe(false);
  });

  it("FIX: unlock at open → delete page 2 keeps page 1's content", async () => {
    const dec = decryptEmpty(encryptOwnerOnly(await twoPagePdf()));
    expect(await isPdfEncrypted(dec)).toBe(false);
    const texts = await pageTexts(await deletePages(dec, [2]));
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("PAGEONEMARKER");
    expect(texts[0]).not.toContain("PAGETWOMARKER");
  });

  it("FIX: unlock at open → extract page 1 keeps its content", async () => {
    const dec = decryptEmpty(encryptOwnerOnly(await twoPagePdf()));
    const texts = await pageTexts(await extractPages(dec, [1]));
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("PAGEONEMARKER");
  });

  it("FIX: rotate and reorder also survive the unlock", async () => {
    const dec = decryptEmpty(encryptOwnerOnly(await twoPagePdf()));
    expect((await pageTexts(await rotatePages(dec, [1], 90)))[0]).toContain("PAGEONEMARKER");
    const reordered = await pageTexts(await reorderPages(dec, [1, 0]));
    expect(reordered[0]).toContain("PAGETWOMARKER");
    expect(reordered[1]).toContain("PAGEONEMARKER");
  });

  // The originating report, pinned against the actual document. Skipped when
  // the file isn't on this machine (it's Adam's personal certificate, so it is
  // deliberately NOT committed as a fixture). On his Mac this is the artifact
  // that proves failure mode (b): pdf.js accepts the output and renders it blank.
  /** Same two-failure-mode tolerance as `contentSurvives`, but for the real
   *  file, whose page 1 carries the certificate body rather than a marker. */
  async function contentSurvivesReal(run: () => Promise<Uint8Array>): Promise<boolean> {
    try {
      return (await pageTexts(await run()))[0].trim().length > 100;
    } catch {
      return false;
    }
  }

  const CVOR = join(process.env.HOME ?? "", "Desktop", "CVOR_Certificate.PDF");
  it.skipIf(!existsSync(CVOR))(
    "REGRESSION (real file): CVOR_Certificate loses its text unless unlocked first",
    async () => {
      const raw = new Uint8Array(readFileSync(CVOR));
      expect(await isPdfEncrypted(raw)).toBe(true);
      // Original is readable…
      expect((await pageTexts(raw))[0].length).toBeGreaterThan(100);
      // …but deleting page 2 straight off the encrypted bytes never yields the
      // content. (Since the V1.0121 in-place rewrite this surfaces as a
      // PasswordException rather than a silent blank — strictly better, and
      // the reason the assertion is mode-agnostic. The app no longer reaches
      // this path at all: bytes are unlocked at open.)
      expect(await contentSurvivesReal(() => deletePages(raw, [2]))).toBe(false);
      // Unlock first (what the app now does at open) and the content survives.
      const dec = decryptEmpty(raw);
      const fixed = await pageTexts(await deletePages(dec, [2]));
      expect(fixed).toHaveLength(1);
      expect(fixed[0].length).toBeGreaterThan(100);
    },
  );

  // The encryption flavour must not change the verdict — AES-256 and legacy
  // RC4 owner locks are both common in the wild (MTO/insurance forms).
  it.each(["rc4-40", "rc4-128", "aes-128", "aes-256"] as const)(
    "detect + unlock works for %s owner locks",
    async (flavour) => {
      const enc = encryptOwnerOnly(await twoPagePdf(), flavour);
      expect(await isPdfEncrypted(enc)).toBe(true);
      const dec = decryptEmpty(enc);
      expect(await isPdfEncrypted(dec)).toBe(false);
      expect((await pageTexts(await deletePages(dec, [2])))[0]).toContain("PAGEONEMARKER");
    },
  );
});
