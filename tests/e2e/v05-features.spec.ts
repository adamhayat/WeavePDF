import { test, expect } from "@playwright/test";
import { launchApp, openFixture, ensureFixturesExist, fixturePath } from "./helpers";
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { PDFDocument } from "pdf-lib";

test.beforeAll(() => {
  ensureFixturesExist();
});

const packagedWeavePDF = path.join(
  __dirname,
  "..",
  "..",
  "out",
  "WeavePDF-darwin-arm64",
  "WeavePDF.app",
  "Contents",
  "MacOS",
  "WeavePDF",
);

// ─── Find/Replace ─────────────────────────────────────────────────────────

test("find bar shows match counter for text in fixture", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await page.keyboard.press("Meta+f");
    await page.waitForSelector('input[placeholder="Find in document"]');
    await page.fill('input[placeholder="Find in document"]', "page");
    // Wait for the "N of M" counter to appear (any number ≥ 1).
    await expect(page.locator("text=/\\d+\\s+of\\s+\\d+/")).toBeVisible({ timeout: 10_000 });
  } finally {
    await app.close();
  }
});

test("replace toggle reveals replacement input", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await page.keyboard.press("Meta+f");
    await page.fill('input[placeholder="Find in document"]', "page");
    await page.click('[data-testid="toggle-replace"]');
    await expect(page.locator('[data-testid="replace-input"]')).toBeVisible();
  } finally {
    await app.close();
  }
});

// ─── Tabs: close-to-one ──────────────────────────────────────────────────

test("closing tabs one at a time leaves the remaining one active", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await openFixture(page, "sample-short.pdf");
    await openFixture(page, "sample.pdf");
    const tabCount = await page.locator('[data-testid="tab"]').count();
    expect(tabCount).toBe(3);
    const closeButtons = page.locator('[data-testid="tab-close"]');
    await closeButtons.nth(0).click({ force: true });
    await closeButtons.nth(0).click({ force: true });
    await expect(page.locator('[data-testid="tab"]')).toHaveCount(1);
  } finally {
    await app.close();
  }
});

// ─── Outline collapse/expand ──────────────────────────────────────────────

test("outline tab shows either tree or empty-state", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await page.click('[data-testid="sidebar-tab-outline"]');
    // Outline fixture may have no bookmarks — both are valid outcomes.
    const panel = page.getByTestId("outline-panel");
    const noOutline = page.getByText(/has no bookmarks/i);
    await expect(panel.or(noOutline).first()).toBeVisible({ timeout: 10_000 });
  } finally {
    await app.close();
  }
});

// ─── PKCS#7 digital signatures ────────────────────────────────────────────

test("digital-sign IPC: genCert + signPdf end-to-end", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    const fixPath = fixturePath("sample.pdf");
    const result = await page.evaluate(
      async (fp: string): Promise<{ ok: boolean; beforeSize?: number; afterSize?: number; err?: string; skipped?: boolean }> => {
        try {
          await window.weavepdf.digitalSig.clearCert();
          try {
            await window.weavepdf.digitalSig.genCert({
              name: "QA Tester",
              email: "qa@example.com",
              years: 1,
            });
          } catch (err) {
            // Ad-hoc-signed Electron test builds can lack Keychain; we
            // refuse to store a signing key without it. That's expected.
            if (/Keychain/i.test((err as Error).message ?? "")) {
              return { ok: true, skipped: true };
            }
            throw err;
          }
          // @ts-expect-error test bless hook
          await window.weavepdf.__testBless(fp);
          const file = await window.weavepdf.readFile(fp);
          const signed = await window.weavepdf.digitalSig.signPdf(file.data, {
            reason: "QA smoke",
            location: "CI",
          });
          return {
            ok: true,
            beforeSize: file.data.byteLength,
            afterSize: signed.byteLength,
          };
        } catch (err) {
          return { ok: false, err: (err as Error).message ?? String(err) };
        } finally {
          try {
            await window.weavepdf.digitalSig.clearCert();
          } catch {
            /* ignore */
          }
        }
      },
      fixPath,
    );
    expect(result.ok).toBe(true);
    if (!result.skipped) {
      expect((result.afterSize ?? 0) - (result.beforeSize ?? 0)).toBeGreaterThan(5000);
    }
  } finally {
    await app.close();
  }
});

test("digital-sign modal renders cert form when no cert", async () => {
  const { app, page } = await launchApp();
  try {
    await page.evaluate(async () => {
      await window.weavepdf.digitalSig.clearCert();
    });
    await openFixture(page, "sample.pdf");
    await page.keyboard.press("Meta+k");
    await page.fill('input[placeholder*="Search commands"]', "digital");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("digital-sign-modal")).toBeVisible();
    await expect(page.getByTestId("sig-name")).toBeVisible();
    await expect(page.getByTestId("sig-email")).toBeVisible();
  } finally {
    await app.close();
  }
});

// ─── Signature (image) fallback write ─────────────────────────────────────

test("signature:set works without throwing (Keychain or raw fallback)", async () => {
  const { app, page } = await launchApp();
  try {
    const result = await page.evaluate(async () => {
      try {
        await window.weavepdf.signature.set(
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        );
        const loaded = await window.weavepdf.signature.get();
        await window.weavepdf.signature.clear();
        return { ok: true, loaded: loaded?.slice(0, 22) };
      } catch (err) {
        return { ok: false, err: (err as Error).message };
      }
    });
    expect(result.ok).toBe(true);
    expect(result.loaded).toBe("data:image/png;base64,");
  } finally {
    await app.close();
  }
});

test("signature:set rejects non-image data URLs", async () => {
  const { app, page } = await launchApp();
  try {
    const result = await page.evaluate(async () => {
      try {
        await window.weavepdf.signature.set("data:text/html;base64,PGgxPm5vPC9oMT4=");
        return { ok: true };
      } catch (err) {
        return { ok: false, err: (err as Error).message ?? String(err) };
      }
    });
    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/PNG|JPEG|data URL/i);
  } finally {
    await app.close();
  }
});

test("path allowlist rejects symlinks into app userData", async () => {
  const { app, page } = await launchApp();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
  const sentinel = path.join(userData, `security-sentinel-${Date.now()}.txt`);
  const link = path.join(os.tmpdir(), `weavepdf-userdata-link-${Date.now()}`);
  writeFileSync(sentinel, "secret");
  symlinkSync(sentinel, link);
  try {
    const result = await page.evaluate(async (p: string) => {
      try {
        // @ts-expect-error test bless hook
        await window.weavepdf.__testBless(p);
        await window.weavepdf.readFile(p);
        return { ok: true };
      } catch (err) {
        return { ok: false, err: (err as Error).message ?? String(err) };
      }
    }, link);
    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/userData|not permitted/i);
  } finally {
    rmSync(link, { force: true });
    rmSync(sentinel, { force: true });
    await app.close();
  }
});

test("opened PDFs are Save-As protected until the user chooses an output path", async () => {
  const { app, page } = await launchApp();
  const out = path.join(os.tmpdir(), `weavepdf-save-protected-${Date.now()}.pdf`);
  try {
    await openFixture(page, "sample.pdf");
    const before = await page.evaluate(() => window.__weavepdfTest__.getActiveTab()) as { saveInPlace?: boolean; path?: string | null } | null;
    expect(before?.saveInPlace).toBe(false);
    const saved = await page.evaluate((p: string) => window.__weavepdfTest__.saveActiveAs(p), out);
    expect(saved).toBe(true);
    const after = await page.evaluate(() => window.__weavepdfTest__.getActiveTab()) as { saveInPlace?: boolean; path?: string | null } | null;
    expect(after?.saveInPlace).toBe(true);
    expect(after?.path).toBe(out);
  } finally {
    if (existsSync(out)) rmSync(out, { force: true });
    await app.close();
  }
});

// ─── CLI mode ─────────────────────────────────────────────────────────────

test.describe("CLI ops", () => {
  test("cli compress, rotate, extract-first write valid PDFs", async () => {
    if (!existsSync(packagedWeavePDF)) {
      test.skip(true, "Packaged app not found");
      return;
    }
    const input = fixturePath("sample.pdf");
    const outs = [
      path.join(os.tmpdir(), `weavepdf-cli-compress-${Date.now()}.pdf`),
      path.join(os.tmpdir(), `weavepdf-cli-rotate-${Date.now()}.pdf`),
      path.join(os.tmpdir(), `weavepdf-cli-first-${Date.now()}.pdf`),
    ];
    try {
      expect(spawnSync(packagedWeavePDF, ["--cli", "compress", input, outs[0]]).status).toBe(0);
      expect(spawnSync(packagedWeavePDF, ["--cli", "rotate", input, outs[1], "90"]).status).toBe(0);
      expect(spawnSync(packagedWeavePDF, ["--cli", "extract-first", input, outs[2]]).status).toBe(0);
      for (const o of outs) {
        expect(existsSync(o)).toBe(true);
        expect(readFileSync(o).slice(0, 4).toString("binary")).toBe("%PDF");
      }
    } finally {
      for (const o of outs) if (existsSync(o)) rmSync(o, { force: true });
    }
  });

  test("cli merge combines PDFs and images into one PDF", async () => {
    if (!existsSync(packagedWeavePDF)) {
      test.skip(true, "Packaged app not found");
      return;
    }
    const inputPdf = fixturePath("sample-short.pdf");
    const inputImage = path.join(os.tmpdir(), `weavepdf-cli-merge-img-${Date.now()}.png`);
    const out = path.join(os.tmpdir(), `weavepdf-cli-merge-mixed-${Date.now()}.pdf`);
    // 1x1 PNG fixture: tiny but exercises the same image embedding path used
    // by Finder's mixed PDF/image Quick Action.
    const tinyPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgwJ/lO+KJwAAAABJRU5ErkJggg==";
    try {
      writeFileSync(inputImage, Buffer.from(tinyPng, "base64"));
      const r = spawnSync(packagedWeavePDF, ["--cli", "merge", inputPdf, inputImage, inputPdf, out]);
      expect(r.status, r.stderr.toString("utf8")).toBe(0);
      expect(existsSync(out)).toBe(true);
      const merged = await PDFDocument.load(readFileSync(out));
      const source = await PDFDocument.load(readFileSync(inputPdf));
      expect(merged.getPageCount()).toBe(source.getPageCount() * 2 + 1);
    } finally {
      if (existsSync(inputImage)) rmSync(inputImage, { force: true });
      if (existsSync(out)) rmSync(out, { force: true });
    }
  });

  test("cli watermark stamps every page", async () => {
    if (!existsSync(packagedWeavePDF)) {
      test.skip(true, "Packaged app not found");
      return;
    }
    const input = fixturePath("sample.pdf");
    const out = path.join(os.tmpdir(), `weavepdf-cli-wm-${Date.now()}.pdf`);
    try {
      const r = spawnSync(packagedWeavePDF, ["--cli", "watermark", input, out, "DRAFT"]);
      expect(r.status).toBe(0);
      expect(existsSync(out)).toBe(true);
      // Bytes should grow since we added text on every page.
      expect(readFileSync(out).length).toBeGreaterThan(readFileSync(input).length);
    } finally {
      if (existsSync(out)) rmSync(out, { force: true });
    }
  });

  test("cli encrypt + decrypt round-trips to identical page count", async () => {
    if (!existsSync(packagedWeavePDF)) {
      test.skip(true, "Packaged app not found");
      return;
    }
    const input = fixturePath("sample.pdf");
    const enc = path.join(os.tmpdir(), `weavepdf-cli-enc-${Date.now()}.pdf`);
    const dec = path.join(os.tmpdir(), `weavepdf-cli-dec-${Date.now()}.pdf`);
    try {
      const e = spawnSync(packagedWeavePDF, ["--cli", "encrypt", input, enc, "-"], {
        input: "hunter2\n",
      });
      expect(e.status).toBe(0);
      const d = spawnSync(packagedWeavePDF, ["--cli", "decrypt", enc, dec, "-"], {
        input: "hunter2\n",
      });
      expect(d.status).toBe(0);
      // Both should be valid PDFs.
      expect(readFileSync(enc).slice(0, 4).toString("binary")).toBe("%PDF");
      expect(readFileSync(dec).slice(0, 4).toString("binary")).toBe("%PDF");
    } finally {
      if (existsSync(enc)) rmSync(enc, { force: true });
      if (existsSync(dec)) rmSync(dec, { force: true });
    }
  });

  test("cli unknown op exits non-zero", async () => {
    if (!existsSync(packagedWeavePDF)) {
      test.skip(true, "Packaged app not found");
      return;
    }
    const r = spawnSync(packagedWeavePDF, ["--cli", "nonsense", "a", "b"]);
    expect(r.status).not.toBe(0);
  });
});

// ─── DOC / DOCX import ────────────────────────────────────────────────────

test("convertDocToPdf IPC turns a tiny RTF into a valid PDF", async () => {
  const { app, page } = await launchApp();
  try {
    const rtf = path.join(os.tmpdir(), `weavepdf-test-${Date.now()}.rtf`);
    writeFileSync(
      rtf,
      "{\\rtf1\\ansi\\deff0 {\\fonttbl{\\f0 Helvetica;}} \\f0\\fs24 Hello WeavePDF.}",
    );
    try {
      const header = await page.evaluate(async (rtfPath: string) => {
        // @ts-expect-error test bless hook
        await window.weavepdf.__testBless(rtfPath);
        const file = await window.weavepdf.readFile(rtfPath);
        const pdfBytes = await window.weavepdf.convertDocToPdf(file.data, file.name);
        return Array.from(new Uint8Array(pdfBytes).slice(0, 4));
      }, rtf);
      expect(header).toEqual([0x25, 0x50, 0x44, 0x46]);
    } finally {
      rmSync(rtf, { force: true });
    }
  } finally {
    await app.close();
  }
});

// ─── Text-to-DOCX IPC ─────────────────────────────────────────────────────

test("convertTextToDocx IPC writes a valid .docx zip", async () => {
  const { app, page } = await launchApp();
  try {
    const head = await page.evaluate(async () => {
      const docx = await window.weavepdf.convertTextToDocx("Hello WeavePDF from QA.");
      // .docx is a zip — starts with PK\x03\x04.
      return Array.from(new Uint8Array(docx).slice(0, 4));
    });
    expect(head.slice(0, 2)).toEqual([0x50, 0x4b]);
  } finally {
    await app.close();
  }
});

// ─── Pending image layer ──────────────────────────────────────────────────

test("paste-text places a pending text edit", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    // Dispatch a ClipboardEvent with a plain-text payload at the window level.
    await page.evaluate(() => {
      const ev = new ClipboardEvent("paste", { clipboardData: new DataTransfer() });
      ev.clipboardData?.setData("text/plain", "Pasted test string");
      Object.defineProperty(ev, "target", { value: document.body });
      window.dispatchEvent(ev);
    });
    // The pending text overlay should render inside the viewer.
    await expect(
      page.getByTestId("pending-text").filter({ hasText: "Pasted test string" }),
    ).toBeVisible({ timeout: 5_000 });
  } finally {
    await app.close();
  }
});

// ─── Redaction mode activation ───────────────────────────────────────────

test("redact tool is discoverable from the command palette", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await page.keyboard.press("Meta+k");
    await page.fill('input[placeholder*="Search commands"]', "redact");
    // The palette should surface the Redact region action.
    await expect(page.getByText("Redact region").first()).toBeVisible();
  } finally {
    await app.close();
  }
});

test("link popover rejects unsafe URL schemes", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    await page.getByTestId("tool-link").click();
    const layer = page.getByTestId("interaction-layer").first();
    const box = await layer.boundingBox();
    expect(box).toBeTruthy();
    if (!box) return;
    await page.mouse.move(box.x + 80, box.y + 80);
    await page.mouse.down();
    await page.mouse.move(box.x + 190, box.y + 125);
    await page.mouse.up();
    await expect(page.getByTestId("link-popover")).toBeVisible();
    await page.getByTestId("link-url-input").fill("javascript:alert(1)");
    await page.getByTestId("link-apply").click();
    await expect(page.getByText(/http, https, or mailto/i)).toBeVisible();
  } finally {
    await app.close();
  }
});

// ─── OCR availability check ──────────────────────────────────────────────

test("ocr helper is bundled + available", async () => {
  const { app, page } = await launchApp();
  try {
    const avail = await page.evaluate(() => window.weavepdf.ocr.available());
    expect(avail).toBe(true);
  } finally {
    await app.close();
  }
});

test("ai helper (Apple Intelligence) is bundled + available", async () => {
  const { app, page } = await launchApp();
  try {
    const avail = await page.evaluate(() => window.weavepdf.ai.available());
    // On dev machines without Xcode this is false; we built it, so expect true here.
    // If someone runs the suite on a CLT-only machine, skip rather than fail.
    if (!avail) test.skip(true, "ai-bin not built (needs full Xcode)");
    expect(avail).toBe(true);
  } finally {
    await app.close();
  }
});

test("ai IPC: summarize round-trips through FoundationModels", async () => {
  const { app, page } = await launchApp();
  try {
    const avail = await page.evaluate(() => window.weavepdf.ai.available());
    if (!avail) test.skip(true, "ai-bin not built");
    const result = await page.evaluate(async () => {
      try {
        const text = await window.weavepdf.ai.run(
          "summarize",
          "This is a three-sentence test document. Apple Intelligence should summarize it briefly. The summary should mention Apple Intelligence.",
        );
        return { ok: true, text: text.slice(0, 400) };
      } catch (err) {
        return { ok: false, err: (err as Error).message ?? String(err) };
      }
    });
    expect(result.ok).toBe(true);
    expect((result.text ?? "").length).toBeGreaterThan(10);
  } finally {
    await app.close();
  }
});

// ─── qpdf + ghostscript availability ─────────────────────────────────────

test("qpdf helpers are detected (after brew install qpdf)", async () => {
  const { app, page } = await launchApp();
  try {
    const avail = await page.evaluate(() => window.weavepdf.qpdf.available());
    // We've installed qpdf in this environment — but gracefully skip if missing.
    if (!avail) test.skip(true, "qpdf not installed in this env");
    expect(avail).toBe(true);
  } finally {
    await app.close();
  }
});

test("ghostscript helpers are detected (after brew install ghostscript)", async () => {
  const { app, page } = await launchApp();
  try {
    const avail = await page.evaluate(() => window.weavepdf.ghostscript.available());
    if (!avail) test.skip(true, "ghostscript not installed in this env");
    expect(avail).toBe(true);
  } finally {
    await app.close();
  }
});

// ─── Reading-order copy ──────────────────────────────────────────────────

test("copy handler registered on the viewer (smoke)", async () => {
  const { app, page } = await launchApp();
  try {
    await openFixture(page, "sample.pdf");
    // Copying without a selection should fall through to default behavior,
    // not throw. This is a smoke check that the handler doesn't crash.
    const result = await page.evaluate(() => {
      try {
        const ev = new ClipboardEvent("copy", { clipboardData: new DataTransfer() });
        document.dispatchEvent(ev);
        return "ok";
      } catch (err) {
        return (err as Error).message;
      }
    });
    expect(result).toBe("ok");
  } finally {
    await app.close();
  }
});
