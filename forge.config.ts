import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

// Detect a stable code-signing identity ("WeavePDF Local" — see
// scripts/setup-local-signing.sh). With a stable identity, the binary's
// "designated requirement" stays the same across rebuilds, so macOS Keychain
// stops prompting the user to re-allow safeStorage access after every
// `npm run package`. Falls back to ad-hoc (`-`) when the identity isn't
// installed, so the build doesn't break for someone who hasn't run the
// setup script yet.
function detectSigningIdentity(): string {
  try {
    // No `-v` flag — self-signed certs report `CSSMERR_TP_NOT_TRUSTED` but
    // `codesign` itself accepts them (the strict filter is for Apple-CA
    // anchored identities like Developer ID).
    const out = execFileSync("security", ["find-identity", "-p", "codesigning"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (out.includes('"WeavePDF Local"')) return "WeavePDF Local";
  } catch {
    // `security` not available or no identities; treat as ad-hoc.
  }
  return "-";
}

const SIGNING_IDENTITY = detectSigningIdentity();

const config: ForgeConfig = {
  packagerConfig: {
    name: "WeavePDF",
    appBundleId: "ca.adamhayat.weavepdf",
    appCategoryType: "public.app-category.productivity",
    asar: true,
    extraResource: ["resources"],
    icon: "resources/icon", // Forge appends .icns on macOS
    // Register WeavePDF as a handler for PDF, PNG, JPG, HEIC so the user can
    // right-click → Open With → WeavePDF, or set it as the default PDF app.
    extendInfo: {
      // Defensive override of the auto-generated copyright field. Forge would
      // otherwise inject a string built from package.json `author`, which would
      // surface in `mdls`, App Store metadata, and any tool that reads the
      // bundle's Info.plist directly. setAboutPanelOptions in main.ts handles
      // the visible About panel; this handles the Info.plist layer.
      NSHumanReadableCopyright: "© WeavePDF",
      // Register the `weavepdf://` URL scheme so the Finder Sync extension
      // (which is sandboxed and can't spawn the CLI directly) can dispatch
      // verbs to the parent app via NSWorkspace.shared.open(URL). Handled in
      // main.ts via app.on('open-url').
      CFBundleURLTypes: [
        {
          CFBundleURLName: "WeavePDF action",
          CFBundleURLSchemes: ["weavepdf"],
        },
      ],
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: "PDF document",
          CFBundleTypeIconFile: "icon",
          CFBundleTypeRole: "Editor",
          LSItemContentTypes: ["com.adobe.pdf"],
          LSHandlerRank: "Alternate",
        },
        {
          CFBundleTypeName: "Image",
          CFBundleTypeIconFile: "icon",
          CFBundleTypeRole: "Editor",
          LSItemContentTypes: [
            "public.png",
            "public.jpeg",
            "public.heic",
            "public.heif",
          ],
          LSHandlerRank: "Alternate",
        },
        {
          CFBundleTypeName: "Word document",
          CFBundleTypeIconFile: "icon",
          CFBundleTypeRole: "Editor",
          LSItemContentTypes: [
            "org.openxmlformats.wordprocessingml.document",
            "com.microsoft.word.doc",
            "public.rtf",
          ],
          LSHandlerRank: "Alternate",
        },
      ],
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerZIP({}, ["darwin"]),
    // Drag-to-Applications DMG installer for sharing the unsigned build with
    // friends. The maker auto-generates a layout with the .app on the left and
    // an /Applications symlink on the right.
    new MakerDMG(
      {
        name: "WeavePDF",
        title: "WeavePDF", // Volume window title after mount
        icon: "resources/icon.icns",
        format: "ULFO", // LZFSE-compressed, smaller + faster than UDZO
        overwrite: true,
      },
      ["darwin"],
    ),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: "src/main/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.mts",
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      // V1.0020: ON only for Playwright test builds (VITE_E2E=1). Production
      // DMGs we hand to friends ship with --inspect disabled, since anyone
      // able to launch the binary could otherwise attach a debugger to the
      // main process and call Node primitives (child_process.exec etc.)
      // that bypass the entire IPC allowlist.
      // Re-enable for tests with: `npm run package:test` (sets VITE_E2E=1).
      [FuseV1Options.EnableNodeCliInspectArguments]: process.env.VITE_E2E === "1",
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
  hooks: {
    // After Forge produces WeavePDF.app, build the WeavePDFFinderSync.appex
    // and embed it in Contents/PlugIns/. macOS auto-discovers extensions in
    // an installed app's PlugIns directory; the user enables it once via
    // System Settings → Login Items & Extensions → Finder, after which a
    // "WeavePDF" entry with a hover submenu appears in the Finder right-click
    // context menu for PDFs and supported image types.
    //
    // The Forge fuses plugin runs LAST among Forge's own steps; this hook
    // runs after that, so the .appex addition + final re-sign happens on top
    // of the fully-fused .app.
    postPackage: async (_forgeConfig, options) => {
      const repoRoot = resolve(__dirname);
      const helperScript = join(repoRoot, "scripts/build-url-listener.mjs");
      const helperBin = join(repoRoot, "resources/helpers/url-listener-bin");
      const buildScript = join(repoRoot, "scripts/build-finder-sync.mjs");
      const appex = join(repoRoot, "out/build-finder-sync/WeavePDFFinderSync.appex");

      console.log("[postPackage] Building Finder Sync notification bridge...");
      execFileSync("node", [helperScript], { stdio: "inherit" });

      console.log(
        `[postPackage] Building WeavePDFFinderSync.appex (signing identity: ${SIGNING_IDENTITY})...`,
      );
      execFileSync("node", [buildScript], {
        stdio: "inherit",
        env: { ...process.env, WEAVEPDF_SIGN_IDENTITY: SIGNING_IDENTITY },
      });

      for (const outPath of options.outputPaths) {
        const appBundle = join(outPath, "WeavePDF.app");
        if (!existsSync(appBundle)) continue;
        const plugInsDir = join(appBundle, "Contents/PlugIns");
        const dest = join(plugInsDir, "WeavePDFFinderSync.appex");
        mkdirSync(plugInsDir, { recursive: true });
        rmSync(dest, { recursive: true, force: true });
        cpSync(appex, dest, { recursive: true });
        console.log(`[postPackage] embedded extension: ${dest}`);

        const helperDest = join(appBundle, "Contents/Resources/resources/helpers/url-listener-bin");
        cpSync(helperBin, helperDest);
        console.log(`[postPackage] embedded notification bridge: ${helperDest}`);

        // Re-sign the parent .app WITHOUT --deep. This regenerates the
        // parent's CodeResources to seal the new PlugIns/ contents, but
        // preserves the .appex's existing inner signature — which carries
        // the sandbox entitlements that pkd requires. Using --deep here
        // would re-sign the .appex without entitlements (codesign --deep
        // doesn't propagate per-bundle entitlements), and pkd would reject
        // it on every menu invocation with "plug-ins must be sandboxed".
        //
        // SIGNING_IDENTITY is "WeavePDF Local" (stable, self-signed) when
        // the user has run scripts/setup-local-signing.sh, else "-" (ad-hoc).
        // Stable identity means the same binary "designated requirement"
        // across rebuilds, so the macOS Keychain stops prompting after the
        // first "Always Allow".
        execFileSync(
          "codesign",
          ["--force", "--sign", SIGNING_IDENTITY, appBundle],
          { stdio: "inherit" },
        );
        console.log(`[postPackage] re-signed parent (entitlements-preserving): ${appBundle}`);
      }
    },
  },
};

export default config;
