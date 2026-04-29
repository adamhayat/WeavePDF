# WeavePDF

> **Read `HANDOFF.md` FIRST.** Current state, in-flight work, next-up priorities.
> **Then `BRAND.md`** for the canonical brand identity. BRAND.md outranks this file for voice / visual / naming decisions; this file still wins on engineering rules.
> **Update `HANDOFF.md` and `CHANGELOG.md` after every change — same turn, not later.** See Critical Rule #0.

Local Mac-native alternative to Adobe Acrobat. No cloud, no account, no subscription. Target user: Adam (personal use on macOS). Current version: **V1.0002** (`package.json` semver `1.0.2`). Display format `V1.0<patch4>` is computed from `package.json`'s patch field. See `HANDOFF.md` for the full state and Critical Rule #12 below for the bump-on-every-ship rule.

V1.0002 shipped the full rename from the original "Acrofox" name to **WeavePDF**. Bundle ID is now `ca.adamhayat.weavepdf`, install path `/Applications/WeavePDF.app`, accent color Loom Indigo (`#3B4CCA` light / `#7A8AFF` dark), and the icon is a page glyph with two threads crossing into a `W`. Historical "Acrofox" references in HANDOFF and CHANGELOG entries are intentional — do not edit them.

## Stack

- **Shell:** Electron 41 (main) + Vite (renderer)
- **UI:** React 18 + TypeScript + TailwindCSS v4
- **PDF rendering:** `pdfjs-dist` v4 (Mozilla pdf.js)
- **PDF manipulation:** `pdf-lib`
- **Compression:** `pdf-lib` object streams today. Ghostscript bundle deferred (would unlock /ebook-grade shrinkage).
- **Signature capture:** `signature_pad`
- **Drag-and-drop:** `@dnd-kit/core`, `@dnd-kit/sortable`
- **State:** Zustand — two stores (`document`, `ui`)
- **Icons:** Lucide React
- **Keyboard shortcuts:** `react-hotkeys-hook`
- **Packager:** `@electron-forge/cli` with `@electron-forge/plugin-vite`
- **Testing:** `@playwright/test` against the packaged `.app`
- **Image work:** `sharp` (dev-only, icon generator)

## Commands

```bash
# Dev (run in a real Terminal — Forge needs a TTY)
npm run dev           # Vite renderer + Electron main, HMR enabled
                      # If running under Codex/automation, wrap with:
                      #   tail -f /dev/null | npm run dev
                      # so stdin stays open or Forge exits and kills Vite.

# Checks
npm run typecheck     # tsc --noEmit across main + renderer + tests

# Package + install
npm run package       # Builds .vite/ + out/Acrofox-darwin-arm64/Acrofox.app
npm test              # Runs 21 Playwright specs against the packaged .app

# Reinstall to /Applications and refresh LaunchServices
pkill -f "/Applications/Acrofox" 2>/dev/null ; sleep 1
rm -rf /Applications/Acrofox.app
cp -R out/Acrofox-darwin-arm64/Acrofox.app /Applications/
xattr -dr com.apple.quarantine /Applications/Acrofox.app
touch /Applications/Acrofox.app
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f /Applications/Acrofox.app

# Fixtures + icon (regenerate after editing sources)
npm run fixtures                  # writes resources/fixtures/*.pdf (pdf-lib)
node scripts/generate-icon.mjs    # writes resources/icon.icns + icon.png (sharp + iconutil)

# Swift helpers (rebuild after editing the .swift files)
node scripts/build-ocr.mjs        # compiles resources/helpers/ocr-bin (~67KB)
                                  # Apple Vision OCR — ships with Xcode CLT.
node scripts/build-ai.mjs         # compiles resources/helpers/ai-bin (~62KB)
                                  # Apple Intelligence (FoundationModels).
                                  # REQUIRES FULL XCODE, not just CLT.
                                  # One-time setup:
                                  #   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
                                  #   sudo xcodebuild -license accept
```

## How to make changes (development workflow)

### Adding a new editing tool

Most edits in Acrofox flow through this pipeline:

> **User gesture** → **tool mode in `ui.ts`** → **interaction handler in `PageCanvas.tsx`** → **primitive in `pdf-ops.ts`** → **`applyEdit(tabId, newBytes)` in `document.ts`** → pdf.js reloads → viewer + thumbnails re-render.

To add e.g. a "cloud shape" tool:

1. **Primitive** — add `drawCloud(base, page, region, opts)` to [src/renderer/lib/pdf-ops.ts](src/renderer/lib/pdf-ops.ts). Build it on top of `pdf-lib`. Return a new `Uint8Array`.
2. **Tool mode** — add `"cloud"` to the `tool` union in [src/renderer/stores/ui.ts](src/renderer/stores/ui.ts).
3. **Interaction** — in [src/renderer/components/Viewer/PageCanvas.tsx](src/renderer/components/Viewer/PageCanvas.tsx):
   - If it's a drag tool, add `"cloud"` to `isDragTool`, then inside `pointerUpDrag` call `drawCloud(activeTab.bytes, pageNumber, region, { color, thickness })` and `applyEdit`.
   - If it's a click tool, add a branch in `handleInteractionClick`.
4. **Toolstrip button** — add a `ToolButton` in [Toolstrip.tsx](src/renderer/components/Toolstrip/Toolstrip.tsx) with `active={tool === "cloud"}` and `onClick={tt("cloud")}`.
5. **Palette action** — add an entry in the `actions` array in [App.tsx](src/renderer/App.tsx).
6. **Menu item** (optional) — add a `MenuCommand` variant in [src/shared/ipc.ts](src/shared/ipc.ts), add a menu entry in [main.ts](src/main/main.ts)'s `buildAppMenu`, and handle the command in App.tsx's `onMenuCommand`.
7. **Test** — add a spec under `tests/e2e/` (pattern: click tool → drag/click on page → assert the doc becomes dirty / bytes change).

### Adding a new modal (compress-style)

1. Add `<thing>Open: boolean` + `open<Thing>()` + `close<Thing>()` to [ui.ts](src/renderer/stores/ui.ts).
2. Create `src/renderer/components/<Thing>Modal/<Thing>Modal.tsx`. Copy the shape of [CompressSheet.tsx](src/renderer/components/CompressSheet/CompressSheet.tsx) — it handles the overlay/backdrop/close pattern.
3. Inside the modal: call a pdf-ops primitive → `applyEdit(activeTab.id, newBytes)` → `onClose()`.
4. In [App.tsx](src/renderer/App.tsx) import the modal, wire `openThing` / `closeThing`, render `<ThingModal open={thingOpen} onClose={closeThing} />`, add a palette action, and (optionally) a menu item.

### Reading state / writing edits

```ts
// Inside a component
const activeTab = useDocumentStore((s) => s.activeTab());
const applyEdit = useDocumentStore((s) => s.applyEdit);
if (!activeTab?.bytes) return;
const newBytes = await somePdfOp(activeTab.bytes, /* args */);
await applyEdit(activeTab.id, newBytes); // reloads pdf.js, bumps version, adds to history
```

- `applyEdit` pushes the previous bytes onto `history` (cap 20). `undo(tabId)` pops.
- `version` bumps on every edit — components key children off it to avoid stale canvases.
- `pendingTextEdits` are _not_ baked until save/export/print — they live as draggable overlays.

### IPC pattern

Renderer ↔ Main talks through [src/shared/ipc.ts](src/shared/ipc.ts). To add a new channel:

1. Add the channel name to `IpcChannel` and any request/response types.
2. Add the method to `AcrofoxApi` in [src/shared/api.ts](src/shared/api.ts).
3. Expose it through `contextBridge` in [src/preload/preload.ts](src/preload/preload.ts).
4. Handle it with `ipcMain.handle(...)` in [src/main/main.ts](src/main/main.ts).

### Shipping changes to your Mac

The bundled `.app` in `/Applications/Acrofox.app` is what you actually launch from Spotlight/Dock. Dev mode (`npm run dev`) is a separate process. After making changes you want to use, repackage and copy (see the "Package + install" snippet under Commands above).

## Architecture

```
src/
  main/main.ts                     Electron main: window, IPC handlers, native dialogs,
                                   safeStorage (Keychain), nativeTheme broadcast, app menu,
                                   open-file + file-association wiring
  preload/preload.ts               contextBridge → window.acrofox (20+ methods)
  shared/
    ipc.ts                         Channel name constants + MenuCommand union + request/response types
    api.ts                         Window.acrofox type surface
  renderer/
    App.tsx                        Root component: hotkeys, actions, modal wiring, drag-drop,
                                   menu-command router, palette actions
    main.tsx                       React mount + test hooks (window.__acrofoxTest__)
    index.css                      Tailwind v4 @theme + per-theme semantic vars
    hooks/
      useTheme.ts                  nativeTheme subscription
    lib/
      pdf-ops.ts                   23 pdf-lib primitives (see list at top of file)
      pdfjs.ts                     pdfjs-dist init + local worker bundling
      cn.ts                        clsx + tailwind-merge + formatBytes
    stores/
      document.ts                  tab model: bytes / selection / pendingTextEdits / history
      ui.ts                        theme / sidebar / search / palette / modal flags / tool /
                                   pendingImage / annotationColor / strokeWidth / sidebarTab
    components/
      Titlebar/                    hiddenInset bar: tabs, ⌘K hint, search, save, export, Open
      Toolstrip/
        Toolstrip.tsx              16 tool + 5 page + 6 doc ops buttons
        ColorPopover.tsx           swatches + stroke slider, visible only for vector tools
      Sidebar/
        Sidebar.tsx                Pages tab: dnd-kit sortable thumbnails + multi-select
        OutlinePanel.tsx           Outline tab: pdf.js outline tree
      Viewer/
        Viewer.tsx                 vertical scroll + suppressObserverRef for programmatic nav
        PageCanvas.tsx             DPR canvas + TextLayer + interaction overlay for all tools
        TextPromptOverlay.tsx      inline input for Add Text
        PendingTextLayer.tsx       draggable pending-text overlays
      Search/SearchBar.tsx         ⌘F flow
      DropZone/                    empty-state CTA
      CompressSheet/
      SignatureModal/              Draw + Type tabs, 5 fonts, always-black ink
      MetadataModal/
      WatermarkModal/
      ExtractModal/
      CropModal/
      HeaderFooterModal/
      CommandPalette/              ⌘K fuzzy runner
resources/
  icon.svg / icon.icns / icon.iconset/*
  fixtures/*.pdf                   gitignored — regenerate with scripts/generate-fixtures.mjs
scripts/
  generate-fixtures.mjs
  generate-icon.mjs                SVG → PNGs → iconutil → icns (sharp)
tests/e2e/
  smoke.spec.ts                    7 specs
  edit.spec.ts                     7 specs
  acrobat-parity.spec.ts           7 specs
forge.config.ts                    VitePlugin + Fuses (inspect ON) + MakerZIP darwin +
                                   CFBundleDocumentTypes (PDF + images)
vite.main.config.ts
vite.preload.config.ts
vite.renderer.config.mts           .mts because @tailwindcss/vite is ESM-only and Forge's
                                   config loader is CJS otherwise.
playwright.config.ts
```

## Critical Rules

0. **Docs stay in sync — no exceptions.** Every time you change behaviour, ship a feature, or fix a bug: update `HANDOFF.md` (current state + session log entry) **and** `CHANGELOG.md` (Added / Fixed / Changed under `[Unreleased]` or the active version). The user shouldn't have to ask — if you touched code, touch the docs in the same turn. "I'll do it later" is the wrong answer.
1. **Local-only.** No telemetry, no cloud sync, no account. Any feature needing the network requires explicit approval first.
2. **System theme.** Dark/light follows `nativeTheme.shouldUseDarkColors`. No in-app theme toggle unless asked.
3. **Edit-text is whiteout + retype.** We don't promise Word-style reflow. The Edit Text tool overlays the replacement at the original position + size.
4. **Signatures stored in macOS Keychain via `safeStorage`**, never plain on disk, never uploaded. Saved signatures are always **black** ink (white would be invisible on white paper).
5. **Ghostscript is AGPL** (if we ever bundle it). Fine for personal use. Swap to qpdf or buy a commercial licence before distribution.
6. **Never auto-save over the user's original.** `Save` on an opened file routes to `Save As` unless the tab was created inside the app (combined / image-imported).
7. **pdf.js worker is bundled, not CDN-loaded.** Offline-first.
8. **Don't leak the signature or its data URL anywhere** outside the Keychain-backed file + the renderer's memory during placement.
9. **Design principle guardrails:** Content is the interface (chrome retreats). Drag is the verb. One primary action always visible. Keyboard parity with mouse. Fail quietly, succeed visibly.
10. **Close pdf.js documents on tab-close** via `pdf.destroy()` (store does this in `closeTab` and `applyEdit`) — each keeps a worker alive otherwise.
11. **Forge fuse `EnableNodeCliInspectArguments` stays ON** so Playwright can attach via `--inspect`. If we ever distribute publicly, flip it off + drop E2E against the shipped binary.
12. **Always bump the version on every shipped change.** Single source of truth is `package.json`'s `"version"` (semver). Format is `1.0.<patch>`; the user-facing display is `V1.0<patch4>` (e.g. semver `1.0.1` → `V1.0001`, `1.0.42` → `V1.0042`). Increment the patch by 1 on every code-changing turn. Surfaces that show the version: macOS About panel ([main.ts](src/main/main.ts) via `app.setAboutPanelOptions`) and the `⌘/` Keyboard Shortcuts panel footer ([ShortcutHelpModal.tsx](src/renderer/components/ShortcutHelpModal/ShortcutHelpModal.tsx)). Both compute display from `package.json` — touch only `package.json`. Note the new version in the same turn's `HANDOFF.md` "Current state" line and the `CHANGELOG.md` `[Unreleased]` section header.

## Environment Variables

None required. Reserved for later:
- `ACROFOX_LOG_LEVEL` — debug / info / warn / error
- `GHOSTSCRIPT_PATH` — override the bundled binary path (dev only, once bundled)

## Testing

All E2E specs launch the packaged `.app` via Playwright's Electron API:

```ts
const app = await electron.launch({
  executablePath: "/absolute/path/to/.../Acrofox.app/Contents/MacOS/Acrofox",
});
```

`window.__acrofoxTest__` exposes bypass helpers (`openPdfByPath`, `saveActiveAs`, `exportCombinedTo`) because `contextBridge` deep-freezes `window.acrofox` and can't be monkey-patched from a test. Add test hooks to [src/renderer/main.tsx](src/renderer/main.tsx) when you need one.

`npm test` runs all 3 spec files. You can target a single spec with `npx playwright test edit.spec.ts`. Traces + screenshots land in `test-results/` on failure.

## Known Follow-Ups / Deferred

See the "Not yet built" section in `HANDOFF.md` for the authoritative list. Short version: password protection (needs qpdf), AcroForm fill, OCR (Swift bridge), PKCS#7 digital signatures, true content-removal redaction, Ghostscript-grade compression, drag-resize handles post-placement, right-click context menus, font-matching in Edit Text, batch ops, DOCX export, PDF/A, Bates numbering.

## Non-Goals (v1)

Form creation (filling is on the list; creating new fillable fields from scratch is not). PDF compare. AI assistant. Cloud sync. Account. DOCX/XLSX export. PDF/A. Prepress. Bates numbering. Toolbar customization UI. Skeuomorphic paper textures. Onboarding tutorials. Paywalls.

## Visual Language

- **Type:** SF Pro (system-ui). Scale 11 / 13 / 15 / 20 / 28 / 36. Tabular numerals for page numbers and sizes.
- **Color:** Neutral-first. Accent `#6D5EF5` (electric violet). Semantic: success `#30D158`, warn `#FF9F0A`, destructive `#FF453A`.
- **Grid:** 4px base. Page radius 6. Popover radius 8. Thumbnail radius 10. Window inherits macOS.
- **Motion:** 180ms standard, 300ms for larger transitions. No bounce on errors — 2px shake at 80ms.

## Known gotchas (learned the hard way)

- **`npm install` fails with EACCES on `~/.npm`** — cache is root-owned. Work around with `npm install --cache ./.npm-cache`. One-time fix: `sudo chown -R 501:20 ~/.npm`.
- **Forge exits if stdin isn't a TTY** — which kills Vite. When running via automation (not a real Terminal): `tail -f /dev/null | npm run dev`.
- **`File.path` is gone in Electron 32+** — drag-drop uses `webUtils.getPathForFile` via preload instead.
- **contextBridge deep-freezes the exposed API** — you cannot monkey-patch `window.acrofox.*` from a test. Add a dedicated test hook on `window.__acrofoxTest__` instead.
- **Uppercase styling is CSS-only** — Playwright's `getByText("PAGES")` won't match a DOM node that says "Pages" with `text-transform: uppercase`. Use `getByTestId` or a case-insensitive regex.
- **pdf.js TextLayer API changed in v4** — we use `pdfjsLib.TextLayer` class with `streamTextContent`. If pdf.js updates break text selection, check that constructor first.
- **Signature ink must be BLACK** — theme-aware ink was invisible on white PDFs in dark mode. See Critical Rule #4.
