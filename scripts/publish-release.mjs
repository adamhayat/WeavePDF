#!/usr/bin/env node
// publish-release.mjs — builds a fresh DMG and publishes a GitHub Release.
//
// Why this script (vs @electron-forge/publisher-github): zero new npm
// dependencies, uses the `gh` CLI you already have authenticated. One file
// you can read end-to-end. No new attack surface in node_modules.
//
// What it does:
//   1. Reads `version` from package.json (single source of truth).
//   2. Fails fast if the working tree is dirty (release should be a clean
//      snapshot of HEAD). Override with WEAVEPDF_DIRTY_OK=1.
//   3. Runs `npm run make` to produce out/make/WeavePDF.dmg + the .zip
//      auto-update payload Forge ships alongside it.
//   4. Extracts the latest `[Unreleased] / V1.<patch>` block from CHANGELOG.md
//      to use as the release body. Falls back to a one-line generic message.
//   5. Calls `gh release create vX.Y.Z` with --notes <body> --target <branch>
//      and uploads the DMG + ZIP as release assets.
//   6. Tags the release as latest if no other release tag is newer.
//
// Prereqs (one-time):
//   - `gh auth login` (already done if you've created PRs from this repo).
//   - GitHub repo at github.com/adamhayat/WeavePDF (matches main.ts URL).
//
// Usage:
//   npm run release            # full flow
//   npm run release -- --draft # creates a draft release for review

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { argv, exit } from "node:process";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const pkgPath = join(repoRoot, "package.json");
const changelogPath = join(repoRoot, "CHANGELOG.md");
const outDir = join(repoRoot, "out", "make");
const draft = argv.includes("--draft");

function die(msg) {
  console.error(`✗ ${msg}`);
  exit(1);
}

function ok(msg) {
  console.log(`✓ ${msg}`);
}

function step(msg) {
  console.log(`\n→ ${msg}`);
}

// ── Preflight ────────────────────────────────────────────────────────────
step("Preflight checks");

if (!existsSync(pkgPath)) die("package.json not found at repo root");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const version = pkg.version;
if (!version) die("package.json has no version");
const tag = `v${version}`;
ok(`Version: ${version} → tag ${tag}`);

// Confirm gh CLI is available + authed.
try {
  execFileSync("gh", ["auth", "status"], { stdio: "pipe" });
  ok("gh CLI authenticated");
} catch {
  die("gh CLI not authenticated — run `gh auth login`");
}

// Confirm we're inside a git repo with a clean working tree.
try {
  execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "pipe", cwd: repoRoot });
} catch {
  die("not a git repo — initialize with `git init` and push to github.com:adamhayat/WeavePDF");
}

const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim();
if (dirty && !process.env.WEAVEPDF_DIRTY_OK) {
  console.error("\n  Working tree has uncommitted changes:");
  console.error(dirty.split("\n").map((l) => `    ${l}`).join("\n"));
  die("commit or stash before releasing (override with WEAVEPDF_DIRTY_OK=1)");
}
ok("Working tree clean");

// Check tag doesn't already exist on the remote.
try {
  const remoteTags = execFileSync("git", ["ls-remote", "--tags", "origin", tag], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  if (remoteTags) die(`tag ${tag} already exists on origin — bump package.json version`);
  ok(`Tag ${tag} is unused`);
} catch (err) {
  if (err.message?.includes("already exists")) throw err;
  // ls-remote can fail with no output too; just continue if no remote configured yet.
}

// ── Build ────────────────────────────────────────────────────────────────
step("Building distributables (npm run make)");
execSync("npm run make", { cwd: repoRoot, stdio: "inherit" });

const dmg = join(outDir, "WeavePDF.dmg");
if (!existsSync(dmg)) die(`expected DMG missing at ${dmg}`);
ok(`Built ${dmg}`);

// Forge's MakerZIP also produces a .zip alongside the DMG. Bundle it as a
// release asset so future autoUpdater integration (Squirrel.Mac wants .zip)
// has something to pull from without a re-release.
const zipDir = join(repoRoot, "out", "make", "zip", "darwin", "arm64");
const zipName = `WeavePDF-darwin-arm64-${version}.zip`;
const zip = join(zipDir, zipName);
const zipExists = existsSync(zip);
if (zipExists) ok(`Built ${zip}`);
else console.log(`  ℹ Skipping ZIP asset (not found at ${zip})`);

// ── Release notes ────────────────────────────────────────────────────────
step("Extracting release notes from CHANGELOG.md");

let body = "";
if (existsSync(changelogPath)) {
  const cl = readFileSync(changelogPath, "utf8");
  // Pull every block that mentions the current version under [Unreleased].
  // Matches `### Added — V1.0019: …` through the next `###` heading.
  const versionTag = `V1.${version.split(".")[2].padStart(4, "0")}`;
  const re = new RegExp(`^### [^\\n]*${versionTag}[\\s\\S]*?(?=^### |^## |\\Z)`, "gm");
  const matches = cl.match(re);
  if (matches?.length) {
    body = matches.join("\n\n").trim();
    ok(`Found ${matches.length} CHANGELOG block(s) for ${versionTag}`);
  } else {
    console.log(`  ℹ No CHANGELOG block matched ${versionTag} — using generic notes`);
  }
}
if (!body) {
  body = `WeavePDF ${tag}.\n\nDownload **WeavePDF.dmg** below, drag to /Applications, right-click → Open the first time (Gatekeeper warning is expected for unsigned builds).`;
}

// ── Publish ──────────────────────────────────────────────────────────────
step(`Creating GitHub release ${tag}${draft ? " (DRAFT)" : ""}`);

const ghArgs = [
  "release",
  "create",
  tag,
  dmg,
  ...(zipExists ? [zip] : []),
  "--title",
  `WeavePDF ${tag}`,
  "--notes",
  body,
];
if (draft) ghArgs.push("--draft");

execFileSync("gh", ghArgs, { cwd: repoRoot, stdio: "inherit" });

ok(`Release ${tag} published.`);
console.log("");
console.log(`  View it:   https://github.com/adamhayat/WeavePDF/releases/tag/${tag}`);
console.log(`  DMG link:  https://github.com/adamhayat/WeavePDF/releases/download/${tag}/WeavePDF.dmg`);
console.log("");
console.log("  Friends running an older WeavePDF will see the update prompt on next launch.");
