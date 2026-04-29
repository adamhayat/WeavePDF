// Generates test fixtures used by manual QA and E2E tests.
// Run via: node scripts/generate-fixtures.mjs
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "resources", "fixtures");
await mkdir(fixturesDir, { recursive: true });

// --- sample.pdf: 5 pages, searchable, with distinct per-page tokens ---
{
  const pdf = await PDFDocument.create();
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Shared marker "banana" appears on pages 2 and 3 only — used to assert search counts = 2.
  const pages = [
    { title: "Title Page", body: "Welcome to WeavePDF. A local, Mac-native PDF editor." },
    { title: "Chapter 1", body: "The banana is a fruit. Testing text extraction for search." },
    { title: "Chapter 2", body: "Another banana reference, same page as others. More text to select." },
    { title: "Chapter 3", body: "No fruit here. Lorem ipsum dolor sit amet, consectetur adipiscing elit." },
    { title: "Final Page", body: "End of document. Thanks for reading the WeavePDF sample." },
  ];

  for (const [i, { title, body }] of pages.entries()) {
    const page = pdf.addPage([612, 792]); // US Letter
    page.drawText(`Page ${i + 1}`, {
      x: 50, y: 740, size: 10, font: helv, color: rgb(0.45, 0.45, 0.45),
    });
    page.drawText(title, {
      x: 50, y: 700, size: 28, font: helvBold, color: rgb(0.08, 0.08, 0.1),
    });
    page.drawText(body, {
      x: 50, y: 650, size: 14, font: helv, color: rgb(0.18, 0.18, 0.22),
    });
    page.drawText(
      "Line 2 — some more text so selection has range.",
      { x: 50, y: 620, size: 12, font: helv, color: rgb(0.3, 0.3, 0.35) },
    );
  }

  const bytes = await pdf.save();
  await writeFile(join(fixturesDir, "sample.pdf"), bytes);
  console.log(`wrote sample.pdf (${bytes.length} bytes, ${pages.length} pages)`);
}

// --- sample-short.pdf: 1 page, minimal — used for tab-switching tests ---
{
  const pdf = await PDFDocument.create();
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText("Short Document", {
    x: 50, y: 740, size: 28, font: helv, color: rgb(0.08, 0.08, 0.1),
  });
  page.drawText("Single-page fixture for multi-tab testing.", {
    x: 50, y: 700, size: 14, font: helv, color: rgb(0.3, 0.3, 0.35),
  });
  const bytes = await pdf.save();
  await writeFile(join(fixturesDir, "sample-short.pdf"), bytes);
  console.log(`wrote sample-short.pdf (${bytes.length} bytes)`);
}
