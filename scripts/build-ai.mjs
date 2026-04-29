// Compiles resources/helpers/ai.swift → resources/helpers/ai-bin using
// the full Xcode SDK (not Command Line Tools). FoundationModels is only
// shipped with the Xcode developer SDK as of macOS 15 / Xcode 16.
//
// Prerequisite: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
//
// Run once after editing ai.swift, before packaging.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const src = path.join(root, "resources", "helpers", "ai.swift");
const out = path.join(root, "resources", "helpers", "ai-bin");

if (!existsSync(src)) {
  console.error(`Missing source: ${src}`);
  process.exit(1);
}

console.log(`Compiling ${path.relative(root, src)} → ${path.relative(root, out)}`);

// We set DEVELOPER_DIR in case the global xcode-select still points at CLT;
// this makes the build work even before `sudo xcode-select -s` has run.
const env = { ...process.env };
if (!env.DEVELOPER_DIR && existsSync("/Applications/Xcode.app/Contents/Developer")) {
  env.DEVELOPER_DIR = "/Applications/Xcode.app/Contents/Developer";
}

const proc = spawn("swiftc", ["-O", src, "-o", out], {
  stdio: "inherit",
  env,
});

proc.on("error", (err) => {
  console.error("swiftc not available:", err.message);
  console.error("Install full Xcode + run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer");
  process.exit(1);
});

proc.on("exit", async (code) => {
  if (code !== 0) {
    console.error(`swiftc exited with code ${code}`);
    console.error("If you see a 'no such module FoundationModels' error, you need full Xcode (not CLT).");
    process.exit(code ?? 1);
  }
  const size = (await stat(out)).size;
  console.log(`Built ${out} (${(size / 1024).toFixed(0)} KB)`);
});
