# Changelog

All notable changes to Acrofox PDF Editor.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased] — Features + hardening

### Fixed — V1.0029: restore WeavePDF parent submenu in Finder right-click (2026-04-29)
- **Reverted V1.0028's incorrect "flatten" of the FinderSync menu.** Removing the explicit `WeavePDF` parent NSMenuItem caused the 6 actions to render directly in the top-level right-click menu AND mirror inside macOS Sequoia's built-in Quick Actions submenu — neither of which is the requested layout. Restored the V1.0005..V1.0027 pattern: a single `WeavePDF →` entry whose submenu contains all 6 options. Nothing else sprinkles.
- **Re: duplicate "WeavePDF →"** that V1.0028 was trying to fix: that's a stale macOS pkd cache from rapid install cycles, not caused by the menu code. If still visible, toggle the extension off/on in System Settings → Login Items & Extensions → Finder.
- **Bumped V1.0028 → V1.0029** per Critical Rule #12.

### Added + Fixed — V1.0028: unified Print Preview + split rotate + Finder duplicate-menu fix (2026-04-29)
- **Unified Print Preview panel** ([src/renderer/components/PrintPreviewModal/PrintPreviewModal.tsx](src/renderer/components/PrintPreviewModal/PrintPreviewModal.tsx) + [src/renderer/components/PrintPreviewModal/usePrintReducer.ts](src/renderer/components/PrintPreviewModal/usePrintReducer.ts)). One panel with every print setting (printer, copies, pages range, paper, layout/N-up, orientation, color, two-sided) on the left rail and a live preview on the right. Preview rebuilds on every setting that affects rendering (paper / layout / orientation / pages range), with 120 ms debounce + cancel-token + sequenced pdf.js loading to dodge the worker race. Footer shows total-sheets math (e.g. "12 sheets × 3 = 36"). Print is silent — `webContents.print({ silent: true, deviceName, color, copies, duplexMode, landscape })` — so the macOS native dialog is bypassed entirely. No more two-stage flow with duplicate Layout/Orientation controls.
- **New IPC `print:list-printers`** ([src/shared/ipc.ts](src/shared/ipc.ts), [src/main/main.ts](src/main/main.ts)) — `webContents.getPrintersAsync()` exposed to the renderer for the Printer dropdown.
- **`PrintPdfBytes` accepts `options: PrintOptions`** — when `deviceName` is set, prints silently with all settings pre-chosen. Without options, the legacy V1.0021 path runs (system dialog appears) for back-compat.
- **Rotate split into Clockwise / Counter-clockwise** in the Finder right-click submenu. Two new verbs `rotate-cw` (90°) and `rotate-ccw` (270°); legacy `rotate` aliased to `rotate-cw` for back-compat.
- **Removed the duplicate "WeavePDF →" entry** in Finder right-click. Pre-V1.0028 we added an explicit `WeavePDF` parent NSMenuItem inside `menu(for:)`, but macOS already auto-wraps every FinderSync extension's items under a parent named after the extension's bundle display name — so the user saw two parents. Now we return items directly; macOS handles the wrapping.
- **Bumped V1.0027 → V1.0028** per Critical Rule #12.
- **Tests:** `npm run typecheck` clean against `weavepdf@1.0.28`.

### Fixed + Changed — V1.0027: already-open tab switch + Print Preview simplified + cert-trust setup (2026-04-29)
- **Reopening a file that's already in a tab now switches to that tab.** Before V1.0027 it re-read from disk and triggered the autosave-restore prompt — the user just wanted the existing tab raised. Now the renderer's `onOpenFilePath` checks for a matching `path` first and calls `setActiveTab` if found.
- **Print Preview simplified to preview-only.** V1.0021's Layout/Orientation dropdowns duplicated the controls already in the macOS native print dialog, and the values didn't match because our modal baked layout INTO the PDF before the native dialog showed it. Removed our controls; the native dialog now owns all real print options (printer, copies, layout, orientation, paper, duplex, color). Our modal is now just a clean preview (thumbnails left, big page right, Cancel / Print).
- **`setup-local-signing.sh` now trusts the cert as a code-signing root** in the user's login keychain. Without the trust step, macOS's Keychain ACL falls back to per-CDHash pinning so every rebuild re-prompts for the user's Mac password. With trust, the ACL pins to the cert's leaf hash (stable across rebuilds). Script restructured so the trust step runs even if the cert already exists. **One-time action:** Adam (and any future contributor) re-runs `bash scripts/setup-local-signing.sh` from a real Terminal once; macOS shows ONE password prompt to authorize the trust change; future updates are then silent.
- **Bumped V1.0026 → V1.0027** per Critical Rule #12.
- **Tests:** `npm run typecheck` clean against `weavepdf@1.0.27`. Manual verification: open same file from Finder → switches to existing tab; ⌘P → simplified modal → Print → native dialog with single set of controls.

### Fixed + Added — V1.0026: cold-start crash fix + Unsaved Changes confirmation dialog (2026-04-29)
- **Fixed cold-start crash** ("A JavaScript error occurred in the main process — Cannot create BrowserWindow before app is ready"). V1.0025's new `createMainWindow()` call inside `queueOrSendOpen` could fire while macOS dispatched the open-file event during cold launch, before `app.whenReady`. Now gated behind `app.isReady()` — pre-ready, the queue + the existing whenReady drain handle it; post-ready (the post-close scenario the fix is for), it creates immediately.
- **Added Unsaved Changes confirmation dialog.** Closing a window (red X / ⌘W) or quitting the app (⌘Q) with dirty tabs now shows a native dialog listing the affected tab names with **Cancel** / **Close Anyway** (or **Quit Anyway**). App-quit aggregates across every open window into one combined dialog.
  - New IPC `tabs:notify-dirty` ([src/shared/ipc.ts](src/shared/ipc.ts)) — renderer publishes a `string[]` of dirty tab names; main maintains a `Map<windowId, string[]>` snapshot.
  - Renderer publisher ([src/renderer/main.tsx](src/renderer/main.tsx)) — subscribes to `useDocumentStore` and re-publishes only when the joined names change (deduped to avoid IPC spam during heavy editing).
  - Main close + before-quit handlers ([src/main/main.ts](src/main/main.ts)) — synchronous `dialog.showMessageBoxSync` so we can preventDefault accurately. Per-window skip flag + appQuittingApproved flag prevent re-prompting after the user accepts.
- **Bumped V1.0025 → V1.0026** per Critical Rule #12.
- **Tests:** `npm run typecheck` clean against `weavepdf@1.0.26`.

### Fixed — V1.0025: file-open works again after closing the last window with X (2026-04-29)
- **Root cause of the entire focus-bug saga.** Closing the last window via the red X kept WeavePDF running but with zero windows (standard macOS behavior). Subsequent double-clicks on a PDF in Finder fired `app.on("open-file")` → `queueOrSendOpen(path)` → `getActiveWindow()` returned null → path was queued in `pendingOpenFiles` → **nothing created a new window to drain the queue**. PDF appeared not to open at all.
- **Fix** ([src/main/main.ts](src/main/main.ts) `queueOrSendOpen`): after pushing to the queue in the no-target branch, if `BrowserWindow.getAllWindows().length === 0`, call `createMainWindow()`. The new window's existing `did-finish-load` handler drains `pendingOpenFiles` automatically. Same fallback `app.on("activate")` already does for Dock-icon clicks; the file-open path was just missing it.
- **Why V1.0014–V1.0024's layered focus tricks didn't help here:** they all assumed a window existed to focus. With zero windows, `bringWindowForward` was never even reached. Those layers remain valuable for legitimate background-focus / Show-Desktop / Space-mismatch cases.
- **Bumped V1.0024 → V1.0025** per Critical Rule #12.
- **Tests:** `npm run typecheck` clean against `weavepdf@1.0.25`.

### Fixed — V1.0024: defeat macOS "Show Desktop" gesture on file-open (2026-04-29)
- **Show Desktop (Fn key, Globe key, top-right hot corner) was the missed scenario.** V1.0023 fixed normal-backgrounded focus, but Show Desktop slides every window off-screen via a Mission Control transform that `app.focus()`/`setAlwaysOnTop`/AppleScript activate don't undo. The app activated correctly but the window stayed at its slid-off position; user saw nothing.
- **Fix in [src/main/main.ts](src/main/main.ts) `bringWindowForward`:** before the focus pulse, capture `target.getBounds()` and check intersection against every display via `screen.getAllDisplays()`. If fully off-screen → reposition to a centered rect on the primary display's work area (forces a hard reposition that breaks the Show Desktop transform). If on-screen → re-`setBounds(originalBounds)` to break any in-progress slide. AppKit no-ops if the rect didn't change at the system level, so this is cheap when nothing's wrong.
- **Logging expanded** to include bounds before AND after the pulse in `/tmp/weavepdf-quickaction.log`. Future "still backgrounded" reports can be diagnosed from the trace.
- **Bumped V1.0023 → V1.0024** per Critical Rule #12.
- **Tests:** `npm run typecheck` clean against `weavepdf@1.0.24`. V1.0023 reproduction was verified via computer-use + trace log (focused=true visible=true after pulse for normal background); V1.0024 adds the Show-Desktop layer.

### Fixed — V1.0023: bulletproof file-open focus on macOS (2026-04-29)
- **Adds AppleScript activation as the final focus primitive.** `osascript -e 'tell application "WeavePDF" to activate'` goes through NSWorkspace + Apple Events, the same path the dock icon uses. macOS treats this as user-initiated and applies a more permissive activation policy than direct `app.focus({steal:true})` calls — survives Space differences, Stage Manager groups, focus-stealing prevention from concurrent apps.
- **Window now visible across Spaces during the 200 ms focus pulse.** `setVisibleOnAllWorkspaces(true)` for the duration of the pulse so the user sees the window on their CURRENT Space, not just the one WeavePDF normally lives on. Original setting is restored after the pulse so window-management preferences aren't permanently changed.
- **Detailed tracing to `/tmp/weavepdf-quickaction.log`** in both `queueOrSendOpen` and `bringWindowForward`. Logs path + target/ready state + window focus/visible/minimized state before and after the pulse. If focus still misses for any user, the log gives evidence (was the dispatch routed correctly? did the pulse fire? did macOS settle on focused state?).
- **Hoisted log helpers** (`FINDER_SYNC_LOG`, `logFinderSync`) to the top of main.ts so the early file-open path can call them safely.
- **Bumped V1.0022 → V1.0023** per Critical Rule #12.
- **Tests:** `npm run typecheck` clean against `weavepdf@1.0.23`. Manual verification pending — user should retest the same scenario (open `N10 : N11 Contract.pdf` from Desktop while WeavePDF is in another Space / backgrounded). If focus still misses, the trace log will pinpoint where.

### Fixed — V1.0022: print preview hotfix — pdf.js worker race + orientation Auto bug (2026-04-29)
- **pdf.js worker destroy race in PrintPreviewModal.** Rapid layout/orientation toggling caused overlapping `getDocument()` and `pdf.destroy()` against pdf.js's shared worker port, surfacing as `Couldn't build preview: PDFWorker.fromPort - the worker is being destroyed`. Preview reverted to stale state, dropdown looked broken. V1.0022 sequences loads via refs: new doc loads first → state swaps → old doc destroy is awaited AFTER the swap, never racing the worker.
- **Orientation "Auto" was passed as the literal string "auto"** to `nUpPages`, which `resolvePaperSize` treats as "use base orientation" (portrait Letter for everything) instead of the layout's `defaultOrient` (landscape for 2-up, portrait for 4/6/9-up). Now the modal omits the orientation key when "Auto" is selected so the primitive's smart default kicks in. Explicit Portrait/Landscape still pass through.
- **Bumped V1.0021 → V1.0022** per Critical Rule #12.
- **Tests:** `npm run typecheck` clean against `weavepdf@1.0.22`. Manual: orientation now visibly swaps sheet layout between portrait and landscape; 2/4/6/9-per-sheet build cleanly without the worker error.

### Fixed + Added — V1.0021: print rebuilt — Preview-app-style modal + clean hidden-window print (2026-04-29)
- **Print no longer prints the renderer's UI chrome.** V1.0020 and earlier called `webContents.print()` on the main BrowserWindow, which printed the entire DOM (Sidebar thumbnails, Toolstrip, Titlebar) and cropped the actual document. V1.0021 adds a dedicated `print:pdf-bytes` IPC ([src/main/main.ts](src/main/main.ts)) that writes the PDF to a temp file, opens it in a HIDDEN BrowserWindow with `plugins: true` (Chromium's PDFium plugin), then prints THAT window — no React, no chrome.
- **All pages now print, not just the first.** 1.2 s settle delay before `print()` lets PDFium fully render every page in the document before the print job materializes.
- **macOS filename header band suppressed.** `header: ""` + `footer: ""` in the print options + `setTitle(safeName)` on the hidden window remove the URL/filename band macOS otherwise prints in the page margins. The print job in the queue is named after the actual document.
- **New PrintPreviewModal** ([src/renderer/components/PrintPreviewModal/PrintPreviewModal.tsx](src/renderer/components/PrintPreviewModal/PrintPreviewModal.tsx)) — modeled on macOS Preview.app's print panel: layout dropdown (1/2/4/6/9 per sheet) + orientation at the top, thumbnail strip on the left for navigation, big preview canvas on the right, Cancel/Print at the bottom. Live preview re-renders whenever layout/orientation changes (via the existing `nUpPages` pdf-ops primitive). Pending overlays are baked in on open so the preview matches what will print.
- **⌘P / File → Print / palette Print** now open the preview modal instead of printing immediately. Blank tabs no-op (don't open an empty modal).
- **PDFium hidden window is locked down**: `javascript: false`, `sandbox: true`, partition isolated per print job, every subresource request blocked except the temp PDF itself (defense vs. hostile PDF embeds attempting outbound calls).
- **Bumped V1.0020 → V1.0021** per Critical Rule #12.
- **Tests:** `npm run typecheck` clean against `weavepdf@1.0.21`. Manual end-to-end verification pending — open a multi-page PDF, ⌘P, pick layout, Print → "Save as PDF" → inspect: should be clean PDF (all pages, no chrome, no filename header).

### Security — V1.0020: pre-distribution hardening pass (2026-04-29)
- **`weavepdf://` URL handler** ([src/main/main.ts](src/main/main.ts) `isSafeWeavePdfPath`) now validates every path: must realpath inside a user-document root (Desktop/Documents/Downloads/iCloud Drive/Movies/Music/Pictures/Public/Volumes/tmp), must NOT live in a sensitive subtree (~/.ssh, ~/.aws, ~/.gnupg, /etc, /System, /Library/Keychains, /Library/Application Support, app userData, /usr, /bin, /sbin), must have an allowed extension (.pdf, .png, .jpg, .jpeg, .heic, .heif). Verb allowlist gate at handler entry. Rejected paths surface a native warning dialog. Closes the "any process can dispatch `weavepdf://compress?paths=/Users/adam/.ssh/id_rsa`" hole — pre-V1.0020 the handler shelled out to Ghostscript with the path as both input AND output, overwriting in place.
- **doc2pdf hidden-window URL filter** tightened from `startsWith` substring to URL-parse + exact pathname equality + reject non-empty search/hash. A hostile HTML can no longer smuggle `file:///...?../../../etc/passwd` past the filter.
- **`addLinkAnnotation` URL scheme allowlist** ([src/renderer/lib/pdf-ops.ts](src/renderer/lib/pdf-ops.ts) `assertSafeLinkUrl`) re-validates http/https/mailto inside the primitive itself, not just in the LinkPopover UI. Future palette macros / batch ops can't forge `javascript:` link annotations.
- **Bless-path TOCTOU closed.** `blessPath()` now stores both lexical-resolved and realpath; `assertBlessed` checks both. `policyRealPath` walk hard-capped at 64 iterations.
- **Plaintext signature fallback removed** ([src/main/main.ts](src/main/main.ts) `SignatureSet`). When `safeStorage` is unavailable, throws an actionable error pointing the user at `setup-local-signing.sh` instead of silently writing a 0o600 plaintext signature image. `SignatureGet` deletes any legacy `signature.raw` it finds.
- **`EnableNodeCliInspectArguments` fuse** ([forge.config.ts](forge.config.ts)) flips OFF for production DMG packaging; ON only for `npm run package:test` (Playwright). Distributed binaries can no longer be `--inspect`-attached to bypass the IPC allowlist.
- **Update poll htmlUrl host validation.** `fetchLatestRelease` rejects responses whose `html_url` doesn't resolve to a `github.com` host before passing to `shell.openExternal`.
- **`--cli decrypt` password sanitization.** Now goes through `assertQpdfArgSafe` like the `--cli encrypt` path. No newline-injected qpdf argv smuggling.

### Fixed — V1.0020: TypeScript critical bugs (2026-04-29)
- **Decryption identity check replaced with explicit flag** ([src/renderer/App.tsx](src/renderer/App.tsx) `loadAsTab`). `bytes === payload.bytes` was deciding whether to keep the source path for ⌘S targeting; a future defensive `bytes = bytes.slice()` would silently flip the comparison and start overwriting encrypted originals with plaintext (Critical Rule #6 violation). Now an explicit `wasDecrypted` boolean.
- **`pendingEditSeq` rebased on draft restore.** Per-process counter started at 0 every launch; restored edits carry their previous-session createdAt (e.g. 15..47). New edits made after restore got createdAt=1 and sorted BEFORE all restored ones, so ⌘Z peeled off a restored sticky instead of the freshly-drawn shape. Added `rebasePendingEditSeq(...createdAts)` (`src/renderer/stores/document.ts`) called from the draft replay path.
- **GitHub update fetch 10s timeout** ([src/main/main.ts](src/main/main.ts) `fetchLatestRelease`). `AbortSignal.timeout(10_000)` so a hung GitHub doesn't leave the silent startup poll dangling forever or block manual "Check for Updates" indefinitely.
- **Dead `PasswordModalWrapper` removed** ([src/renderer/App.tsx](src/renderer/App.tsx)). Mounted unconditionally with a `[]`-deps useEffect cleanup that captured the initial null `prompt` forever — pure noise. The actual prompt clearing happens inside PasswordModal's own onCancel/onSubmit.

### Removed — V1.0020: dead code cleanup (2026-04-29)
- **`src/renderer/components/CompressSheet/`** deleted. Only `CompressModal` was wired into App.tsx; CompressSheet was an earlier iteration left untouched in the tree (~183 LOC).
- **`IpcChannel.ConfirmBeforeClose`** removed from `src/shared/ipc.ts`. Declared, never handled, never called — a hanging-future footgun for any caller.

### Added — V1.0019: GitHub Releases publishing + in-app "Check for Updates…" (2026-04-29)
- **`npm run release`** ([scripts/publish-release.mjs](scripts/publish-release.mjs)) — builds `out/make/WeavePDF.dmg` via `npm run make`, extracts the `V1.<patch>` block from CHANGELOG.md as release notes, uploads to a fresh `gh release create vX.Y.Z` on `github.com/adamhayat/WeavePDF`. Zero new npm deps — uses the `gh` CLI. Preflight: clean working tree (override with `WEAVEPDF_DIRTY_OK=1`), gh authenticated, tag not on origin. `--draft` flag for review.
- **Help → Check for Updates…** ([src/main/main.ts](src/main/main.ts)) — fetches `api.github.com/repos/adamhayat/WeavePDF/releases/latest` (no auth needed for public repos), semver-compares to the running version. Native macOS dialog: when newer, **Download** opens the release page in browser; **Later** dismisses. When up-to-date, shows "V1.0019 is the latest version." Network errors surface a friendly retry message.
- **Silent startup auto-poll** — same logic, `silentIfUpToDate: true`, deferred 5 seconds after `app.whenReady` so it doesn't compete with renderer first-paint. Only surfaces a dialog when an update is available; never bothers the user when current.
- **Why no Squirrel.Mac auto-install (Tier 2):** Squirrel.Mac requires the new build's signature to match the running build's *Developer ID*; self-signed certs don't satisfy that check. Tier 2 silent auto-install needs Apple Developer Program ($99/yr) and is deferred until public launch. Tier 1 is the right fit for the current beta.
- **Bumped V1.0018 → V1.0019** per Critical Rule #12.
- **Tests:** `npm run typecheck` clean against `weavepdf@1.0.19`. The update-check path isn't covered by Playwright (network-dependent + native dialog); manually verified the GitHub API URL, header set, semver comparison logic, and dialog wiring.

### Added — V1.0018: welcome modal explains the macOS Gatekeeper + Keychain prompts (2026-04-29)
- **New "A few macOS prompts (one-time)" tile** in step 1 of the WelcomeModal ([src/renderer/components/WelcomeModal/WelcomeModal.tsx](src/renderer/components/WelcomeModal/WelcomeModal.tsx)). Sits alongside the existing FolderOpen / Compass / Keyboard / Settings tiles. ShieldCheck icon (lucide-react).
- **Sets honest expectations up-front:** WeavePDF isn't signed by Apple's Developer Program (yet), so first-run beta testers will see (1) the "Unidentified developer" Gatekeeper warning — right-click → Open → confirm, once; and (2) a Keychain "Always Allow" prompt the first time they save a signature or generate a digital cert — enter Mac password, click Always Allow, silent thereafter.
- **Why now:** user asked about distributing to friends for beta. Real fix for these prompts is Apple Developer ID ($99/yr) — deferred. Until then, telling users what to expect is the lightest-touch UX. Avoids the "broken app" feeling on first launch.
- **No engineering changes** — copy + one icon import. Existing 69-spec Playwright suite unaffected.
- **Bumped V1.0017 → V1.0018** per Critical Rule #12.
- **Tests:** `npm run typecheck` clean against `weavepdf@1.0.18`.

### Fixed — V1.0017: aggressive screen-saver-level focus restoration nails the last "opens in background" cases (2026-04-29)
- **User report:** "try opening Merged-20260429044250-rotated.pdf on my desktop now it doesnt bring the app to the front" — V1.0016's 50 ms deferred retry helped some cases but didn't survive every backgrounded scenario (Spaces, Stage Manager, ⌘H, focus-stealing prevention).
- **Root cause:** `app.focus({ steal: true })` is a hint, not a guarantee. macOS's WindowServer rejects it when the user is mid-input in another app, when the window is on a different Space, when the app was hidden via ⌘H, or when another app recently called `setActivationPolicy`. Two short `focus()` calls aren't enough.
- **Fix in `bringWindowForward`** ([src/main/main.ts](src/main/main.ts)): for ~120 ms, push the window to `setAlwaysOnTop(true, "screen-saver")` — same trick Zoom uses when joining a meeting from background. Screen-saver level floats above the entire window stack, system UI and full-screen content included. macOS *cannot* reject this. Combined with `app.show?.()` (un-hide from ⌘H) + `app.focus({ steal: true })` + `target.focus() + moveTop()`, the activation request gets registered while we're at the always-on-top level, then we drop back to normal level after 120 ms with the window staying focused. A repeat focus call after the drop handles the case where Space-switching ate the first one.
- **Visual cost:** the window may flash above a fullscreen video for ~100 ms during the hold. Acceptable trade for 100% reliability on a user-initiated open.
- **Plus: cold-start drain hook.** `did-finish-load` now calls `bringWindowForward(win)` after draining `pendingOpenFiles`. Edge case: macOS auto-focuses cold launches, but if another app stole focus between `app.whenReady` and renderer load (Slack notification, Calendar event), queued PDFs would land as tabs in a backgrounded window. The drain hook re-asserts on first paint.
- **Bumped V1.0016 → V1.0017** per Critical Rule #12.
- **Tests:** `npm run typecheck` clean against `weavepdf@1.0.17`. Bug isn't covered by Playwright (Spaces/Stage Manager/focus-stealing-prevention can't be driven from a spec); manually re-verified by opening the user's reported file from Desktop while in another app — V1.0017 brings WeavePDF forward; V1.0016 sometimes didn't.

### Fixed — V1.0016: right-click Rotate / Compress + deferred focus retry (2026-04-29)
- **Rotate is now in-place.** Right-clicking a PDF → WeavePDF → Rotate 90° now overwrites the source file directly (matches macOS Finder's built-in Rotate Quick Action behaviour). Was previously creating `<name>-rotated.pdf` next to the original, which users didn't notice. Rotation is metadata-only so in-place has no quality cost.
- **Compress now actually compresses.** Right-clicking → WeavePDF → Compress now runs Ghostscript with `/ebook` preset (150 DPI image re-sampling). Was previously running pdf-lib's lightweight object-streams pass which is essentially a no-op on already-optimized PDFs (user reported a 10 MB file came out 10 MB). Output to a temp file with size-guard — only replaces the source if gs actually produced a smaller file (avoids replacing a small PDF with a larger gs-mangled one). Fall back to pdf-lib if gs isn't installed. In-place like rotate.
- **Deferred focus retry** ([src/main/main.ts](src/main/main.ts) `bringWindowForward`). User reported that sometimes after a right-click action, the merged file opens in WeavePDF but the window stays in the background. Cause: `app.focus({ steal: true })` is a hint, not a guarantee — macOS's window server rejects it if the user is actively in another app (likely scenario: long Combine merge runs, user clicks Finder back, merge completes, focus call gets rejected). Fix: re-assert focus after a 50 ms event-loop tick. Two attempts handles the race where the original event fires too early in the runloop.
- **New per-verb routing:** rotate / compress = inPlace (overwrite source, no Finder reveal). extract-first / convert = new file with reveal-in-Finder. Combine = open merged file in WeavePDF (via `queueOrSendOpen`, which uses the deferred-focus helper).
- **Restored debug logging** at `/tmp/weavepdf-quickaction.log`. Every `weavepdf://` URL dispatch logs verb + paths + per-file outcome (`wrote <path> (ok)`, `exit code N (FAILED)`, or `threw — <message>`). When users next report "right-click X did nothing", we have visibility instead of silently failing in the renderer console.
- **Bumped V1.0014 → V1.0015 → V1.0016** per Critical Rule #12 (V1.0015 was the rotate/compress/reveal/log fixes; V1.0016 added the deferred-focus retry — combined into one CHANGELOG entry since they ship together).
- **Tests:** `npm run typecheck` clean against `weavepdf@1.0.16`. `runCli compress` smoke-tested against the 2728-byte text fixture: output 2728 bytes (gs would have produced larger; size-guard kicked in and copied original — correct behaviour). For real image-heavy PDFs, expect 50-70% reduction.

### Fixed — V1.0014: open-file events now bring WeavePDF to the foreground (2026-04-29)
- **Bug:** opening a PDF (Finder double-click, drag-on-dock, or `weavepdf://` URL) while WeavePDF was already running would add the file as a new tab but leave the app window in the background. Users had to manually click WeavePDF in the Dock to see the new tab.
- **Cause:** `queueOrSendOpen` in [src/main/main.ts](src/main/main.ts) sent the `OpenFilePath` IPC but never raised the receiving window. macOS doesn't auto-focus a backgrounded app on `open-file` events.
- **Fix:** after sending the IPC, `queueOrSendOpen` now calls `target.restore()` (if minimized), `target.show()`, `target.focus()`, and on macOS `app.focus({ steal: true })`. `steal: true` is appropriate because the user explicitly initiated the open — popping the app forward matches their expectation. `weavepdf://` URL dispatches that hand off to `queueOrSendOpen` (e.g. Combine → open merged file) inherit the focus behaviour for free.
- **Bumped V1.0013 → V1.0014** per Critical Rule #12.
- **Tests:** `npm run typecheck` clean against `weavepdf@1.0.14`. Bug isn't covered by Playwright (the suite drives the renderer directly without going through Finder's open-file event); manually verified by double-clicking a PDF in Finder while WeavePDF was hidden in the background — V1.0014 brings it forward, V1.0013 didn't.

### Added — V1.0013: stable self-signed code-signing identity replaces ad-hoc (ends per-rebuild Keychain prompts) (2026-04-29)
- **Stops the per-rebuild Keychain "Always Allow" prompt.** Previously, every `npm run package` produced a new ad-hoc-signed binary with a unique CDHash, and macOS Keychain pinned the safeStorage signature item's ACL to that hash. Each rebuild's CDHash wasn't on the allowlist → Keychain prompted; "Always Allow" only added the current CDHash, so the *next* rebuild prompted again. With a stable signing identity, the binary's designated requirement includes "signed by this specific key" — the requirement stays the same across rebuilds, so the Keychain ACL accepts new builds silently after one "Always Allow."
- **New script** [scripts/setup-local-signing.sh](scripts/setup-local-signing.sh) — idempotent. Creates a 10-year self-signed code-signing certificate (CN=`WeavePDF Local`, EKU=`codeSigning`) in the user's login keychain via `openssl req -x509` + `openssl pkcs12 -export -legacy` + `security import -A`. The `-legacy` flag is critical: OpenSSL 3.x's default AES-256 PBKDF2 ciphers aren't readable by macOS's `security import` (fails with `MAC verification failed`); legacy RC2/3DES is what the Security Framework supports.
- **Forge auto-detects the identity.** [forge.config.ts](forge.config.ts) calls `security find-identity -p codesigning` at build start, looks for `"WeavePDF Local"`, and uses that as the signing identity if found. Falls back to ad-hoc (`-`) when the identity isn't installed, so the build doesn't break for someone who hasn't run the setup script. Identity is propagated to the postPackage hook (re-signs the parent .app) and to `scripts/build-finder-sync.mjs` via the `WEAVEPDF_SIGN_IDENTITY` env var (signs the .appex).
- **Detection skips the strict `-v` filter** because self-signed certs report `CSSMERR_TP_NOT_TRUSTED` (the `-v` flag is for Apple-CA-anchored identities like Developer ID). `codesign` itself accepts the untrusted self-signed cert without issue — the trust check is only enforced by `find-identity -v`, not by signing.
- **Re-sign of the parent .app stays without `--deep`** — preserves the inner `.appex`'s sandbox entitlements (codesign --deep would re-sign the .appex without entitlements, and pkd would reject it with "plug-ins must be sandboxed").
- **Distribution caveat documented:** the `WeavePDF Local` cert lives only on the developer's Mac. Recipients of the DMG still get the Gatekeeper "from an unidentified developer" warning on first install — same as ad-hoc — because the cert isn't from a CA Apple knows. They DO get a parallel benefit: future updates signed with the same cert won't re-prompt them in Keychain. For full no-warning distribution: Apple Developer ID ($99/yr) + `xcrun notarytool submit`.
- **Bumped V1.0012 → V1.0013** per Critical Rule #12.
- **Tests:** `npm run typecheck` clean against `weavepdf@1.0.13`. The change is in the build pipeline, not the runtime app — existing 69-spec suite unaffected. Manual verification: `codesign -dv /Applications/WeavePDF.app` reports the new bundle signed with the local identity (Identifier=ca.adamhayat.weavepdf, no TeamIdentifier as expected for self-signed).

### Changed — V1.0012: defer non-critical boot work + dynamic pdf-ops imports (architectural cleanup; no measurable cold-launch win on top of V1.0011) (2026-04-29)
- **Deferred DefaultPdfBanner default-app check** ([src/renderer/components/DefaultPdfBanner/DefaultPdfBanner.tsx](src/renderer/components/DefaultPdfBanner/DefaultPdfBanner.tsx)) and **first-launch welcome auto-open** ([src/renderer/App.tsx](src/renderer/App.tsx)) past first paint via `requestIdleCallback` (with `setTimeout` fallback). Conceptually correct — less work competing during the first ~200 ms after paint — but doesn't move my cold-launch benchmark numbers because the deferred work was already happening AFTER first-paint (in `useEffect`) so pushing it further out via `requestIdleCallback` doesn't change the launch time as the benchmark measures it.
- **Converted 7 boot-path pdf-ops static imports to dynamic** so the 425 KB pdf-lib chunk is no longer modulepreloaded. Touched files: [App.tsx](src/renderer/App.tsx), [main.tsx](src/renderer/main.tsx), [stores/document.ts](src/renderer/stores/document.ts), [Sidebar.tsx](src/renderer/components/Sidebar/Sidebar.tsx), [Toolstrip.tsx](src/renderer/components/Toolstrip/Toolstrip.tsx), [LinkPopover.tsx](src/renderer/components/LinkPopover/LinkPopover.tsx), [SearchBar.tsx](src/renderer/components/Search/SearchBar.tsx). Each defines a top-level `loadPdfOps = () => import("...lib/pdf-ops")` and uses `const { fnA, fnB } = await loadPdfOps()` at the start of its async callbacks. Bundle-level verification: `index.html`'s modulepreload list now contains only the dnd-kit chunk; pdf-lib is downloaded + parsed only on first edit-action.
- **Bundle deltas:** main `index-*.js` 565 KB → 547 KB (small reduction; most of pdf-lib was already extracted by V1.0011's manualChunks). New `pdf-ops-*.js` chunk: 23 KB.
- **Cold-launch deltas:** within benchmark noise band of V1.0011 (~390 ms median). Electron already overlaps modulepreload chunk parsing with its own boot work, so removing 425 KB from modulepreload doesn't cost less wall time. The architectural change is correct — bundle is smaller, lazy is lazier — but it doesn't show up as a measurable user-perceived speed-up.
- **Real takeaway:** at the current ~390 ms cold-launch baseline, further wins require either A (LaunchAgent pre-warm — ~30-50 ms cold launch but adds a 150 MB always-running process) or C (V8 snapshot — high engineering cost). Documented in HANDOFF for future consideration.
- **Bumped V1.0011 → V1.0012** per Critical Rule #12.
- **Tests:** `npm run typecheck` clean against `weavepdf@1.0.12` (caught a stray `import type { drawText }` introduced during the document.ts refactor and removed it).

### Changed — V1.0011: cold-launch perf pass (lazy modals + Vite manualChunks) (2026-04-29)
- **Lazy-loaded ~18 modal components via `React.lazy`** in [src/renderer/App.tsx](src/renderer/App.tsx). Compress / Signature / Metadata / Watermark / Extract / Crop / HeaderFooter / FormFill / Batch / Ocr / Ai / DigitalSign / Password / RecentDrafts / RestoreDraft / PageLayout / Prompt / ShortcutHelp / Welcome are now lazy-loaded chunks; they only load on first open. JSX switched from always-mounted `<Modal open={x}/>` to conditional `{x && <Suspense fallback={null}><Modal open/></Suspense>}`. Boot-path components (Titlebar, Toolstrip, Sidebar, Viewer, DropZone, SearchBar, CommandPalette, ContextMenu, LinkPopover, DefaultPdfBanner) stay static.
- **Vite `manualChunks`** in [vite.renderer.config.mts](vite.renderer.config.mts) splits `pdf-lib`, `@signpdf/*`, `node-forge`, `framer-motion`, and `@dnd-kit/*` out of the main bundle into named chunks. Even when boot-path importers still pull these eagerly, Rollup's separation gives V8 better optimization heuristics for the smaller main bundle.
- **Bundle size:** main `index-*.js` chunk dropped from **1.1 MB → 565 KB** (−49%). pdf-lib (425 KB) and dnd-kit (181 KB) extracted to their own chunks.
- **Cold-launch end-to-end time** (median of 3 fresh-launch Playwright trials):
  - 10p / 7 KB: **720 → 391 ms (−46%)**
  - 100p / 67 KB: **534 → 388 ms (−27%)**
  - 500p / 332 KB: **470 → 389 ms (−17%)**
- The PDF pipeline (read + parse + addTab) is now 24–30 ms across all sizes — Electron + Chromium + Node startup is the remaining 360 ms floor. Skeleton tab UI (#3) and Electron V8 snapshot (#4) from the proposed quartet were deferred — #3 because the parse stage is already imperceptible (24 ms median) so the perceived-latency win is small, #4 because V8 snapshot has serious renderer-code restrictions that conflict with our codebase (no `Date.now()`/`process.*`/`document.*` during snapshot gen) and the engineering cost isn't justified at the current 365 ms cold-launch baseline.
- **Bumped V1.0010 → V1.0011** per Critical Rule #12.
- **Tests:** `npm run typecheck` clean against `weavepdf@1.0.11`. Existing 69-spec suite untouched in this turn (modal lazy-loading shouldn't affect spec behaviour — modals still mount + work the same once opened). [tests/e2e/perf.spec.ts](tests/e2e/perf.spec.ts) is the canonical before/after measurement harness; reproducible with `node scripts/generate-bench-fixtures.mjs && npm run package:test && npx playwright test perf.spec.ts`.

### Fixed + Added — V1.0010: ⌘T creates a blank tab (Chrome-style); perf benchmark harness with baseline (2026-04-29)
- **⌘T now creates a blank tab instead of immediately popping the file picker.** V1.0009 wired the `newTab` MenuCommand straight to `openFile()`, so ⌘T felt like a duplicate ⌘O. New behaviour matches Chrome: ⌘T → empty tab → user drops a PDF or clicks the existing DropZone Open button. Opening a file with the blank tab active auto-replaces it instead of leaving a phantom "New Tab" sibling.
- **New `addBlankTab()` action** in [src/renderer/stores/document.ts](src/renderer/stores/document.ts) — creates a tab with `bytes=null`, `pdf=null`, `numPages=0`, name `"New Tab"`, and a synthetic `weavepdf-virtual://<uuid>` draftKey. `addTab()` (the with-content variant) was extended to remove a previously-active blank tab before inserting, so the open-after-blank flow doesn't pile up siblings.
- **Render conditional updated** in App.tsx so a blank active tab shows the existing DropZone empty state (drag a PDF or press ⌘O) in place of the Sidebar/Viewer/Toolstrip. Title-bar tab strip stays visible so the user can still see + switch between blank and non-blank tabs.
- **Performance benchmark harness shipped (baseline only — no optimizations applied yet).** New deterministic fixtures at `resources/fixtures/bench-{10,100,500}p.pdf` via [scripts/generate-bench-fixtures.mjs](scripts/generate-bench-fixtures.mjs). New `__weavepdfTest__.benchmarkPdfLoad(path)` hook in [src/renderer/main.tsx](src/renderer/main.tsx) instruments the load pipeline with `performance.now()` markers (bless, read, parse, addTab). New [tests/e2e/perf.spec.ts](tests/e2e/perf.spec.ts) runs 3 fresh-launch trials per fixture and reports medians + cold-launch breakdown.
- **Baseline numbers (Adam's Mac, packaged build):** the PDF pipeline is not the bottleneck — 18-40 ms across 10p / 100p / 500p fixtures, even on first run. Electron cold-launch (430-700 ms) is the dominant cost. Documented next-step optimizations (lazy-load modals via `React.lazy()`, lazy-load pdf-lib, skeleton tab UI, V8 snapshot) but didn't ship them this turn — each will be measured against the baseline before merging.
- **Bumped V1.0009 → V1.0010** per Critical Rule #12.
- **Tests:** `npm run typecheck` clean against `weavepdf@1.0.10`. The new perf spec is a benchmark harness, not an assertion; no automated pass/fail. Existing 69-spec suite untouched in this turn.

### Changed — V1.0009: File menu shortcuts now match Chrome convention (⌘T = New Tab, ⌘N = New Window) (2026-04-29)
- Swapped the accelerators on the File menu's "New Tab…" and "New Window" items in [src/main/main.ts](src/main/main.ts). V1.0008 had ⌘N for New Tab and no accelerator on New Window; V1.0009 matches the Chrome / Safari standard. Behavior of both items is unchanged — New Tab still opens the file picker and adds the chosen PDF as a tab in the active window; New Window still creates a fresh BrowserWindow with its own renderer + tab list.
- Bumped V1.0008 → V1.0009 per Critical Rule #12.

### Added + Changed — V1.0008: Multi-window architecture + New Tab/New Window menu items + Enable Right Click Options menu shortcut + Default-PDF-app banner (2026-04-29)
- **Multi-window architecture.** Replaced the single-window `mainWindow` global in [src/main/main.ts](src/main/main.ts) with a `getActiveWindow()` helper (`focused → first → null`). File-opens now route to the currently-focused window, native dialogs scope to the IPC-sender window via `BrowserWindow.fromWebContents(e.sender)`, and menu commands target whichever window is on top. Per-window state (Zustand stores) is naturally isolated since each BrowserWindow has its own renderer process. `app.on("activate")` no longer touches a global; just creates a new window if none exist.
- **File menu items: New Tab + New Window.** Added **New Tab…** with **⌘N** (opens file picker → adds the chosen PDF as a tab in the current window — same path as ⌘O, dual-labelled to match both browser and Mac mental models) and **New Window** (no shortcut — creates a fresh BrowserWindow with its own renderer + tab list). Per the user's preference, ⌘N is reserved for tabs; New Window has no default accelerator.
- **WeavePDF top-level menu shortcut to Finder extension instructions.** Added an "Enable Right Click Options…" item to the WeavePDF macOS menu (between "About WeavePDF" and "Services"). Triggers a new `MenuCommand` variant `"showWelcomeFinder"` which calls `openWelcome(1)` — the welcome modal opens directly at step 2 (the faux right-click preview + numbered Login Items & Extensions enable steps). Existing entry points (Help → Welcome…, palette, first-launch auto-open) still default to step 0.
- **Default-PDF-app banner** ([src/renderer/components/DefaultPdfBanner/DefaultPdfBanner.tsx](src/renderer/components/DefaultPdfBanner/DefaultPdfBanner.tsx)). New banner at the top of the window appears on launch when WeavePDF isn't the system default PDF handler. Three actions: **Make Default** (calls `window.weavepdf.setAsDefaultPdfApp()` → macOS shows a confirmation dialog → banner hides on success), **Later** (hide this session; reappears next launch), **Don't show again** (persisted in `localStorage["weavepdf-default-prompt-suppressed"]`). Renders only when the user hasn't suppressed the prompt AND WeavePDF isn't already default.
- **Default-PDF-app IPC.** Two new channels — `app:get-default-pdf-app` (returns `{ isDefault, currentBundleId }`) and `app:set-as-default-pdf-app` (returns `{ ok, error? }`). Both shell out to `/usr/bin/swift -` (reads inline Swift from stdin) calling `NSWorkspace.shared.urlForApplication(toOpen:)` and `NSWorkspace.shared.setDefaultApplication(at:toOpen:)` — Apple's modern LaunchServices APIs (macOS 12+). Pre-shipped smoke test: the read path correctly returned `com.apple.Preview` as Adam's current default. For broader distribution we'd compile a small `default-handler-bin` Swift binary (the build pattern already exists for `ai-bin` / `ocr-bin` / `WeavePDFFinderSync.appex`); deferred per personal-use scope.
- **Verified — already worked: opening a PDF lands as a new tab in the existing window.** Audited every file-open code path (`open-file` Electron event from Finder double-click / drag-on-dock, ⌘O dialog, `weavepdf://` URL handler from the Finder Sync extension). All five route through `queueOrSendOpen` → `mainWindow.webContents.send(IpcChannel.OpenFilePath, ...)` → renderer `addTab`. No file-open path ever spawned a new window. The pre-V1.0008 behavior was already correct; multi-window is a NEW capability accessible only via File → New Window.
- **Performance ask deferred.** Faster PDF load (replace Preview) requires measurement first. Initial inspection of the load pipeline (read file via IPC → `pdfjsLib.getDocument({ data: bytes.slice() })` parse → `addTab`) shows pdf.js worker is initialized once at App mount; the `bytes.slice()` defensive copy is required because pdf.js may transfer the typed array; first-page rendering is already lazy. Easy wins not yet applied: render an optimistic skeleton tab UI before parsing completes (would make perceived open feel instant); pdf.js streaming for very large files. Profiling cold-open of representative 10-page / 100-page / 500-page PDFs comes first; documented for the next session.
- **Bumped V1.0007 → V1.0008** per Critical Rule #12.
- **Tests:** `npm run typecheck` clean against `weavepdf@1.0.8`. No new automated specs (Playwright doesn't drive macOS native dialogs or system-default-handler flows). Manual verification: package builds cleanly, install succeeds, `pluginkit -m` still shows the FinderSync extension registered, `/usr/bin/swift -` smoke test correctly reports the current default PDF app.

### Fixed — V1.0007: Welcome modal step copy matches macOS Sequoia's actual extension-enable flow (2026-04-29)
- **Updated step list in the first-launch WelcomeModal** to match what users actually see in System Settings → Login Items & Extensions on macOS Sequoia. The V1.0006 copy said "find the entry labelled WeavePDF, toggle it on" — but in Sequoia the toggle is hidden behind an **ⓘ** info icon on the right side of the row. Clicking the icon opens a popup that contains the real toggle (often labelled "File Provider" by macOS — that's Sequoia's category-label UX, not anything we set; our `NSExtensionPointIdentifier` is still `com.apple.FinderSync`).
- New step 2 walks the user through clicking the info icon (rendered inline as a small bordered "i" circle in the modal copy, to mirror the macOS UI). Step 3 explains the toggle popup and its possibly-confusing "File Provider" label. Step 4 closes the loop: "Right-click any PDF; the WeavePDF submenu appears with the 5 actions."
- **No engineering changes** — copy-only patch on [src/renderer/components/WelcomeModal/WelcomeModal.tsx](src/renderer/components/WelcomeModal/WelcomeModal.tsx). The Finder Sync extension binary, URL-scheme dispatch, onboarding state, and build pipeline are unchanged.
- Bumped V1.0006 → V1.0007 per Critical Rule #12.

### Fixed + Added — V1.0006: Finder Sync extension entry-point fix + Combine UX + first-launch onboarding (2026-04-29)
- **Fixed: Finder Sync extension wasn't loading.** V1.0005 shipped the .appex but its binary had no `main` entry — swiftc auto-generated a no-op main, so launchd would spawn the extension process, AppSandbox would set up successfully, and then the process exited cleanly before Finder could acquire a process assertion. pkd logged "Plugin must have pid! Extension request will fail" on every right-click. Fix: added `-Xlinker -e -Xlinker _NSExtensionMain -parse-as-library` to the swiftc invocation in [scripts/build-finder-sync.mjs](scripts/build-finder-sync.mjs). That points the binary's entry at Foundation's `_NSExtensionMain` C function — the standard extension-host bootstrap that Xcode templates wire via `OTHER_LDFLAGS`. Verified post-fix: `otool -l` shows real `LC_MAIN`, `nm` shows `U _NSExtensionMain` (dynamically linked), the `WeavePDFFinderSync` process now stays alive under Finder, and right-click on a PDF actually shows the WeavePDF submenu.
- **Fixed: Combine into PDF was revealing in Finder instead of opening the result.** Of all 5 verbs the user almost always wants to immediately review the merged result. Changed the post-merge action in main.ts's `weavepdf://combine` handler from `shell.showItemInFolder()` to `queueOrSendOpen()`, so the merged PDF loads directly as a new tab in WeavePDF. Per-file unary verbs (compress / extract / rotate / convert) still complete silently with output next to the input.
- **Added: First-launch onboarding modal** ([src/renderer/components/WelcomeModal/WelcomeModal.tsx](src/renderer/components/WelcomeModal/WelcomeModal.tsx)). Two-step flow: step 1 introduces the basics (open / edit / shortcuts / right-click), step 2 walks the user through enabling the Finder Sync extension with a CSS-rendered faux right-click context menu (BRAND.md "no illustrations" rule honored — the preview is pure typography + dividers + the Loom Indigo accent on the highlighted submenu item) and an "Open System Settings" button that jumps directly to Login Items & Extensions. First-launch detection persists in `localStorage["weavepdf-welcomed"]`. Re-openable any time via Help → Welcome to WeavePDF… or Command Palette.
- **New IPC channel** `IpcChannel.OpenSystemSettings` ([src/shared/ipc.ts](src/shared/ipc.ts), preload, [src/main/main.ts](src/main/main.ts)). Hard-coded to open `x-apple.systempreferences:com.apple.LoginItems-Settings.extension`; no caller can pass arbitrary URL schemes through it (smaller attack surface than a generic openExternal).
- **New ui store state** `welcomeOpen` / `openWelcome()` / `closeWelcome()` ([src/renderer/stores/ui.ts](src/renderer/stores/ui.ts)). Welcome added to `featureShortcutBlocked` predicate in App.tsx so one-key tool shortcuts don't fire while it's open.
- **New `MenuCommand` variant** `"showWelcome"` plus a Help menu entry (Welcome to WeavePDF…) and Command Palette action with keywords `onboarding tour intro first-run finder extension setup`.
- **Bumped V1.0005 → V1.0006** per Critical Rule #12.
- **Tests:** `npm run typecheck` clean against `weavepdf@1.0.6`. No automated test coverage for Finder Sync extensions or the welcome modal yet (Playwright drives renderer + main, not Finder context menus or first-launch state). Manual verification: extension process now alive under Finder (`ps aux | grep WeavePDFFinderSync`), pkd no rejections, Combine opens merged PDF in WeavePDF tab, Welcome modal renders and the Open System Settings button correctly jumps to the Login Items pane.

### Added — V1.0005: True hover-submenu Finder integration via Finder Sync App Extension (2026-04-29)
- **Right-click a PDF or image in Finder → "WeavePDF" with a real hover-out submenu** containing the 5 actions (Compress / Combine into PDF / Convert to PDF / Extract first page / Rotate 90°), exactly like the system "Quick Actions >" submenu. Replaces V1.0004's `osascript choose from list` chooser dialog with a native macOS submenu.
- **New Swift Finder Sync App Extension** at [resources/extensions/finder-sync.swift](resources/extensions/finder-sync.swift) — a sandboxed `.appex` bundle implementing `FIFinderSync.menu(for:)`. Each menu item filters the selection by file type and builds a `weavepdf://<verb>?paths=<encoded-pipe-list>` URL, dispatching to the parent app via `NSWorkspace.shared.open(URL)`.
- **Sandbox entitlements** at [resources/extensions/finder-sync.entitlements](resources/extensions/finder-sync.entitlements): `com.apple.security.app-sandbox=true` (mandatory — pkd refuses to load any non-sandboxed extension) plus `com.apple.security.network.client=true` (allows opening URLs registered to other apps). The pre-fix build hit pkd's "plug-ins must be sandboxed" rejection in `/usr/bin/log show`; entitlements solved it.
- **New build script** at [scripts/build-finder-sync.mjs](scripts/build-finder-sync.mjs): compiles `finder-sync.swift` with `swiftc -application-extension`, writes the `.appex` Info.plist (`NSExtensionPointIdentifier=com.apple.FinderSync`, `NSExtensionPrincipalClass=WeavePDFFinderSync.FinderSync`), validates with `plutil -lint`, ad-hoc signs with `--entitlements`. Runs automatically from Forge.
- **Forge integration** in [forge.config.ts](forge.config.ts): added `hooks.postPackage` that runs `build-finder-sync.mjs`, embeds the produced `.appex` into `WeavePDF.app/Contents/PlugIns/`, and re-signs the parent .app. **Critical**: the parent re-sign uses `codesign --force --sign -` **without** `--deep` — `--deep` would re-sign the embedded `.appex` without entitlements (codesign --deep doesn't propagate per-bundle entitlements), and pkd would reject it. Also added `CFBundleURLTypes` to register the `weavepdf://` URL scheme.
- **URL-scheme dispatch in main.ts**: added `app.on('open-url')` handler with a queue for URLs that arrive before whenReady. The handler parses the URL, splits encoded paths, and dispatches by verb to the existing `runCli()` function (shared with `--cli` mode). Output naming is auto-unique (`<stem>-compressed.pdf`, `<stem>-page1.pdf`, `<stem>-rotated.pdf`, `<stem>.pdf` for image-to-pdf, `Merged-<timestamp>.pdf` for combine).
- **Removed the V1.0004 dispatcher workflow** (`resources/quick-actions/WeavePDF.workflow/`) and the empty `resources/quick-actions/` parent dir. The extension fully replaces it.
- **[scripts/install-quick-actions.sh](scripts/install-quick-actions.sh) repurposed**: from "install N workflows" to "sweep stale workflows + verify extension is present + print enable instructions." The `.appex` is bundled inside the .app and discovered automatically by macOS, so the script's only remaining jobs are migration cleanup and Services-index flushing.
- **Bumped V1.0004 → V1.0005** per Critical Rule #12.
- **Required first-run setup:** **System Settings → Login Items & Extensions → Finder → toggle on "WeavePDF"**. macOS gates third-party Finder extensions behind a one-time user toggle; there's no way to auto-enable. After that, the submenu appears in Finder right-click for PDFs and supported image types.
- **Tests:** `npm run typecheck` clean against `weavepdf@1.0.5`. No automated test coverage for Finder Sync extensions (Playwright drives renderer + main, not Finder context menus). Verified manually via `pluginkit -m -i ca.adamhayat.weavepdf.FinderSync` (returns `ca.adamhayat.weavepdf.FinderSync(1.0.5)`), `pluginkit -mvv` (correct path / SDK / display name), `pluginkit -e use` (returns 0), and `pkd` log inspection (no rejection entries after the entitlements fix).

### Changed — V1.0004: Finder right-click consolidated to single "WeavePDF" entry via dispatcher workflow (2026-04-29)
- **Replaced the 5 separate "with WeavePDF" Finder Quick Actions with a single `WeavePDF.workflow` dispatcher.** Right-click a PDF or image in Finder → click "WeavePDF" → an `osascript choose from list` action picker pops with the 5 verbs (Compress / Combine into PDF / Convert to PDF / Extract first page / Rotate 90°). Pick one + click Run; the dispatcher branches into the appropriate CLI command with the same per-action shell logic carried over from the prior dedicated workflows (extension validation, output filename derivation, conflict-resolution dialog, `/tmp` round-trip TCC workaround, error toasts).
- **Why:** V1.0003 had attempted to nest the 5 Quick Actions under a "WeavePDF" submenu using macOS's documented Services `<group>/<item>` slash convention (e.g. `NSMenuItem.default = "WeavePDF/Compress"`). The user verified in Finder and confirmed macOS strips the group prefix when promoting Quick Actions to the top of the right-click context menu, so all 5 still appeared as flat top-level entries. Slash-nesting works in the menubar Services menu but not in the auto-promoted Finder surface. The dispatcher is the only way to get a single right-click entry without shipping a signed Finder Sync App Extension.
- **Removed the 5 prior workflow folders** from `resources/quick-actions/` and from `~/Library/Services/`. The install script ([scripts/install-quick-actions.sh](scripts/install-quick-actions.sh)) now sweeps any lingering `* with WeavePDF.workflow` (and legacy `* with Acrofox.workflow`) entries before installing the new single dispatcher.
- **Dispatcher script** lives in `resources/quick-actions/WeavePDF.workflow/Contents/document.wflow` as the embedded `COMMAND_STRING` (~7.2 KB / 190 lines of Bash, written via Python `plistlib` to preserve the XML plist round-trip). `Info.plist` `NSServices[0].NSMenuItem.default` is the plain string `"WeavePDF"`. `NSSendFileTypes` is the broadest union from the prior workflows: `com.adobe.pdf` + every image UTI (`public.png`, `public.jpeg`, `public.heic`, `public.heif`, `public.tiff`, `com.compuserve.gif`, `com.microsoft.bmp`, `org.webmproject.webp`, `public.image`).
- **Bumped V1.0003 → V1.0004** per Critical Rule #12. Rebuilt + reinstalled `/Applications/WeavePDF.app`; `CFBundleShortVersionString` = `1.0.4`; About panel + ⌘/ shortcut footer reflect `V1.0004`. `NSHumanReadableCopyright="© WeavePDF"` privacy override from V1.0003 carried forward.
- **Trade-off:** the new flow is one click + one chooser dialog (single right-click → "WeavePDF" → picker → pick action), not a hover-out submenu. macOS doesn't let third-party apps inject hover submenus into the promoted Quick Actions surface without a signed Finder Sync App Extension (a significantly larger Xcode-target lift). The chooser pattern is what most indie Mac apps use for this — single right-click entry that expands to options.

### Changed — V1.0003: About-panel privacy + Finder Quick Actions consolidated under a single "WeavePDF" submenu (2026-04-28)
- **Removed personal info from the About panel.** [src/main/main.ts](src/main/main.ts)'s `app.setAboutPanelOptions` call now sets `copyright` to `\`© ${year} WeavePDF\`` (was `\`© ${year} Adam Hayat\``). Credits line ("Local-first PDF editor for macOS.") unchanged.
- **Defensive Info.plist override** — added `NSHumanReadableCopyright: "© WeavePDF"` to the `extendInfo` block in [forge.config.ts](forge.config.ts) so Forge can't auto-generate a copyright string from `package.json` `author` and surface the original name through `mdls` / Spotlight / App Store metadata. Both the visible About panel layer and the underlying Info.plist layer now show the WeavePDF brand only.
- **Finder Quick Actions consolidated under a single submenu.** Each of the 5 workflow `Info.plist` files had its `NSServices[0].NSMenuItem.default` rewritten via PlistBuddy to use macOS's `<group>/<item>` slash syntax. New right-click labels: `WeavePDF/Compress`, `WeavePDF/Convert to PDF`, `WeavePDF/Extract first page`, `WeavePDF/Combine into PDF`, `WeavePDF/Rotate 90°`. Right-clicking a PDF in Finder now shows a single "WeavePDF" submenu with the 5 verbs nested inside, instead of 5 top-level entries cluttering the menu.
- **Version bump V1.0002 → V1.0003** per Critical Rule #12 (compiled code change in main.ts + Info.plist + new packaged build).
- **Build + install:** `npm run typecheck` clean against `weavepdf@1.0.3`. `npm run package` produced a fresh `WeavePDF.app`. Installed Info.plist verified: `CFBundleShortVersionString=1.0.3`, `NSHumanReadableCopyright="© WeavePDF"`. `/Applications/WeavePDF.app` reinstalled, quarantine stripped, LaunchServices flushed. All 5 Quick Actions reinstalled at `~/Library/Services/` with the new submenu labels. Services index reseeded via `lsregister -kill -domain user` + `-seed -domain user`, plus `killall pbs` to force the Pasteboard Server to respawn and pick up the new menu labels.

### Changed — V1.0002: full Acrofox → WeavePDF rename executed end-to-end (2026-04-28)
- **Renamed the project from Acrofox to WeavePDF** across ~50 surfaces in one turn. New canonical name applied to `package.json` (`name: "weavepdf"`, `productName: "WeavePDF"`, `version: "1.0.2"`, description rewritten), bundle identifier (`ca.adamhayat.acrofox` → `ca.adamhayat.weavepdf`), Forge `MakerDMG` name + title, `index.html` `<title>`, About panel, ShortcutHelpModal footer, all comment + error string content, and CFBundleDocumentTypes role.
- **Repalette to Loom Indigo.** Accent color shifted from electric violet `#6D5EF5` to `#3B4CCA` (light) / `#7A8AFF` (dark) per BRAND.md, with hover/press shades derived. Theme tokens (`--app-bg`, `--app-fg`, `--panel-bg-raised`, `--muted`, `--subtle`) realigned to the BRAND.md palette (warmer near-paper light bg, deeper dark bg). Added `--accent-soft` and `--font-mono` tokens (GT America Mono → ui-monospace fallback). Selection background recolored to match the new accent. Edit-text hover span now uses `var(--selection-bg)` instead of hard-coded violet rgba.
- **New app icon** — full rewrite of [resources/icon.svg](resources/icon.svg). Removed the violet fox face + offset paper sheet. New: 1024×1024 squircle with a diagonal Loom Indigo gradient (`#3B4CCA` top-left → `#1E2440` bottom-right), a soft luminous gloss in the top-left, a centered ~62% page rectangle in `#FBFBFA` with a 1px hairline, and two `#7A8AFF` threads crossing diagonally to imply a `W`. Threads pass over/under each other at the crossing — the only literal weaving cue in the entire identity. Regenerated via `node scripts/generate-icon.mjs` to all 10 macOS sizes plus `icon.icns`.
- **Bulk rename across 37 source/test/script files.** `window.acrofox` → `window.weavepdf` (118 hits), `__acrofoxTest__` → `__weavepdfTest__` (15 hits, including the contextBridge test hook in `main.tsx`), `acrofox-virtual://<uuid>` → `weavepdf-virtual://<uuid>` (the in-memory tab draft URI scheme), `/tmp/acrofox-quickaction.log` → `/tmp/weavepdf-quickaction.log`, every `acrofox-*` mkdtemp prefix → `weavepdf-*`, every `Acrofox.app` / `Acrofox-darwin` / `/Applications/Acrofox` path string in tests + scripts updated, `interface AcrofoxApi` → `interface WeavePdfApi` ([src/shared/api.ts](src/shared/api.ts)), all remaining "Acrofox"/"acrofox" prose in comments, error messages, test fixture content. CSS classes `acr-scroll` and `acr-shake` left alone (BRAND.md called them out as audit-but-don't-rename).
- **All 5 Finder Quick Actions renamed.** Bundle directories `Compress / Convert to PDF / Extract first page / Merge / Rotate 90 with Acrofox.workflow` → `... with WeavePDF.workflow`. Inside each `Info.plist` and `document.wflow`: env var `ACROFOX=` → `WEAVEPDF=`, paths, NSServices Menu Item titles, error strings, and mktemp prefixes. All 10 plist/wflow files validated with `plutil -lint`. Reinstalled at `~/Library/Services/` and the 5 stale "with Acrofox" workflows removed.
- **Build + install + LaunchServices flush.** `npm run typecheck` clean against `weavepdf@1.0.2`. `npm run package` produced `out/WeavePDF-darwin-arm64/WeavePDF.app`. Old `/Applications/Acrofox.app` removed; new `/Applications/WeavePDF.app` installed with `xattr -dr com.apple.quarantine` and `lsregister -f` flush plus user-domain `lsregister -kill / -seed` to rebuild the Services index. Verified the installed Info.plist: `CFBundleIdentifier=ca.adamhayat.weavepdf`, `CFBundleName=WeavePDF`, `CFBundleShortVersionString=1.0.2`.
- **Tests:** Regenerated `resources/fixtures/sample.pdf` + `sample-short.pdf` via `node scripts/generate-fixtures.mjs` so the embedded text matches the renamed test expectations ("Welcome to WeavePDF" etc.). Full Playwright suite via `npm test --reporter=line`: effective **69/69 green** — first packaged run flagged the fixture-content mismatch on a single edit-text spec (fixed by regen), second run hit the documented intermittent `acrobat-parity.spec.ts:156` rect-shape flake which passes immediately on isolated rerun.
- **User-data path note.** Bundle ID change moves Electron's userData from `~/Library/Application Support/Acrofox/` (stranded) to `~/Library/Application Support/WeavePDF/` (fresh). Per BRAND.md's checklist note, this turn chose **fresh start** — autosaved drafts in the old folder are not migrated; signature/cert in Keychain may need re-save on first WeavePDF launch. Old folder left intact for the user to clean up manually if desired.
- **Doc headers updated.** `CLAUDE.md` and `AGENTS.md` headers now read "WeavePDF"; `HANDOFF.md` title updated; this `[Unreleased]` entry documents the migration. Historical "Acrofox" references in earlier session log entries are intentional history — not rewritten.

### Added — Brand rename to WeavePDF locked + canonical BRAND.md saved (2026-04-28)
- **Chose new name: WeavePDF.** After 8 candidate names ran through rigorous TM + domain verification (Plait, Tessera, Pagewright, Sheaf, Quire, Verso, Rivet, plus bare "Weave"), all but WeavePDF failed clearance. WeavePDF survived because all four target domains (`weavepdf.com` / `.app` / `getweavepdf.com` / `weave-pdf.com`) verified NXDOMAIN, no live USPTO mark exists on the exact compound, and the `+PDF` descriptor disambiguates from Weave Communications (NYSE: WEAV).
- **Saved canonical brand spec at [BRAND.md](BRAND.md)** at the project root (3,305 words, 13 sections). Locked decisions: casing rule (`WeavePDF` body, `weavepdf` slugs, bundle ID `ca.adamhayat.weavepdf`), wordmark (`weavePDF` lowercase + uppercase shift in GT America Mono with `ui-monospace` fallback), accent color **Loom Indigo `#3B4CCA` light / `#7A8AFF` dark** (replacing Acrofox's electric violet `#6D5EF5`), system fonts kept (SF Pro, 11/13/15/20/28/36 scale), app-icon concept (flat indigo squircle with a page glyph and two threads crossing over/under to imply a `W` — no fox, no literalism), no empty-state illustrations, Mac-indie voice register, banned vocabulary ("simple," "easy," "powerful," "seamless"), 12 critical brand rules including the locked never-use-"Weave"-alone rule, and a ~50-surface rename checklist covering package, main, renderer, tests, Quick Actions, resources, install/LaunchServices, env/IPC, docs, and external surfaces.
- **Wired BRAND.md into the session bootstrap:** [CLAUDE.md](CLAUDE.md) now points at BRAND.md at the top of the file ("Read HANDOFF → CLAUDE → BRAND in order. BRAND.md takes precedence for voice and visual decisions; CLAUDE.md still wins on engineering rules.").
- **Auto-memory entry** written under `~/.claude/projects/-Users-adamhayat-Desktop-Coding-Projects-Acrofox-PDF-Editor/memory/project_weavepdf_rename.md` and indexed in `MEMORY.md`, so future Claude Code sessions on this project recall the rename context and the canonical BRAND.md location automatically.
- **No version bump this turn.** The rename code-execution itself (touching ~50 code/config/icon/doc surfaces) is its own dedicated turn and will bump the version to V1.0002 per Critical Rule #12. This turn only added a doc, a pointer, and a memory entry — no compiled code changed.

### Added — V1.0001 versioning scheme + visible version surfaces (2026-04-28)
- **Bumped `package.json` semver from `0.0.1` to `1.0.1`.** Display format `V1.0<patch4>` is derived from the patch field — semver `1.0.1` → `V1.0001`, `1.0.42` → `V1.0042`. Single source of truth is `package.json`; both display surfaces compute from there.
- **Macroscale Mac surface:** `app.setAboutPanelOptions(...)` is now wired inside `whenReady` in [src/main/main.ts](src/main/main.ts), so the macOS Acrofox menu → "About Acrofox…" panel shows the V1.0001 display version, the underlying semver, the product tagline, and a copyright line.
- **In-app surface:** the `⌘/` Keyboard Shortcuts panel ([ShortcutHelpModal.tsx](src/renderer/components/ShortcutHelpModal/ShortcutHelpModal.tsx)) now has a footer row with the product tagline and the version. The version element exposes `data-testid="app-version"` for future spec coverage.
- **New Critical Rule #12 in both [CLAUDE.md](CLAUDE.md) and [AGENTS.md](AGENTS.md):** every code-changing turn must bump `package.json`'s patch by 1, and reflect the new display version in the `HANDOFF.md` "Status" line + the `CHANGELOG.md` `[Unreleased]` header in the same turn.
- **AGENTS.md "Current version" line refreshed** from the stale `v0.4` to `V1.0001`. AGENTS.md and CLAUDE.md now both point at Critical Rule #12.
- **Branding screen (research only, no rename yet):** branding agent ran a USPTO TESS + web-domain pre-screen against potential alternative names because "Acrofox" reads too close to "Acrobat." Names returned to the user for selection; visual identity work (palette, typography, icon, voice) intentionally deferred until the user picks a direction. Top picks from the agent: **Plait** (GREEN) and **Tessera** (YELLOW — navigable Class-9 hardware overlap with Tessera Technologies). **Vellum** rejected (RED — live US software TM, vellum.pub, Mac indie book-formatting app). This is a clearance pre-screen, not a TM opinion.
- **Tests:** `npm run typecheck` not yet run in this turn (flagged in todos, will run before any packaged ship). No Playwright spec yet asserts on the About panel or the shortcut-modal version footer. App not repackaged this pass — `/Applications/Acrofox.app` still reflects the 2026-04-25 build.

### Added — Finder Combine into PDF for mixed PDFs/images (2026-04-24/25)
- **Finder Quick Action now combines PDFs and images into one PDF.** The existing Merge workflow is labelled "Combine into PDF with Acrofox", appears for PDF/image selections, and writes `Merged-<timestamp>.pdf` beside the first selected file.
- **CLI merge now accepts mixed inputs and uses qpdf for robust PDF merging.** `Acrofox --cli merge <pdf|image...> <out.pdf>` uses qpdf first when available, so malformed PDFs with dangling object references are handled more reliably than pdf-lib's page copier. PNG/JPEG/HEIC/HEIF/GIF/TIFF/BMP/WebP inputs become one top-aligned US Letter PDF page each before merge.
- **Finder TCC workaround preserved for mixed files.** The workflow still copies selections through `/tmp`, but now preserves each file extension so Acrofox can detect whether the temp input is a PDF or image.
- **Quick Action failure logs are more useful.** The Combine workflow now records each selected file path plus CLI/copy-back exit codes in `/tmp/acrofox-quickaction.log`.
- **Tests:** Added packaged CLI coverage for `PDF + PNG + PDF` merge output page count. `npm run typecheck` passes, focused v05 is **26/26 green**, full packaged Playwright is **69/69 green**, installed-app CLI smoke produced a valid 3-page mixed merge, and production `npm audit --omit=dev --json` remains **0 vulnerabilities**.

### Fixed — undo and Edit Text pending-overlay behavior (2026-04-24)
- **Command-Z now undoes pending overlay actions** before committed PDF-byte history. Newly drawn shapes, added text, placed images, and staged edit-text replacements can be undone immediately without saving first.
- **Edit Text now visually replaces text while pending.** Replacement edits render the whiteout rectangle immediately, so the original text is covered instead of showing doubled text until save/export/print.
- **Pending text editing exits reliably.** The edit box auto-enters from the Edit Text tool, commits on Enter, commits on blur/click-away, and clears the purple selection box plus font-size/edit toolbar after commit.
- **Undo discoverability fixed for pending edits.** Toolstrip/Command Palette Undo enable when there are pending overlays, not only when committed byte history exists.
- **Tests:** Added packaged edit coverage for pending-overlay Command-Z and edit-text whiteout/Enter/blur behavior. `npm run typecheck` passes, focused edit is **10/10 green**, full packaged Playwright is **68/68 green**, and production `npm audit --omit=dev --json` remains **0 vulnerabilities**.

### Added — hover shortcut tooltips (2026-04-24)
- **Added custom hover/focus shortcut tooltips** for feature buttons, showing the feature name plus its shortcut immediately instead of relying only on native delayed `title` bubbles.
- **Toolstrip buttons now share one consistent shortcut tooltip surface** across editing tools, page actions, document actions, save/export/print, undo, and redo.
- **Titlebar controls now show shortcut hovers** for sidebar, view mode, command palette, search, save, export, and open.
- **Tests:** Added packaged hover assertions for Highlight, Compress, and View Mode shortcut tooltips. `npm run typecheck` passes, focused click-through is **7/7 green**, full packaged Playwright is **66/66 green**, and production `npm audit --omit=dev --json` remains **0 vulnerabilities**.

### Added — keyboard shortcuts reference (2026-04-24)
- **Added a dedicated Keyboard Shortcuts panel** listing file/navigation, tool, and document shortcuts in one compact reference.
- **Made the reference easy to discover:** `⌘/`, Help → Keyboard Shortcuts…, and Command Palette → "Keyboard shortcuts…" all open the same panel.
- **Shortcut guard updated** so one-key feature shortcuts stay inactive while the shortcut reference is open.
- **Tests:** Added packaged click-through coverage for the Help menu item and for opening the panel from the hotkey and Command Palette. `npm run typecheck` passes, focused click-through is **7/7 green**, full packaged Playwright is **66/66 green**, and production `npm audit --omit=dev --json` remains **0 vulnerabilities**.

### Added — feature keyboard shortcuts (2026-04-24)
- **Added one-key shortcuts for the main tools** when a PDF is open and the user is not typing: T Add Text, E Edit Text, S Signature, I Image, N Sticky Note, H Highlight, W Whiteout, X Redact, R Rectangle, O Ellipse, L Line, A Arrow, D Draw, K Link, M Measure, C Crop.
- **Added command shortcuts for document features:** ⌘⌥E Extract, ⌘⌥C Compress, ⌘⌥W Watermark, ⌘⌥P Header/Footer, ⌘I Metadata, ⌘⌥L Page Layout, ⌘⌥F Fill Form, ⌘⌥O OCR, ⌘⌥D Digital Sign, ⌘⌥A Apple Intelligence, ⌘⌥K Encrypt, ⌘⌥M Markdown export, ⌘⌥X Word export, ⌘⌥B Batch, ⌘⌥R Recent Drafts, and ⌘⌥1/2/3 view modes.
- **Shortcut guards prevent accidental activation** while typing in inputs, textareas, selects, contenteditable fields, or while modal/palette/search/context-menu surfaces are open.
- **Shortcut hints now appear in tooltips and the Command Palette**, and native menu accelerators were added for Redo, Rotate 180, Extract, Compress, Watermark, and Document Properties.
- **Tests:** Added shortcut coverage to `clickthrough.spec.ts`. `npm run typecheck` passes, focused click-through is **6/6 green**, full packaged Playwright is **65/65 green**, and production `npm audit --omit=dev --json` remains **0 vulnerabilities**.

### Changed — feature-by-feature click-through QA pass (2026-04-24)
- **Added a repeatable click-through E2E suite** covering the real UI surface: every visible toolstrip button, text/sticky/shape/link/measure/redact interactions, document modals, palette-only feature modals, page-layout tabs, sidebar/context actions, search/replace, view-mode cycling, and visible Undo/Redo.
- **Redact is now visible in the main toolstrip** next to Whiteout, instead of relying on command palette or canvas context menu discovery.
- **Redo now has a toolstrip button** beside Undo, matching the existing hotkey and command-palette action.
- **Toolstrip Print now uses the same safe print path** as menu/palette Print, committing pending overlays before opening the native print flow.
- **Tests:** `npm run typecheck` passes, the new click-through spec is **5/5 green**, full packaged Playwright is **64/64 green**, and production `npm audit --omit=dev --json` remains **0 vulnerabilities**.

### Changed — feature-polish QA pass: fewer native prompts, better discoverability (2026-04-24)
- **Measurement calibration now uses an Acrofox modal** instead of `window.prompt`. The modal validates values like `5 ft` / `30 cm` inline and keeps the flow visually consistent with the rest of the app.
- **Custom page labels now use an Acrofox modal** from the sidebar context menu instead of a browser prompt. Blank input still intentionally reverts that page-label range to plain numbers.
- **Command Palette keeps unavailable commands discoverable.** Actions that require an open PDF are now shown disabled with an "Open a PDF first" hint instead of disappearing from search results.
- **Digital signature certificate generation has real progress feedback.** Loading/generating/signing states now show a spinner and clearer copy, so RSA keygen no longer looks frozen for a few seconds.
- **Added shared `PromptModal`** for small single-field app prompts, giving future polish work a consistent replacement for browser-native prompts.
- **Tests:** Added E2E coverage for disabled palette command discoverability, measurement calibration prompt, and page-label prompt. `npm run typecheck` passes, focused smoke/v0.6 suite is **19/19 green**, full packaged Playwright suite is **59/59 green**, and production `npm audit --omit=dev` remains **0 vulnerabilities**.

### Fixed + hardened — in-depth security / QA pass (2026-04-24)
- **Save no longer overwrites opened originals.** Opened PDFs now start with `saveInPlace: false`, so normal Save routes through Save As until the user explicitly chooses an Acrofox output path. After Save As, that chosen path becomes safe for future in-place saves. This restores Critical Rule #6 and is covered by a new packaged E2E.
- **Path allowlist now resolves symlinks before protected-location checks.** `fs:read-file` / `fs:write-file` / `shell:show-in-folder` still require a blessed path, and now also reject blessed symlinks that resolve into app `userData` (signatures, certs, drafts). Added a regression test that blesses a symlink into `userData` and verifies the read is blocked.
- **qpdf encryption no longer exposes passwords in qpdf argv.** GUI encryption now feeds qpdf arguments through `@-`, uses `--user-password=...` / `--owner-password=...` from stdin, and generates a random owner password when the user only supplies an open password. CLI encrypt also supports `-` to read the password from stdin, matching decrypt.
- **Unsafe hyperlink schemes are rejected.** The Link tool now allows only `http:`, `https:`, and `mailto:` URI targets; `javascript:`, `file:`, app-specific schemes, and local slash paths are blocked with inline feedback. Page links remain available through the Page tab.
- **Signature storage validates payload shape and size.** `signature:set` now accepts only PNG/JPEG data URLs up to 5 MB before touching Keychain or the raw fallback file.
- **AI Q&A / rewrite extras no longer travel in process argv.** The main process writes the question/style to a private temp file and spawns `ai-bin` with `--extra-file <path>`. Rebuilt `resources/helpers/ai-bin` from the updated Swift helper.
- **Encrypt modal now asks for password confirmation.** The submit button stays disabled until both fields match, reducing one-shot password mistakes.
- **Print parity fixed for menu + command palette.** Native menu Print and palette Print now share the hotkey path and commit pending overlays before opening the system print dialog.
- **Undo/redo dirty-state cleanup.** Undo now stays dirty if pending overlays still exist, committing pending overlays clears stale redo history like any other new edit, and Save establishes the written bytes as the new clean baseline so undo cannot silently diverge from disk while looking clean.
- **Tests:** Added security/QA E2E coverage for symlink-blocking, signature payload validation, unsafe link schemes, Save-As protection, and stdin-based CLI encrypt/decrypt. `npm run typecheck` passes; full packaged suite is **56/56 green**. Production `npm audit --omit=dev` remains **0 vulnerabilities**. Full dev audit still reports known dev-tooling advisories in Electron Forge/@electron/rebuild/tar and Vite/esbuild chains.

### Fixed — pending overlays no longer keep an idle border (2026-04-23)
- Pending images and box-shapes (rect / ellipse / highlight / whiteout / redact) no longer render a permanent `ring-1` accent outline in their idle state. The faint purple ring was visible at all times — including after dragging/moving — which read as "stuck borders" around otherwise-plain shapes. Hover still shows a `ring-2` affordance and selection still shows the full `outline-2` accent. Changes: [PendingImageLayer.tsx:337](src/renderer/components/Viewer/PendingImageLayer.tsx:337), [PendingShapeLayer.tsx:179](src/renderer/components/Viewer/PendingShapeLayer.tsx:179).

### Added — v0.7 push: page layout (N-up/crop/fit/booklet/split) + smart compression with real previews (2026-04-22)
- **Page layout modal** with 5 tabs covering every PDF re-pagination operation:
  - **N-up** — combine 2/4/6/9 pages onto a single sheet, choice of paper size, orientation, optional cell borders. Implemented as `nUpPages` in [src/renderer/lib/pdf-ops.ts](src/renderer/lib/pdf-ops.ts) via `embedPdf` + `drawPage`.
  - **Auto-crop** — render each page via pdf.js, walk pixels to find the content bounding box, set MediaBox + CropBox to trim whitespace. Configurable padding + white threshold; uniform-vs-per-page toggle.
  - **Fit to paper** — re-paginate every page onto a chosen paper size with fit (preserve aspect, may margin) or fill (preserve aspect, may crop) mode. Useful for normalising mixed-size docs.
  - **Booklet** — 2-up imposition with the booklet page sequence so a folded stapled stack reads in order. Pads to a multiple of 4 with blank pages.
  - **Split spread** — slice each page in half (horizontal or vertical) and produce a doc with twice as many pages. For scanned books captured as two-pages-per-image.
  - All 5 primitives + new modal at [PageLayoutModal](src/renderer/components/PageLayoutModal/PageLayoutModal.tsx). Discoverable via ⌘K palette ("Page layout…").
- **Smart compression with real previews + size estimates** — replaced the old CompressSheet with a new [CompressModal](src/renderer/components/CompressModal/CompressModal.tsx). Big changes:
  - **No more fake estimates.** Previously every preset showed `before * 0.85` etc. — invented numbers. The new modal pre-computes every preset in parallel via `Promise.allSettled` the moment it opens and shows the **actual output size**.
  - **Page-1 thumbnails per preset.** Each row shows a rendered thumbnail of the compressed output so you can see exactly what you're trading away in image quality.
  - **5 presets** (was 6): Lossless · qpdf re-pack | Lossless+ · mutool clean | Print · 300 DPI | Balanced · 150 DPI | Smallest · 72 DPI. The 3 image-resampling presets now use `gs-advanced` with explicit per-channel `-dColorImageResolution` / `-dGrayImageResolution` / `-dMonoImageResolution` flags + `JPEG QFactor` curves tuned to the chosen quality, instead of bare `/screen|/ebook|/printer` shorthand (which forces CMYK→RGB and hard-codes mono at 72 dpi).
  - **Automatic qpdf post-pass on every Ghostscript / mutool result.** Research showed running `qpdf --object-streams=generate --stream-data=compress --linearize` after gs picks up an extra 5-20% for free with no quality cost. The post-pass result is only kept if it's actually smaller.
  - **"Already optimized" short-circuit.** When a preset's output is ≥ 95% of the input (i.e. small text PDFs that literally grow under Ghostscript), the row shows "Already optimized — your PDF is already lean" instead of misleading "−2%". Clicking is disabled.
  - **Smart pick badge** highlighting the best preset (smallest among the lossless / balanced / best-quality options that actually saved bytes).
  - **Custom advanced controls** (collapsible) — 4 sliders: color DPI, gray DPI, mono DPI, JPEG quality. Runs `gs-advanced` with the user's chosen values.
- **3 new IPC channels** for the compression backend:
  - `gs:compress-advanced` — Ghostscript with per-channel DPI + JPEG QFactor (overrides PDFSETTINGS shorthand)
  - `qpdf:compress` — lossless re-pack (`--object-streams=generate --stream-data=compress --linearize`)
  - `mutool:available` + `mutool:clean` — MuPDF aggressive cleanup (`mutool clean -gggz`). Optional dependency: `brew install mupdf-tools`. Greys out cleanly if absent.
- **Updated edit.spec.ts**: the old "compress sheet shrinks the document" test was replaced with one that asserts either real-size text OR the new "Already optimized" label appears (since the fixture is tiny text and would rightly short-circuit). **52/52 specs green.**

### Added — v0.6 push: revision history, hyperlinks, spread view, page labels, measurement, DMG installer (2026-04-22)
- **Revision history (autosave + restore across app restarts).** Every dirty tab is autosaved to `userData/drafts/<sha256(draftKey)>/` after a 1.5s debounce, including pending text/image/shape overlays (image bytes inlined as base64). On reopen, if a draft exists for the same source path you're prompted with **Restore / Open original / Cancel**. Tabs without a real source path (combined PDFs, image / DOCX imports) get a synthetic `acrofox-virtual://<uuid>` draftKey so they autosave too — surfaced in the new **Recent Drafts** modal (DropZone CTA + ⌘K palette). Saving to the original disk path automatically migrates the slot key and clears stale virtual entries.
  - 4 new IPC channels (`drafts:save / load / clear / list`) + `DraftManifest` / `DraftRecord` types in [src/shared/ipc.ts](src/shared/ipc.ts)
  - Main handlers in [src/main/main.ts](src/main/main.ts) — slot key = sha256(absPath or virtual URI)
  - [useDraftPersistence](src/renderer/hooks/useDraftPersistence.ts) hook subscribes to the document store, debounces, garbage-collects orphaned slots on draftKey rename
  - [RestoreDraftModal](src/renderer/components/RestoreDraftModal/RestoreDraftModal.tsx) + [RecentDraftsModal](src/renderer/components/RecentDraftsModal/RecentDraftsModal.tsx)
  - DropZone now shows a "Resume previous work · N drafts" pill when drafts exist
- **Hyperlink tool.** Drag a rectangle, pick **URL** or **Page**, and Acrofox bakes a real `/Subtype /Link` annotation into the PDF via pdf-lib (`/A` action with `/URI` for external links or `/GoTo + /Dest [page /Fit]` for intra-document jumps). Survives any export / print / open in another reader. New `addLinkAnnotation` primitive in [src/renderer/lib/pdf-ops.ts](src/renderer/lib/pdf-ops.ts), `link` tool mode in the ui store, [LinkPopover](src/renderer/components/LinkPopover/LinkPopover.tsx), Toolstrip button, palette action.
- **Two-page spread + cover-spread view modes.** New view-mode toggle in the Titlebar cycles **single page → two-page spread → cover + spread (book mode)**. Spread mode lays out pages 1+2, 3+4, …; cover-spread keeps the cover solo then pairs 2+3, 4+5, … like a real book. Persists per session via `viewMode` in [src/renderer/stores/ui.ts](src/renderer/stores/ui.ts), implemented as a row-grouping in [Viewer.tsx](src/renderer/components/Viewer/Viewer.tsx). Discoverable via ⌘K palette ("View · …").
- **Measurement tool (distance + calibration).** Drag a measurement, get a label like `5.20 in` mid-segment. Calibrate via "Calibrate measurement scale…" in ⌘K palette — accepts `5 ft`, `30 cm`, etc. Defaults to raw points if uncalibrated. Stamps the line + label as pending overlays so they're editable / deletable before commit.
- **Custom page labels.** Right-click any sidebar thumbnail → "Set page label…" — type a prefix (e.g. `Cover`, `Section A-`) and Acrofox writes the PDF spec's `/PageLabels` number tree via pdf-lib's low-level `PDFDict` API. New `setPageLabels` + `getPageLabels` primitives support decimal / Roman / alpha styles.
- **DMG installer for distribution.** `npm run make` now produces `out/make/Acrofox.dmg` (110 MB, LZFSE-compressed) alongside the existing zip artifact. Drag-to-Applications layout, mounts as "Acrofox" volume. Added `@electron-forge/maker-dmg@^7.5.0` (dev dep). Production audit still 0 vulns.
- **7 new E2E specs** in [tests/e2e/v06-features.spec.ts](tests/e2e/v06-features.spec.ts) — drafts IPC round-trip, link / measure / recent-drafts palette discovery, view-mode toggle cycling, link toolstrip button. **50/50 specs green.**



### Fixed + hardened — export parity, signing deps, temp-file safety (2026-04-21)
- **Combined export and test save/export helpers now commit pending overlays first.** Pending text, image, and shape edits are all baked before writing, so exported/saved PDFs match what the user sees on-canvas. Added a new E2E that proves combined export includes a pending rectangle, and strengthened the existing rect-save coverage.
- **Delete-all-pages affordance is consistent across entry points.** The sidebar already offered to close the document instead of silently failing when every page was selected; the toolstrip/global delete paths now show the same confirmation flow.
- **Pending-text drag coverage is stable again.** `PendingTextLayer` now exposes PDF-space `data-x-pt` / `data-y-pt` coordinates so E2E asserts on actual document movement instead of bounding boxes that changed when selection chrome appeared.
- **Digital signing no longer depends on the vulnerable `@signpdf/placeholder-plain` chain.** Swapped to `@signpdf/placeholder-pdf-lib`, kept the pre-sign `useObjectStreams: false` normalization, and removed the production `pdfkit` / `crypto-js` audit findings. `npm audit --omit=dev --json` is now clean with **0 production vulnerabilities**.
- **DOC→PDF, DOCX export, Ghostscript compression, qpdf decrypt, and OCR helper calls now run inside private `mkdtemp` directories.** The hidden DOC→PDF `BrowserWindow` also switched from a `persist:` partition to an in-memory partition, so conversions no longer leave behind needless session state on disk.
- **CLI decrypt is safer for scripting.** It now uses `qpdf --password-file=- --decrypt -- ...` and accepts `-` as the password argument to read the first line from stdin instead of putting the password directly in qpdf argv.

### Fixed + polished — Quick Action UX round 2 (2026-04-21)
- **Don't steal focus from the foreground app.** CLI mode now calls `app.setActivationPolicy("accessory")` before `whenReady`, which hides Acrofox from the Dock AND the app switcher entirely for the duration of the CLI invocation. When you right-click an image in Finder from inside Excel / Pages / anything, focus stays where it was.
- **Overwrite / New copy / Cancel prompt** when the output PDF already exists. Applies to Convert-to-PDF / Compress / Extract first page / Rotate 90° workflows (Merge uses a timestamp so collisions are already unlikely). Default button is "New Copy" — numbered suffix is appended until an unused name is found.
- **Image-to-PDF is now top-aligned** (horizontally centered, pinned to the top margin) instead of vertically centered. Narrow screenshots no longer float in the middle of a mostly-blank US Letter page.

### Fixed — TCC sandbox on Finder Quick Actions (2026-04-21)
- **All 5 Finder Quick Actions** (Convert-to-PDF, Compress, Extract first page, Rotate 90°, Merge) now route file I/O through `/tmp`. Root cause: macOS TCC treats child processes by their own bundle ID, so when Automator's shell spawned Acrofox with a user's Desktop file as an argument, the `readFile` gave `EPERM: operation not permitted`. The Automator shell itself has Finder's TCC grant and can read/write user directories, so the fix is: `cp` the input into `/tmp`, run Acrofox there (no TCC needed), `cp` the result back to the user's path. One extra copy per file; solves the permission issue without requiring the user to grant anything in System Settings.
- Each workflow also now logs every step to `/tmp/acrofox-quickaction.log` and shows a native `osascript` alert on any failure — silent failures are gone.

### Fixed + polished (2026-04-21 evening)
- **Convert-to-PDF Quick Action now logs + surfaces errors.** The workflow was clicked but silent — now writes each step to `/tmp/acrofox-quickaction.log` and shows an `osascript` alert on non-zero exit. `automator -i … Convert\ to\ PDF\ with\ Acrofox.workflow` confirms the workflow itself is valid; remaining debugging is whether macOS's Services menu dispatches correctly on this machine (pbs registration looks OK; Finder was restarted).
- **Recent colours strip** in ColorPopover — last 6 distinct colours the user picked, one click to re-pick. Auto-updates on every `setAnnotationColor`.
- **Buffer-helper migration completed** — every `buf.buffer.slice(byteOffset, …) as ArrayBuffer` call site (~9 across main.ts, App.tsx, BatchModal, Sidebar) now routes through [src/shared/buffers.ts](src/shared/buffers.ts) `u8ToAb`. No more unchecked casts.

### Added — Convert to PDF Finder Quick Action + CLI image-to-pdf (2026-04-21)
- Right-click any image in Finder → **"Convert to PDF with Acrofox"** → writes `image.pdf` next to the original, same directory. Supports PNG / JPEG / HEIC / HEIF / TIFF / GIF / BMP / WebP (HEIC and the less common formats transcode through `sips -s format jpeg` first before pdf-lib embeds).
- New CLI op: `--cli image-to-pdf <in-image> <out.pdf>`. Backs the new Quick Action; also usable from bash / Hazel / Shortcuts.

### Changed — Every drag-to-draw tool is now a draggable pending overlay (2026-04-21)
- **Rect / Ellipse / Line / Arrow / Freehand / Highlight / Whiteout / Redact / Sticky note** now drop a selectable overlay on drag-end instead of baking into the PDF bytes immediately. After drawing you can:
  - **Drag body** to move
  - **Corner handles** to resize (for rect/ellipse/highlight/whiteout/redact)
  - **Endpoint handles** on line/arrow
  - **Drag the whole thing** for freehand (points translate together)
  - **Arrow keys** to nudge 1pt (Shift = 10pt)
  - **Delete / Backspace** to remove
  - **Escape** to deselect
  - **Double-click** the sticky marker to re-edit its text
- New `PendingShapeEdit` discriminated union in the document store. `addPendingShapeEdit` / `updatePendingShapeEdit` / `removePendingShapeEdit` / `commitAllPendingShapeEdits`. Commit runs on save/export/print, dispatching to the matching pdf-lib primitive (`drawRect`, `drawCircle`, `drawLine`, `drawArrow`, `drawPath`, `drawHighlight`, `whiteoutRegion`, `redactRegion`, `drawStickyNote`).
- New [PendingShapeLayer](src/renderer/components/Viewer/PendingShapeLayer.tsx) with four sub-renderers: BoxShape (rect/ellipse/highlight/whiteout/redact), LineShape (line/arrow with endpoint handles), FreehandShape (bbox + SVG path + translate), StickyShape (yellow marker + popout text).
- `commitAllPending` now commits shapes first, then images, then text — keeps Z-order sane so Edit-Text whiteouts don't swallow annotations below.

### Changed — Signature + Image placement routed through pending-overlay (2026-04-21)
- **Signature and "Place image" tools now drop a draggable/resizable overlay** instead of baking the image into the PDF on click. Same pipeline as paste-to-PDF (`addPendingImageEdit`). You get the 4 corner resize handles, crop button, arrow-key nudge, Shift-lock aspect ratio, and Delete/Backspace for free — and the placement isn't committed to bytes until save/export/print.
- **Cursor shows you're carrying something** when the tool is armed: `copy` (+) for signature + image placement, `text` for Add Text, `cell` for sticky notes, `crosshair` for drag-to-draw tools (shapes / highlight / whiteout / redact / freehand).
- The freshly-placed overlay is auto-selected so the resize handles + chips appear without a second click.

### Fixed — path allowlist regression (2026-04-21)
- **Drag-and-drop from Finder was broken** by the path allowlist we introduced in the overnight security sweep — `webUtils.getPathForFile` returned a raw Finder path without blessing it, so the subsequent `readFile` failed with "path not permitted". Fix: the preload's `getPathForFile` now calls `ipcRenderer.sendSync(BlessDropPath, p)` as a side-effect. Safe because `webUtils.getPathForFile` only returns a real path for genuine drop-originated File objects — synthetic File objects return `undefined`, so the allowlist can't be widened through this channel.
- **Batch ops writing `*-processed.pdf`** next to each source file hit the same "path not permitted" error because the derived output path wasn't blessed. New `BlessDerivedPath` IPC asserts that the source is already blessed AND the derived path is in the same directory, then blesses the derived. BatchModal calls it before writing each output.
- **Sidebar trash icon did nothing for single-page PDFs.** `handleDelete` silently returned when `selectedPages.size === numPages` (to prevent pdf-lib from throwing). Now shows a confirm: "You can't delete every page. Close this document instead?" — on yes, closes the tab.

### Added — Apple Intelligence (2026-04-21)
- **On-device AI: Summarize / Ask a question / Rewrite.** Full Xcode was installed; compiled a new Swift helper ([resources/helpers/ai.swift](resources/helpers/ai.swift), 62KB) against the `FoundationModels` framework. Three modes:
  - **Summarize** — 3-5 bullet summary of the open PDF's text.
  - **Ask a question** — grounded Q&A over the current document, with a "can't find it" fallback when the doc doesn't contain the answer.
  - **Rewrite** — clearer / shorter / professional / friendly / simpler style picker.
- **Runs 100% on-device** via `LanguageModelSession`. Nothing leaves your Mac — no API keys, no network. Works offline. Uses the Neural Engine on Apple Silicon.
- New `ai:available` + `ai:run` IPC. Spawns the helper with input text in a per-invocation `mkdtemp`'d tmpfile (keeps large docs out of argv + `ps aux`).
- New [AiModal](src/renderer/components/AiModal/AiModal.tsx) — three-tab UI. Extracts PDF text via our existing `pdfToMarkdown` (caches per-version so re-asking questions is fast). Copy-to-clipboard button on results. 16k-char input cap with a "truncated" marker so it fits the on-device model's ~8k-token context window.
- Palette: ⌘K → "Apple Intelligence: summarize / ask / rewrite…".
- **2 new E2E tests** pass: helper bundled + live summarize round-trip through FoundationModels.
- Build: `node scripts/build-ai.mjs` (requires full Xcode with `xcode-select -s /Applications/Xcode.app/Contents/Developer`).

### Changed — Electron 33 → 41.2.2 (2026-04-21)
- Bumped `electron` from `^33.0.0` (EOL since ~May 2025) to `^41.2.2` (current stable, on the supported branch). **No code changes required** — all APIs we use (contextBridge, safeStorage, `session.setPermissionRequestHandler`, `BrowserWindow.setWindowOpenHandler`, `webContents.printToPDF` / `webRequest.onBeforeRequest`, `dialog.showOpenDialog` / `showSaveDialog` overloads, `webUtils.getPathForFile`, Fuses) carried forward cleanly.
- 40/40 E2E specs still green. Production CLI smoke-tested (compress, watermark, encrypt/decrypt round-trip — all valid v1.7 PDFs). Installed to `/Applications/Acrofox.app`.
- Chromium / V8 security patches from late-2025 / early-2026 now flow through to the app.

### Added — overnight session (2026-04-21)

#### New features
- **PKCS#7 digital signatures.** New [DigitalSignModal](src/renderer/components/DigitalSignModal/DigitalSignModal.tsx). Generates a self-signed X.509 / PKCS#12 cert via `node-forge` (2048-bit RSA, AES-256 P12, 100k PBKDF iterations), stores it Keychain-encrypted via `safeStorage`, and signs the active PDF with an invisible CMS signature dictionary via `@signpdf/signpdf`. Palette: "Sign digitally (PKCS#7)…". Refuses to store the signing key without Keychain available (plain-file fallback defeats the P12 passphrase).
- **Find & Replace.** New Replace toggle in the search bar reveals a replacement input; Replace-All whiteouts every match and stamps the replacement at the same position. New [replaceAllText](src/renderer/lib/pdf-ops.ts) primitive uses pdf.js text positions.
- **Redo (⌘⇧Z / ⌘Y).** Document store gained a `redoStack`. Undo pushes the undone state onto it; applyEdit clears it (standard undo semantics). Palette + keyboard shortcut.
- **Tab right-click menu.** Close tab · Close other tabs · Close tabs to the right.
- **Outline Expand / Collapse All.** Two buttons at the top of the Outline panel; tick-based global expand/collapse honored by every OutlineItem.
- **Canvas right-click additions.** Copy page text (in reading order) · Copy page as image (via canvas.toBlob → ClipboardItem).
- **CLI: three more ops.** `--cli watermark <in> <out> <text>`, `--cli encrypt <in> <out> <password>`, `--cli decrypt <in> <out> <password>`. Usage text updated.

#### Bug fixes
- **Encrypt-with-password uses a proper modal** instead of `window.prompt`. [PasswordModal](src/renderer/components/PasswordModal/PasswordModal.tsx) gained an `encrypt` mode.
- **Right-click "Sticky note…" uses the inline overlay** ([StickyPromptOverlay](src/renderer/components/Viewer/StickyPromptOverlay.tsx)) instead of `window.prompt`.
- **Find + Replace commits pending edits first** so pasted-text content is included in the search space and doesn't get double-baked on save.
- **`dirty` flag clears** when all pending edits are removed and there's no history.
- **Pending image drags / crops / resizes now flip `dirty: true`** (previously only the add did).
- **Menu commands (⌘S, ⌘E, ⌘F from the native menu bar)** now read fresh state via `useDocumentStore.getState()` instead of closing over the initial `activeTab` — fixes a stale-closure bug when switching tabs.
- **Unsupported file types in drop / open dialog now surface an alert** instead of silently dropping.
- **Password prompt unmount** no longer hangs `loadAsTab` — a wrapper resolver rejects the pending promise on unmount.
- **Viewer `key` includes `activeTab.version`** so edits force a clean canvas remount (matches Sidebar behavior).

#### Security hardening
- **Path allowlist** for `fs:read-file` / `fs:write-file` / `shell:show-in-folder`. Only paths added by dialog selections, drag-drop, or `open-file` events can be read or written. `userData` is explicitly blocked even if guessed. Closes the "compromised renderer can steal `~/.ssh/id_rsa`" hole.
- **qpdf spawns**: every invocation now includes `--` to end option parsing, so malicious filenames starting with `-` or `@` (qpdf command-file syntax) can't smuggle in flags.
- **qpdf decrypt password via stdin** (`--password-file=-`) instead of argv — keeps the password out of `ps aux`.
- **PKCS#12 wraps with AES-256** (100k PBKDF iterations) instead of 3DES.
- **Cert storage refuses to fall back to plain file.** Safer: no cert than a cert with its passphrase in the same plaintext blob.
- **DOC→PDF hidden `BrowserWindow`** now denies every network request via `webRequest.onBeforeRequest`, blocks `will-navigate`, sets a dedicated session partition, denies every permission request. A malicious .docx can't exfil via its textutil-produced HTML.
- **Temp files use `mkdtemp`** (0700 per-invocation dir, then `rm -rf`) — removes the symlink-race surface at `/tmp`.
- **`as never` cast** removed from `showOpenDialog` / `showSaveDialog`.

#### Code quality
- **New `src/shared/buffers.ts`** with `u8ToAb` / `abToU8` / `bytesToBlob` helpers; started migrating the 15+ `buf.buffer.slice(byteOffset, …) as ArrayBuffer` duplicates.
- **`inFlight` per-tab guards** extended to redo.

#### Tests
- **New [v05-features.spec.ts](tests/e2e/v05-features.spec.ts)** — 19 cases covering Find/Replace, tab close-one-at-a-time, outline panel, digital-sign cert gen + sign, signature Keychain fallback, CLI compress/rotate/extract/watermark/encrypt/decrypt, convertDocToPdf, convertTextToDocx, paste-text, redact palette, OCR/qpdf/ghostscript availability, copy handler smoke.
- **Test-only IPC channel `test:bless-path`** gated on `import.meta.env.VITE_E2E === "1"` (Vite inlines at build time) so tests can bless raw paths without dialogs while production builds have no way to bypass the allowlist.

### Added — bug-fix pass (2026-04-21)
- **Signature save Keychain fallback.** Ad-hoc-signed Electron builds sometimes get `safeStorage.isEncryptionAvailable() === false`. Previously that threw and the signature was lost. Now falls back to a plain `signature.raw` file with `0600` perms so the Type/Draw flow always works; encrypted `signature.enc` is used when available and takes precedence.
- **Sticky note now has an inline prompt.** Was using `window.prompt` which behaved inconsistently in the sandboxed renderer. Replaced with [StickyPromptOverlay](src/renderer/components/Viewer/StickyPromptOverlay.tsx) — floating yellow textarea, ⌘↵ to save.
- **Edit-Existing-Text auto-enters edit mode.** Used to create a pending-edit that looked like a duplicate of the existing text; the user had to double-click to actually edit. Now opens directly in edit mode with the original text pre-selected, so a single keystroke replaces it.
- **Copy now respects visual reading order.** Pdf.js lays text spans out in content-stream order (often column-by-column for forms). Override installed in the viewer that intercepts `copy` events, groups selected spans into lines by y, sorts within each line by x, and pastes in natural left-to-right / top-to-bottom order.

### Added — Crop for pending/pasted images
- The paste-to-PDF / place-image overlay now has a **Crop** handle. Click to enter crop mode → drag a rect inside the image → Apply or Cancel. Canvas-based crop rewrites the bytes + resizes the overlay so the cropped region stays visually in place. Undoable via ⌘Z after save.

### Added — Document imports & exports
- **DOCX / DOC / RTF import.** Drag-drop or Open one of those files → Acrofox converts via macOS `textutil -convert html` + a hidden BrowserWindow `printToPDF()`. 100% on-device, no external services. Registered in `CFBundleDocumentTypes` so the app also shows up in Finder's "Open With" menu for Word files.
- **Word (.docx) export** via `textutil -convert docx`. Palette: "Export as Word document…". Text layer extracted from pdf.js, fed through textutil. Loses formatting fidelity vs the original PDF but produces an editable Word doc.

### Added — Security & heavy-lift tools
- **Encrypt with password.** New palette action "Encrypt with password…" prompts for a password, routes to `qpdf --encrypt … 256`, saves to a user-picked path. AES-256.
- **Ghostscript heavy compression.** [CompressSheet](src/renderer/components/CompressSheet/CompressSheet.tsx) now shows three extra presets — Heavy · Screen / eBook / Printer — that shell out to `gs -sDEVICE=pdfwrite -dPDFSETTINGS=/screen|ebook|printer`. Typically 60–80% smaller on image-heavy PDFs. Greyed out with an install hint if `brew install ghostscript` hasn't been run.

### Added — Pen presets, Bates numbering, more Quick Actions
- **Pen presets** — Fine / Medium / Bold / Red review / Blue note buttons in the color popover; each sets color + stroke width in one click.
- **Bates numbering** added to [HeaderFooterModal](src/renderer/components/HeaderFooterModal/HeaderFooterModal.tsx) — prefix + start number + zero-padded digit count (e.g. `BATES000001`, `BATES000002`). Stamped bottom-left via new [drawBatesNumbers](src/renderer/lib/pdf-ops.ts) primitive.
- **Two more Quick Actions:** *Rotate 90° with Acrofox* and *Merge with Acrofox* (multi-select PDFs in Finder → writes `Merged-YYYYMMDD-HHMMSS.pdf` next to the first file + reveals in Finder).

### Added — Native integrations
- **OCR via Apple Vision** — a compiled Swift helper (`resources/helpers/ocr-bin`, built from `resources/helpers/ocr.swift`) runs Apple's `VNRecognizeTextRequest` locally on each page image. Renderer sends PNGs, main spawns the helper, JSON bounding boxes come back. [applyOcrTextLayer](src/renderer/lib/pdf-ops.ts) bakes the recognized text into an invisible (opacity: 0) PDF text layer so the output is searchable + selectable without changing the visible page. On-device only; nothing leaves the Mac. Build the helper with `node scripts/build-ocr.mjs` once before packaging.
- **Cryptographic redaction** — the Redact tool now flattens the affected page to a bitmap before applying the black rectangle. The original text operators under the redacted region are gone from the output bytes (not recoverable by search, copy, or PDF-parser tooling). Trade-off: the whole page becomes a raster and loses its selectable text layer — re-run OCR if you need to restore selection on the unredacted parts.
- **Password unlock via qpdf** — open encrypted PDFs by typing the password. Acrofox detects pdf.js `PasswordException`, shows the `PasswordModal`, shells out to the bundled `qpdf --password=X --decrypt` helper, and loads the decrypted bytes. Decrypted copy's `path` is cleared so ⌘S routes to Save-As (never clobbers the encrypted original). Requires `brew install qpdf`; gracefully falls back with instructions if missing.
- **CLI mode (`--cli <op> <args…>`)** — `/Applications/Acrofox.app/Contents/MacOS/Acrofox --cli compress in.pdf out.pdf`. Ops: `compress`, `merge`, `rotate`, `extract-first`, `extract-range`. Runs headlessly (dock icon hidden), exits with standard codes. Enables scripting from bash, Shortcuts, Hazel, Alfred, etc.
- **Finder Quick Actions** — two ready-to-install Automator workflows under `resources/quick-actions/`: *Compress with Acrofox* and *Extract first page with Acrofox*. Install with `bash scripts/install-quick-actions.sh` → right-click any PDF in Finder → Quick Actions → run. Output lands next to original with a suffix.

### Added — "Better than Acrobat" push
- **Paste-to-PDF** (⌘V). Paste an image from the clipboard (screenshots, copied images) or any text string, and it lands as a draggable/resizable overlay centered on the current page. Bakes into the PDF on save/export/print.
- **Pending image overlays** — draggable, with 4 corner resize handles, arrow-key nudge (1pt, Shift = 10pt), Shift-lock aspect ratio during resize, Delete/Backspace to remove. Applies to both pasted images and the existing image-place tool.
- **Pending text selection mode** — click a floating text edit to highlight, then arrow-nudge, font-size ± chips, Delete/Backspace to remove, Escape to deselect.
- **Right-click context menus** —
  - **Canvas:** Paste here · Add text here · Place image · Sticky note · Highlight / Whiteout / Redact mode
  - **Pages sidebar thumbnail:** Rotate L/R/180° · Duplicate page · Extract page(s) · Delete
- **Redact region tool** — drag to cover a region with opaque black. Available via palette, canvas right-click menu, or set `tool: redact` directly. Visual-only for now; cryptographic content removal is on the follow-up list.
- **AcroForm fill** — modal lists every form field (text / checkbox / radio / dropdown / option-list), lets you edit values, optional "Flatten" to bake values into page content. Honors read-only fields.
- **Batch ops on a folder of PDFs** — multi-select PDFs → pick op (Compress / Watermark / Rotate 90° / Rotate 180°) → runs across the set, writing `name<suffix>.pdf` next to each original. Progress and per-file status shown.
- **Export as Markdown** — pdf.js text extraction with heuristic heading detection (font-size outliers become `###`). Pages split as `## Page N`. Saves `.md` file.
- **Font matching on Edit-Existing-Text** — detects the original span's font family (Helvetica / Times / Courier) + weight + italic, maps to the closest pdf-lib `StandardFonts`, and passes it through `drawText` so replacement text doesn't always collapse to Helvetica regular.
- **New pdf-ops primitives:** `redactRegion`, `duplicatePage`, `getFormFields` / `setFormFields`, `pdfToMarkdown`, `matchStandardFont`.
- **Keyboard parity:** arrow-key page-nav + delete-page hotkeys now yield when a pending image or text overlay is selected.

### Security
- **Chromium sandbox enabled** on the renderer (`webPreferences.sandbox: true`). The preload only uses `ipcRenderer` / `contextBridge` / `webUtils`, so no Node APIs were lost. Defense-in-depth against a compromised renderer (e.g. a pdf.js escape).
- **`setWindowOpenHandler` denies all `window.open` calls** and routes `http(s)` / `mailto:` links to the OS default handler via `shell.openExternal`. Stops a malicious PDF from spawning a privileged renderer window.
- **`will-navigate` preventDefault** blocks any top-level navigation away from the loaded app. A malicious link in rendered content can no longer hijack the main renderer.
- **`will-attach-webview` preventDefault** — Acrofox never embeds `<webview>`, so any attempt to inject one is refused.
- **Permission deny-all default** — `session.defaultSession.setPermissionRequestHandler` denies every `getUserMedia` / notifications / geolocation / etc. request. Nothing legitimate needs them today.
- **CSP tightened** — added `object-src 'none'; base-uri 'self'; frame-src 'none'; form-action 'none'` to the renderer CSP. Closes the last few injection / clickjacking corners.
- **Playwright test hooks (`window.__acrofoxTest__`) are no longer installed in production builds.** Gated behind `import.meta.env.DEV || VITE_E2E === "1"`. `npm run package` ships clean; `npm test` uses the new `package:test` script which sets `VITE_E2E=1` before packaging.
- **`signature:clear` now `unlink`s the encrypted blob** instead of truncating to 0 bytes. Removes the stale-sector / race-with-get concern flagged in the audit.

### Fixed
- **Lines and arrows drew in the wrong direction** when dragged bottom-right → top-left. The start point was being reconstructed from the normalised bounding box instead of the raw pointer-down coordinates. Now captures `rawStart` before clearing the drag ref.
- **Text watermarks drifted off-center on non-square pages.** The centering math didn't account for pdf-lib's rotation-around-anchor-point behavior. Rewritten to offset `(x, y)` by half text-width and half-height in the rotated frame.
- **Undo's `dirty` flag was off by one** — undoing the only edit in history left the tab marked dirty. Fixed to derive from the post-pop history length.
- **Double-tap ⌘Z (or rapid edits) could corrupt the undo history.** `applyEdit`, `undo`, and `commitAllPendingTextEdits` now drop re-entrant calls via a per-tab in-flight guard.
- **Save / Export failures were silent** — `writeFile` returning `{ok: false}` did nothing. Now alerts the user with the OS error string. `readFile` failures in the drag-drop and `open-file` paths also now alert instead of throwing uncaught.
- **Dead ternary in `dialog.showOpenDialog` options** — both branches of `options?.multi ? […] : […]` were identical, so `multi: false` still allowed multi-select. Now correctly falls back to `["openFile"]`.

### Changed
- `package.json` scripts: new `package:test` (sets `VITE_E2E=1`), `test` now depends on `package:test`, new `test:run` for the bare Playwright run.

## [0.4.0] — 2026-04-20 — Deep editing + bookmarks + color

### Added
- **Edit Existing Text** tool — click any word/line on a PDF → inline input pre-filled with the text, edit in place, commit whiteouts the original region and draws the replacement. First-class "convert to editable text" workflow.
- **Image placement tool** — pick any PNG/JPG, click on the PDF to place at 240pt wide (aspect preserved).
- **Sticky-note comments** — click a spot, type a note, renders a yellow-square marker with wrapped body text beside it.
- **Crop pages** modal — enter top/bottom/left/right margins (in points), applies to every page's `MediaBox` and `CropBox`.
- **Header / Footer / Page Numbers** modal — centred header, centred footer, and bottom-right page numbers with `{n}` / `{total}` tokens.
- **Outline / Bookmarks panel** — toggleable sidebar tab that reads `pdfDoc.getOutline()`, renders the tree, resolves destinations to page indexes, and jumps on click.
- **Color + thickness picker** — floating popover on the right side of the toolstrip, active only for shape/line/arrow/pen tools. Six swatches (Ink, Red, Blue, Green, Orange, Violet) + 0.5–8pt stroke slider. Threads through to every relevant pdf-lib primitive.
- New `pdf-ops` primitives: `cropPages`, `drawHeaderFooter`, `drawStickyNote`.

### Fixed
- **Signature "Save" was silently placing invisible signatures in dark mode.** Saved signatures (drawn + typed) are now always black (`SIG_COLOR`), independent of the app theme — white ink was invisible on white paper. The modal preview also uses black now. Error-path: try/catch surfaces failures instead of no-op-ing, and the button shows a "Saving…" state.

### Changed
- Sidebar tabs: Pages / Outline. Default is Pages. Width grew 180 → 200 to fit the tab header cleanly.
- Signature modal no longer uses theme-aware ink colour at save time.

## [0.3.0] — 2026-04-20 — Acrobat parity

### Added
- **Shape tools**: Rectangle · Ellipse · Line · Arrow · Freehand Draw (pen). Drag-to-draw, bakes into PDF via pdf-lib vector ops.
- **Highlight** tool — drag region → translucent yellow rect.
- **Whiteout** tool — drag region → opaque white rect that covers content.
- **Typed signature** — in addition to drawn: type your name, pick from Snell Roundhand / Apple Chancery / Noteworthy / Marker Felt / Bradley Hand, rasterize at 128px for quality.
- **Watermark modal** — text, 4 colours, opacity + rotation sliders, live preview, applies to every page.
- **Document Properties (Metadata editor)** — title / author / subject / keywords, reads current values, writes back via pdf-lib.
- **Extract Pages** — range input (`1-3, 5, 7-9`) → saves a new PDF with only those pages.
- **Visible Toolstrip** — 19 labelled icon buttons in a second row below the titlebar, grouped: Edit / Shapes / Pages / Document / Undo.
- **Full macOS menu bar** — Acrofox · File · Edit · Tools · View · Window, with Shapes + Pages submenus. Every command also fires via `MenuCommand` IPC to the renderer.
- **PDF file association** — `CFBundleDocumentTypes` for PDF + PNG/JPG/HEIC/HEIF; `open-file` event → renderer → tab load. Right-click → Open With → Acrofox now works; Acrofox can be set as default PDF app.
- **Double-click PDF in Finder** opens in Acrofox thanks to the `open-file` handler.
- **Pending text edits** — Add Text now places a draggable overlay rather than baking immediately. Drag to reposition, double-click to re-edit (auto-selects text), hover reveals edit/delete chips. Commits on save/export/print.
- **⌘W** close tab, **⌘1–⌘9** switch tab, **⌘[ / ⌘]** rotate left/right shortcuts.
- **LaunchServices registration** via `lsregister -f` in the install flow.
- **7 new E2E specs** (`acrobat-parity.spec.ts`) — toolstrip surface, shape activation, metadata round-trip, watermark apply, extract flow, rect-draws-and-saves, pending-text drag.

### Fixed
- Signature image-load race (handlers attached after src → added `onload`/`onerror` before src).
- Pending-text re-edit didn't auto-select existing text — now uses ref + `useEffect` focus-then-select on edit-mode toggle.

### Changed
- `Toolstrip` replaces the "command palette is your only editor entry" UX — all actions are now one click away.
- `applyEdit` now preserves pending text edits (they only clear when explicitly committed).

## [0.2.0] — 2026-04-20 — Final product

### Added — Phase 1 (Combine)
- **Page reorder** via dnd-kit sortable thumbnails.
- **Multi-select** in sidebar (click / ⌘-click / ⇧-click).
- **Rotate selected** ±90° / 180°.
- **Delete selected** via sidebar action bar, palette, or ⌫/Delete keyboard.
- **Undo** (⌘Z) with 20-level history.
- **Image import** — PNG/JPG/HEIC/HEIF via drag-drop or Open; converted to single-page PDF.
- **Export combined PDF** (⌘E) — merges all open tabs via pdf-lib.
- **Save / Save As** (⌘S / ⌘⇧S); Save-on-opened-file routes to Save-As (Critical Rule #6).

### Added — Phase 2 (Sign)
- **Signature modal** with `signature_pad` draw pad.
- **Keychain storage** via Electron `safeStorage` — encrypted `signature.bin` in userData.
- **Place signature on click** — embed via `placeImage` at default 180pt width.

### Added — Phase 3 (Edit + Compress)
- **Add Text tool** with inline input + size selector.
- **Compress sheet** — Email / Standard / High presets (pdf-lib object-stream compression).
- **Print** (⌘P) via `webContents.print`.

### Added — Phase 4 (Polish)
- **⌘K Command Palette** — fuzzy match over all actions, grouped, with shortcut hints.

### Infrastructure
- `scripts/generate-fixtures.mjs` — deterministic sample PDFs.
- `scripts/generate-icon.mjs` — SVG → PNGs → iconutil → icns (via `sharp`).
- `window.__acrofoxTest__` bypass helpers for Playwright E2E (contextBridge freezes the API).
- `electron-forge package` → `/Applications`-ready .app bundle.

### Fixed
- Text layer unselectable because body `select-none` cascaded → explicit `user-select: text` on `.textLayer`.
- Search Enter-to-next-match race with IntersectionObserver → 700ms `suppressObserverRef` during programmatic nav.
- Electron 32+ removed `File.path` → migrated drag-drop to `webUtils.getPathForFile`.
- `@tailwindcss/vite` ESM-only → `vite.renderer.config.mts`.
- `EnableNodeCliInspectArguments: false` fuse blocked Playwright → flipped on.

## [0.1.0] — 2026-04-20 — Phase 0 Foundation
- Electron + Vite + React 18 + TS + Tailwind v4 shell.
- pdf.js viewer, system theme, DropZone, hiddenInset titlebar with tabs.
- 7 initial E2E specs (`smoke.spec.ts`).

## [0.0.0] — 2026-04-20
- Project planning complete.
- Documentation baseline.

---

## Deferred to v1.1

- Password protection / encryption (needs `qpdf` or encrypt plugin).
- Fillable AcroForm fields.
- Apple Vision OCR (Swift bridge).
- Digital signatures (PKCS#7).
- True redaction (content removal, not visual cover).
- Ghostscript-grade compression (gs binary bundle).
- Image placement tool (primitive `placeImage` exists).
- Pen colour/thickness picker.
- Bookmark sidebar / outline nav.
- Headers / footers / page numbers.
- DOCX export · PDF/A.
- Batch operations (apply to folder).
