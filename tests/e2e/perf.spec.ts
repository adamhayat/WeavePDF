import { test } from "@playwright/test";
import { launchApp, fixturePath } from "./helpers";
import { existsSync } from "node:fs";

// Benchmark harness for PDF cold-load. Captures timings for each stage of
// the loadAsTab pipeline against three sizes (10p / 100p / 500p) so we can
// identify the slowest stage and verify whether targeted optimizations
// actually move the needle.
//
// Run via:
//   node scripts/generate-bench-fixtures.mjs   # one-time, creates fixtures
//   npm run package:test                        # build VITE_E2E=1 .app
//   npx playwright test perf.spec.ts --reporter=line
//
// Stages measured (mirroring src/renderer/App.tsx's loadAsTab):
//   - blessMs   — IPC roundtrip to bless the path with the security allowlist
//   - readMs    — IPC roundtrip to read file bytes from main → renderer
//   - parseMs   — pdfjsLib.getDocument({ data }).promise (worker parse)
//   - addTabMs  — Zustand state update
//   - totalMs   — sum, end-to-end excluding render
//
// First-page render time is harder to measure from outside React; left out
// of v1 of this harness. The parse stage is typically the dominant cost.

const FIXTURES = [
  { name: "bench-10p.pdf", pages: 10 },
  { name: "bench-100p.pdf", pages: 100 },
  { name: "bench-500p.pdf", pages: 500 },
];

const RUNS = 3;

test("PDF cold-load benchmark — three sizes, three runs each", async () => {
  for (const f of FIXTURES) {
    if (!existsSync(fixturePath(f.name))) {
      throw new Error(
        `Missing benchmark fixture ${f.name}. Run \`node scripts/generate-bench-fixtures.mjs\` first.`,
      );
    }
  }

  for (const f of FIXTURES) {
    const fpath = fixturePath(f.name);
    const runs: Array<Awaited<ReturnType<typeof oneRun>>> = [];

    // Cold-launch the app fresh for each fixture so prior parse caches
    // don't bias the timing. First run is "true cold"; subsequent runs in
    // the same launch may benefit from pdf.js worker warm-up + page cache.
    for (let i = 0; i < RUNS; i++) {
      const t = await oneRun(fpath);
      runs.push(t);
    }

    const summary = summarize(runs);
    // eslint-disable-next-line no-console
    console.log(`\n📊 ${f.name} (${f.pages}p, ${summary.sizeKB} KB) — median of ${RUNS} runs`);
    // eslint-disable-next-line no-console
    console.log(
      `   launch ${summary.launch}ms  bless ${summary.bless}ms  read ${summary.read}ms  ` +
        `parse ${summary.parse}ms  addTab ${summary.addTab}ms  →  PDF-pipeline ${summary.total}ms`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `   end-to-end cold (launch + pipeline): ${(summary.launch + summary.total).toFixed(1)}ms`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `   raw runs (launch+total ms): ${runs.map((r) => `${(r.launchMs + r.totalMs).toFixed(0)}`).join(", ")}`,
    );
  }
});

async function oneRun(filePath: string) {
  // Measure cold-launch separately from PDF parse so we can see whether the
  // user-perceived slowness lives in Electron startup vs. the PDF pipeline.
  const launchStart = performance.now();
  const { app, page } = await launchApp();
  const launchMs = performance.now() - launchStart;
  try {
    const loadTimings = await page.evaluate(async (p: string) => {
      return await window.__weavepdfTest__.benchmarkPdfLoad(p);
    }, filePath);
    return { ...loadTimings, launchMs: +launchMs.toFixed(2) };
  } finally {
    await app.close();
  }
}

type Run = Awaited<ReturnType<typeof oneRun>>;

function summarize(runs: Run[]) {
  const med = (key: keyof Run) => {
    const vals = runs.map((r) => Number(r[key])).sort((a, b) => a - b);
    return +vals[Math.floor(vals.length / 2)].toFixed(1);
  };
  return {
    launch: med("launchMs"),
    bless: med("blessMs"),
    read: med("readMs"),
    parse: med("parseMs"),
    addTab: med("addTabMs"),
    total: med("totalMs"),
    sizeKB: +(runs[0].sizeBytes / 1024).toFixed(1),
  };
}
