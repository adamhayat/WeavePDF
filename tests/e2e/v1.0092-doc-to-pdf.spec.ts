// V1.0092 — Finder right-click "Convert to PDF" now accepts .doc / .docx /
// .rtf / .txt / .odt in addition to images. The pipeline is the textutil →
// hidden BrowserWindow → printToPDF flow that already shipped for in-app
// DOCX import; V1.0092 extracted it into a module-top-level helper that
// both the IPC handler AND the new `doc-to-pdf` runCli op call.
//
// Two specs:
//   1. IPC path  — exercises `window.weavepdf.convertDocToPdf` (covers the
//      in-app open-DOCX-as-PDF flow and, via the shared helper, the right-
//      click path).
//   2. CLI path  — spawns the packaged binary with
//      `--cli doc-to-pdf in.rtf out.pdf` (the exact verb the
//      `weavepdf://convert` URL dispatcher calls for doc-class files).

import { test, expect } from "@playwright/test";
import { existsSync, writeFileSync, unlinkSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { launchApp } from "./helpers";

// Smallest valid RTF — textutil parses this cleanly.
const tinyRtf = String.raw`{\rtf1\ansi\deff0 Hello WeavePDF V1.0092 doc-to-pdf path.}`;

function resolveExecutable(): string {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const candidates = [
    path.join(repoRoot, "out", "WeavePDF-darwin-arm64", "WeavePDF.app", "Contents", "MacOS", "WeavePDF"),
    path.join(repoRoot, "out", "WeavePDF-darwin-x64", "WeavePDF.app", "Contents", "MacOS", "WeavePDF"),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  throw new Error("Packaged WeavePDF app not found. Run `npm run package` first.");
}

test("V1.0092 #1: window.weavepdf.convertDocToPdf converts RTF bytes to a valid PDF", async () => {
  const { app, page } = await launchApp();
  try {
    const rtfBase64 = Buffer.from(tinyRtf, "utf8").toString("base64");
    const result = await page.evaluate(async (b64: string) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const ab = await window.weavepdf.convertDocToPdf(bytes.buffer, "test.rtf");
      const u8 = new Uint8Array(ab);
      // Return first 8 bytes as a string + total length so the test runner
      // can verify the %PDF magic without shipping the whole buffer back.
      const head = String.fromCharCode(...u8.slice(0, 8));
      return { head, length: u8.length };
    }, rtfBase64);
    expect(result.head.startsWith("%PDF-")).toBe(true);
    expect(result.length).toBeGreaterThan(500);
  } finally {
    await app.close();
  }
});

test("V1.0092 #2: --cli doc-to-pdf in.rtf out.pdf produces a valid PDF on disk", async () => {
  const exe = resolveExecutable();
  const tmpDir = os.tmpdir();
  const inPath = path.join(tmpDir, `weavepdf-v1.0092-${Date.now()}.rtf`);
  const outPath = path.join(tmpDir, `weavepdf-v1.0092-${Date.now()}.pdf`);
  writeFileSync(inPath, tinyRtf, "utf8");
  try {
    // CLI mode spawns a headless Electron, runs the op, and exits. printToPDF
    // needs app.whenReady + a BrowserWindow, which CLI mode happily supports.
    const result = spawnSync(exe, ["--cli", "doc-to-pdf", inPath, outPath], {
      timeout: 30_000,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    const bytes = readFileSync(outPath);
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(statSync(outPath).size).toBeGreaterThan(500);
  } finally {
    if (existsSync(inPath)) unlinkSync(inPath);
    if (existsSync(outPath)) unlinkSync(outPath);
  }
});
