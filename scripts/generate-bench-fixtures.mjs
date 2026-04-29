// Generates benchmark fixtures used by tests/e2e/perf.spec.ts.
//
// Three sizes — 10p, 100p, 500p — each with realistic-ish content (heading,
// body paragraph, page number) so pdf.js does meaningful parsing/text-layer
// work. Deterministic output for reproducible benchmarks across runs.
//
// Run: node scripts/generate-bench-fixtures.mjs
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "resources", "fixtures");
await mkdir(fixturesDir, { recursive: true });

async function buildFixture(pageCount) {
  const pdf = await PDFDocument.create();
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Synthetic content — a heading, a few paragraphs, and a footer per page.
  // Roughly mirrors the density of a typical scanned/born-digital report,
  // so pdf.js parsing time per page is in the same ballpark as real-world
  // documents (vs. blank pages which would parse trivially).
  const para = (i) =>
    `Section ${i}: Lorem ipsum dolor sit amet, consectetur adipiscing elit. ` +
    "Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. " +
    "Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris " +
    "nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in " +
    "reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla.";

  for (let i = 0; i < pageCount; i++) {
    const page = pdf.addPage([612, 792]);
    page.drawText(`Page ${i + 1}`, {
      x: 50, y: 740, size: 10, font: helv, color: rgb(0.45, 0.45, 0.45),
    });
    page.drawText(`Benchmark Document — Section ${i + 1}`, {
      x: 50, y: 700, size: 22, font: helvBold, color: rgb(0.08, 0.08, 0.1),
    });
    // Two paragraphs per page; pdf-lib doesn't auto-wrap, so we manually
    // split into lines that fit the page width.
    const body = para(i + 1);
    const words = body.split(" ");
    let line = "";
    let y = 660;
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (helv.widthOfTextAtSize(test, 12) > 512) {
        page.drawText(line, { x: 50, y, size: 12, font: helv, color: rgb(0.18, 0.18, 0.22) });
        line = w;
        y -= 18;
        if (y < 100) break;
      } else {
        line = test;
      }
    }
    if (line && y >= 100) {
      page.drawText(line, { x: 50, y, size: 12, font: helv, color: rgb(0.18, 0.18, 0.22) });
    }
    page.drawText(`${i + 1} / ${pageCount}`, {
      x: 540, y: 50, size: 9, font: helv, color: rgb(0.55, 0.55, 0.55),
    });
  }

  return pdf.save();
}

for (const n of [10, 100, 500]) {
  const bytes = await buildFixture(n);
  const filename = `bench-${n}p.pdf`;
  await writeFile(join(fixturesDir, filename), bytes);
  console.log(`wrote ${filename} (${(bytes.length / 1024).toFixed(1)} KB, ${n} pages)`);
}
