#!/usr/bin/env node
// Builds the WeavePDF Finder Sync app extension.
//
//   Input:  resources/extensions/finder-sync.swift
//   Output: out/build-finder-sync/WeavePDFFinderSync.appex/
//
// The Forge postPackage hook (forge.config.ts) calls this script after every
// `npm run package`, then copies the .appex into
// `out/<name>-darwin-<arch>/WeavePDF.app/Contents/PlugIns/` and ad-hoc-signs
// the parent .app so its codesign hash includes the new content.
//
// macOS auto-discovers extensions inside an installed app's PlugIns directory.
// User then enables it once via System Settings → Login Items & Extensions →
// Finder. After that, right-click on a PDF/image in Finder shows a "WeavePDF"
// entry with a hover submenu (Compress / Combine into PDF / Convert to PDF /
// Extract first page / Rotate 90°).
//
// Requirements: macOS, Xcode CLT (for `swiftc` and `codesign`). The full
// Xcode app is NOT required — unlike `ai-bin`, the FinderSync framework
// ships with the CLT.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const swiftSrc = join(repoRoot, "resources/extensions/finder-sync.swift");
const buildDir = join(repoRoot, "out/build-finder-sync");
const appex = join(buildDir, "WeavePDFFinderSync.appex");
const macosDir = join(appex, "Contents/MacOS");
const binaryPath = join(macosDir, "WeavePDFFinderSync");
const plistPath = join(appex, "Contents/Info.plist");

if (!existsSync(swiftSrc)) {
  console.error(`error: missing Swift source at ${swiftSrc}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const version = pkg.version;
const bundleId = "ca.adamhayat.weavepdf.FinderSync";

console.log(`Building WeavePDF Finder Sync extension v${version}...`);

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(macosDir, { recursive: true });

// 1. Compile Swift → mach-O binary.
//
// `-application-extension` is critical: it limits the binary to APIs allowed
// in extensions (no `NSApp`-driven event loop, etc.) and lets macOS load it
// inside a host process. Without this flag, `pluginkit` rejects the bundle.
try {
  execFileSync(
    "swiftc",
    [
      "-O",
      "-application-extension",
      "-target",
      "arm64-apple-macosx11.0",
      "-framework",
      "AppKit",
      "-framework",
      "FinderSync",
      "-module-name",
      "WeavePDFFinderSync",
      // Without this, swiftc produces a binary whose main() returns
      // immediately and the extension process exits before Finder can
      // acquire a process assertion. Xcode's extension templates set this
      // via OTHER_LDFLAGS; we set it directly. _NSExtensionMain is exported
      // by the Foundation framework and runs the extension lifecycle (XPC
      // connection, principal class instantiation, run loop).
      "-Xlinker",
      "-e",
      "-Xlinker",
      "_NSExtensionMain",
      "-parse-as-library",
      "-o",
      binaryPath,
      swiftSrc,
    ],
    { stdio: "inherit" },
  );
} catch (e) {
  console.error("swiftc failed:", e.message);
  process.exit(1);
}
console.log(`  compiled: ${binaryPath}`);

// 2. Write Info.plist for the .appex.
//
// `NSExtensionPrincipalClass` is `<module>.<class>`. swiftc produces a Swift
// runtime class name from the module + the `class` declaration in source.
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>WeavePDF</string>
  <key>CFBundleExecutable</key>
  <string>WeavePDFFinderSync</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleId}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>WeavePDFFinderSync</string>
  <key>CFBundlePackageType</key>
  <string>XPC!</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionAttributes</key>
    <dict/>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.FinderSync</string>
    <key>NSExtensionPrincipalClass</key>
    <string>WeavePDFFinderSync.FinderSync</string>
  </dict>
</dict>
</plist>
`;
writeFileSync(plistPath, plist);
console.log(`  wrote: ${plistPath}`);

// Sanity check: plutil-lint the plist.
try {
  execFileSync("plutil", ["-lint", plistPath], { stdio: "inherit" });
} catch {
  console.error("Info.plist failed plutil-lint");
  process.exit(1);
}

// 3. Code-sign the .appex bundle WITH entitlements.
//
// Critical: pkd refuses to load any app extension that isn't sandboxed
// ("plug-ins must be sandboxed" in /var/log/system.log). The entitlements
// plist sets com.apple.security.app-sandbox=true and a few related keys.
// Without --entitlements here, codesign would produce an unsandboxed bundle
// that pkd silently rejects on every menu invocation.
//
// Signing identity is taken from the WEAVEPDF_SIGN_IDENTITY env var, set by
// forge.config.ts after detecting whether the user has run
// scripts/setup-local-signing.sh. Falls back to ad-hoc (`-`) for users who
// haven't installed the local signing identity. Stable identity means the
// same designated requirement across rebuilds, so the macOS Keychain stops
// prompting on every reinstall. For public distribution, swap for a real
// Developer ID + notarization.
const entitlements = join(repoRoot, "resources/extensions/finder-sync.entitlements");
if (!existsSync(entitlements)) {
  console.error(`error: missing entitlements at ${entitlements}`);
  process.exit(1);
}
const signIdentity = process.env.WEAVEPDF_SIGN_IDENTITY || "-";
try {
  execFileSync(
    "codesign",
    [
      "--force",
      "--sign", signIdentity,
      "--entitlements", entitlements,
      "--timestamp=none",
      appex,
    ],
    { stdio: "inherit" },
  );
} catch (e) {
  console.error("codesign failed:", e.message);
  process.exit(1);
}
const identityLabel = signIdentity === "-" ? "ad-hoc" : `identity '${signIdentity}'`;
console.log(`  signed (${identityLabel}) with sandbox entitlements`);

console.log(`done: ${appex}`);
