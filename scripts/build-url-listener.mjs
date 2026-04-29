// Compiles resources/helpers/url-listener.swift → resources/helpers/url-listener-bin.
// The helper listens for Finder Sync distributed notifications and prints
// weavepdf:// URLs to stdout so the Electron main process can handle
// already-running right-click actions without NSWorkspace.open activation.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const src = path.join(root, "resources", "helpers", "url-listener.swift");
const out = path.join(root, "resources", "helpers", "url-listener-bin");

if (!existsSync(src)) {
  console.error(`Missing source: ${src}`);
  process.exit(1);
}

console.log(`Compiling ${path.relative(root, src)} → ${path.relative(root, out)}`);

const proc = spawn("swiftc", ["-O", src, "-o", out], {
  stdio: "inherit",
});

proc.on("error", (err) => {
  console.error("swiftc not available — install Xcode Command Line Tools:");
  console.error("  xcode-select --install");
  console.error(`(${err.message})`);
  process.exit(1);
});

proc.on("exit", async (code) => {
  if (code !== 0) {
    console.error(`swiftc exited with code ${code}`);
    process.exit(code ?? 1);
  }
  const size = (await stat(out)).size;
  console.log(`Built ${out} (${(size / 1024).toFixed(0)} KB)`);
});
