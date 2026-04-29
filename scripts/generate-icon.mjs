// Rasterises resources/icon.svg into every size macOS needs, then runs
// `iconutil` to pack the .iconset folder into a real .icns.
// Run: node scripts/generate-icon.mjs
import sharp from "sharp";
import { readFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const svgPath = path.join(repoRoot, "resources", "icon.svg");
const iconsetDir = path.join(repoRoot, "resources", "icon.iconset");
const icnsPath = path.join(repoRoot, "resources", "icon.icns");
const pngForForge = path.join(repoRoot, "resources", "icon.png");

// Standard macOS .iconset naming convention (iconutil requires these names).
const sizes = [
  { name: "icon_16x16.png", px: 16 },
  { name: "icon_16x16@2x.png", px: 32 },
  { name: "icon_32x32.png", px: 32 },
  { name: "icon_32x32@2x.png", px: 64 },
  { name: "icon_128x128.png", px: 128 },
  { name: "icon_128x128@2x.png", px: 256 },
  { name: "icon_256x256.png", px: 256 },
  { name: "icon_256x256@2x.png", px: 512 },
  { name: "icon_512x512.png", px: 512 },
  { name: "icon_512x512@2x.png", px: 1024 },
];

async function main() {
  if (!existsSync(svgPath)) {
    throw new Error(`icon.svg missing at ${svgPath}`);
  }
  const svg = await readFile(svgPath);

  await rm(iconsetDir, { recursive: true, force: true });
  await mkdir(iconsetDir, { recursive: true });

  for (const s of sizes) {
    await sharp(svg, { density: 720 })
      .resize(s.px, s.px)
      .png({ compressionLevel: 9 })
      .toFile(path.join(iconsetDir, s.name));
    console.log(`  ${s.name.padEnd(22)} ${s.px}×${s.px}`);
  }

  // 1024×1024 flat PNG for anywhere that wants a single image.
  await sharp(svg, { density: 720 })
    .resize(1024, 1024)
    .png({ compressionLevel: 9 })
    .toFile(pngForForge);
  console.log(`  icon.png               1024×1024`);

  // Pack into .icns via the built-in macOS tool.
  const r = spawnSync("iconutil", ["-c", "icns", iconsetDir, "-o", icnsPath], {
    stdio: "inherit",
  });
  if (r.status !== 0) {
    throw new Error(`iconutil failed with exit ${r.status}`);
  }
  console.log(`wrote ${path.relative(repoRoot, icnsPath)}`);
}

await main();
