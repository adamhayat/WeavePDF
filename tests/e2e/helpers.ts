import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(__dirname, "..", "..");

function resolveExecutablePath(): string {
  const candidates = [
    path.join(repoRoot, "out", "WeavePDF-darwin-arm64", "WeavePDF.app", "Contents", "MacOS", "WeavePDF"),
    path.join(repoRoot, "out", "WeavePDF-darwin-x64", "WeavePDF.app", "Contents", "MacOS", "WeavePDF"),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  throw new Error(
    `Packaged WeavePDF app not found. Run \`npm run package\` first.\nSearched:\n  ${candidates.join("\n  ")}`,
  );
}

export async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const executablePath = resolveExecutablePath();
  const app = await electron.launch({ executablePath, timeout: 30_000 });
  const page = await app.firstWindow({ timeout: 30_000 });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(
    () => typeof window.__weavepdfTest__?.openPdfByPath === "function",
    undefined,
    { timeout: 15_000 },
  );
  return { app, page };
}

export function fixturePath(name: string): string {
  return path.join(repoRoot, "resources", "fixtures", name);
}

export async function openFixture(page: Page, fixtureName: string): Promise<void> {
  const p = fixturePath(fixtureName);
  if (!existsSync(p)) {
    throw new Error(`Fixture missing: ${p}. Run \`node scripts/generate-fixtures.mjs\`.`);
  }
  await page.evaluate(async (filePath: string) => {
    await window.__weavepdfTest__.openPdfByPath(filePath);
  }, p);
}

export function ensureFixturesExist(): void {
  if (existsSync(fixturePath("sample.pdf"))) return;
  const r = spawnSync("node", ["scripts/generate-fixtures.mjs"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error("Failed to generate fixtures");
}
