// V1.0127 regression pins — Print dialog.
//
// Adam (2026-10-13): (1) "print settings remain the same for the next time";
// (2) an A4 invoice printed 2-up landscape on his Brother HL-2240 came out
// CUT OFF, with Full page on or off; (3) "make sure the print preview always
// 100% matches what comes out".
//
// Root cause of (2): since V1.0121 the dialog took Paper from the DOCUMENT
// (A4) while the printer had Letter loaded. The job was laid out on an A4
// sheet (842 pt wide in landscape), CUPS was told media=A4, and the printer
// put it on Letter (792 pt) — ~18 mm fell off the edge. The preview showed
// an uncut A4 sheet, so preview and printout disagreed.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, rgb } from "pdf-lib";
import * as ops from "../../src/renderer/lib/pdf-ops";
import { parseCupsDefaultPageSize } from "../../src/shared/cups-media";
import {
  PRINT_PREFS_KEY,
  loadPrintPrefs,
  prefsPatchFromAction,
  sanitizePrintPrefs,
  savePrintPrefs,
} from "../../src/renderer/lib/print-prefs";

const ROOT = join(__dirname, "..", "..");
const MODAL = readFileSync(
  join(ROOT, "src/renderer/components/PrintPreviewModal/PrintPreviewModal.tsx"),
  "utf8",
);
const MAIN = readFileSync(join(ROOT, "src/main/main.ts"), "utf8");

function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    raw: m,
  };
}

// Verbatim `lpoptions -p Brother_HL_2240_series -l` from Adam's Mac.
const BROTHER_LPOPTIONS = `PageSize/Media Size: A4 *Letter Legal Executive A5 A5Rotated A6 ISOB5 ISOB6 Env10 EnvDL EnvC5 EnvMonarch 3x5 FanFoldGermanLegal EnvPRC5Rotated B5 Postcard EnvYou4 EnvChou3 Custom.WIDTHxHEIGHT
BRMediaType/Media Type: *Plain Thin Thick ThickPaper2 BOND Env EnvThick EnvThin Recycled Label PostCard
BRInputSlot/Paper Source: *AutoSelect Tray1 Manual`;

describe("printer default paper (CUPS)", () => {
  it("reads Letter from Adam's Brother — not the first listed size (A4)", () => {
    expect(parseCupsDefaultPageSize(BROTHER_LPOPTIONS)).toBe("letter");
  });
  it("maps A4 / borderless variants and IPP names", () => {
    expect(parseCupsDefaultPageSize("PageSize/Media Size: Letter *A4 Legal")).toBe("a4");
    expect(parseCupsDefaultPageSize("PageSize/Paper: *Letter.Fullbleed A4")).toBe("letter");
    expect(parseCupsDefaultPageSize("media/Media: *iso_a4_210x297mm na_letter_8.5x11in")).toBe("a4");
  });
  it("returns null when unknown — the dialog then uses Letter", () => {
    expect(parseCupsDefaultPageSize("")).toBeNull();
    expect(parseCupsDefaultPageSize("PageSize/Media Size: A4 Letter")).toBeNull();
    expect(parseCupsDefaultPageSize("PageSize/Media Size: *Env10 A4")).toBeNull();
  });
});

describe("remembered print settings", () => {
  it("round-trips the chosen settings", () => {
    const s = memStorage();
    savePrintPrefs({ deviceName: "Brother_HL_2240_series", deviceDisplayName: "Brother HL-2240 series" }, s);
    savePrintPrefs({ paper: "letter", layout: 2, fullPage: true, color: false, duplex: "longEdge", scalePct: 90 }, s);
    expect(loadPrintPrefs(s)).toEqual({
      deviceName: "Brother_HL_2240_series",
      deviceDisplayName: "Brother HL-2240 series",
      paper: "letter",
      layout: 2,
      fullPage: true,
      color: false,
      duplex: "longEdge",
      scalePct: 90,
    });
  });

  it("a later change overrides only that field", () => {
    const s = memStorage();
    savePrintPrefs({ paper: "letter", layout: 2 }, s);
    savePrintPrefs({ layout: 4 }, s);
    expect(loadPrintPrefs(s)).toEqual({ paper: "letter", layout: 4 });
  });

  it("V1.0128: copies and orientation ARE remembered; only the page range is per document", () => {
    expect(prefsPatchFromAction({ type: "set-copies", value: 3 })).toEqual({ copies: 3 });
    expect(prefsPatchFromAction({ type: "set-orientation", value: "landscape" })).toEqual({ orientation: "landscape" });
    expect(prefsPatchFromAction({ type: "set-pages-input", value: "3-5" })).toBeNull();
    expect(sanitizePrintPrefs({ copies: 3, pagesInput: "3-5", orientation: "landscape" })).toEqual({
      copies: 3,
      orientation: "landscape",
    });
    expect(sanitizePrintPrefs({ copies: 5000, orientation: "sideways" })).toEqual({ copies: 999 });
  });

  it("V1.0128: a remembered orientation beats the document's shape", () => {
    expect(MODAL).toMatch(/if \(!loadPrintPrefs\(\)\.orientation\) \{\s*dispatch\(\{\s*type: "set-orientation"/);
  });

  it("every remembered control produces a patch", () => {
    expect(prefsPatchFromAction({ type: "set-paper", value: "a4" })).toEqual({ paper: "a4" });
    expect(prefsPatchFromAction({ type: "set-layout", value: "fit" })).toEqual({ layout: "fit" });
    expect(prefsPatchFromAction({ type: "set-full-page", value: true })).toEqual({ fullPage: true });
    expect(prefsPatchFromAction({ type: "set-color", value: false })).toEqual({ color: false });
    expect(prefsPatchFromAction({ type: "set-duplex", value: "shortEdge" })).toEqual({ duplex: "shortEdge" });
    expect(prefsPatchFromAction({ type: "set-scale-pct", value: 80 })).toEqual({ scalePct: 80 });
    expect(prefsPatchFromAction({ type: "set-printer", name: "P", displayName: "Printer" })).toEqual({
      deviceName: "P",
      deviceDisplayName: "Printer",
    });
  });

  it("corrupt or invalid storage never reaches the print pipeline", () => {
    const s = memStorage();
    s.setItem(PRINT_PREFS_KEY, "{not json");
    expect(loadPrintPrefs(s)).toEqual({});
    s.setItem(PRINT_PREFS_KEY, JSON.stringify({ paper: "b7", layout: 3, scalePct: 9999, color: "yes", duplex: "x" }));
    expect(loadPrintPrefs(s)).toEqual({ scalePct: 400 });
  });

  it("blocked storage never throws (printing must not fail over it)", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadPrintPrefs(broken)).toEqual({});
    expect(() => savePrintPrefs({ paper: "letter" }, broken)).not.toThrow();
    expect(loadPrintPrefs(null)).toEqual({});
  });
});

describe("dialog wiring (source pins)", () => {
  it("Paper is no longer seeded from the document's page size", () => {
    expect(MODAL).not.toMatch(/nearestPaperKey/);
  });
  it("Paper follows the selected printer's loaded paper unless the user chose one", () => {
    expect(MODAL).toMatch(/selectedPrinter\.defaultPaper \?\? "letter"/);
    expect(MODAL).toMatch(/if \(!selectedPrinter \|\| loadPrintPrefs\(\)\.paper\) return;/);
  });
  it("only user changes are remembered (controls get userDispatch)", () => {
    expect(MODAL).toMatch(/dispatch=\{userDispatch\}/);
    expect(MODAL).toMatch(/usePrintReducer\(initialPrefs\)/);
  });
  it("Full page works at 2/4/6/9 per sheet (V1.0128) — only Fit-all disables it", () => {
    expect(MODAL).toMatch(/"set-full-page", value: true \}\)\}\s*disabled=\{disabled \|\| settings\.layout === "fit"\}/);
    expect(MODAL).toMatch(/"set-full-page", value: false \}\)\}\s*disabled=\{disabled \|\| settings\.layout === "fit"\}/);
    expect(MODAL).not.toMatch(/settings\.layout !== 1/);
    expect(MODAL).toMatch(/if \(settings\.fullPage\) \{\s*try \{\s*bytes = await ops\.trimPagesToContentForPrint\(bytes\);/);
  });
  it("the driver is told not to rescale the job (preview = printout)", () => {
    expect(MAIN).toMatch(/args\.push\("-o", "print-scaling=none"\)/);
  });
});

/** An A4 portrait page with a black bar hugging the LEFT edge — the strip
 *  that went missing on Adam's printout. */
async function a4Doc(pages = 2) {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const p = d.addPage([595.92, 841.92]);
    p.drawRectangle({ x: 0, y: 0, width: 20, height: 841.92, color: rgb(0, 0, 0) });
  }
  return d.save();
}

describe("Adam's job: A4 invoice, 2 per sheet, landscape, Brother with Letter", () => {
  it("the sheet sent to the printer is exactly Letter landscape — nothing can fall off", async () => {
    // What the dialog now picks: Paper = the printer's loaded paper.
    const paper = parseCupsDefaultPageSize(BROTHER_LPOPTIONS)!;
    const out = await ops.nUpPages(await a4Doc(), 2, { paper, orientation: "landscape" });
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect(Math.round(width)).toBe(792);
    expect(Math.round(height)).toBe(612);
  });

  it("control: the OLD choice (Paper = document's A4) builds a sheet wider than Letter", async () => {
    const out = await ops.nUpPages(await a4Doc(), 2, { paper: "a4", orientation: "landscape" });
    const { width } = (await PDFDocument.load(out)).getPage(0).getSize();
    // 842 pt laid onto 792 pt of paper → ~50 pt (≈18 mm) cut off.
    expect(width).toBeGreaterThan(792 + 40);
  });

  it("1 per sheet, Full page OFF: an A4 page is fitted onto Letter, not clipped", async () => {
    const out = await ops.fitToPaper(await a4Doc(1), "letter", { orientation: "portrait" });
    const { width, height } = (await PDFDocument.load(out)).getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([612, 792]);
  });
});

describe("printer margins", () => {
  it("1-up fit keeps the 18 pt unprintable border, like n-up and Full page", () => {
    expect(MODAL).toMatch(/orientation: settings\.orientation,\s*margin: 18,/);
  });
});
