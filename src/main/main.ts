import { app, BrowserWindow, Menu, nativeTheme, ipcMain, dialog, shell, safeStorage, session } from "electron";
import { readFile, stat, writeFile, unlink, mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync, appendFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { basename } from "node:path";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import {
  IpcChannel,
  type AppTheme,
  type DigitalCertInfo,
  type DraftManifest,
  type DraftRecord,
  type MenuCommand,
  type OcrBox,
  type OpenFileDialogOptions,
  type OpenedFile,
  type SaveFileDialogOptions,
  type WriteFileResult,
} from "../shared/ipc";
import { u8ToAb } from "../shared/buffers";
import forge from "node-forge";
import { SignPdf } from "@signpdf/signpdf";
import { P12Signer } from "@signpdf/signer-p12";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";

// Vite defines these at build time. See @electron-forge/plugin-vite docs.
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

// Returns the window the user most likely intends as the target for an
// incoming action (file-open event, native dialog, menu command). Prefers the
// currently focused window; falls back to the first window in the app's
// window list; null if no window is open.
function getActiveWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}
// Files the OS wants us to open before the window is ready — drained
// once the renderer signals it's listening.
const pendingOpenFiles: string[] = [];

// Hoisted high so the early helpers (queueOrSendOpen, bringWindowForward)
// can call it. The Finder Sync extension dispatches via this same log path
// for `weavepdf://` URL invocations — sharing one file means the user can
// share /tmp/weavepdf-quickaction.log and we get a unified trace of every
// open-file / right-click event the app handled.
const FINDER_SYNC_LOG = "/tmp/weavepdf-quickaction.log";
function logFinderSync(line: string): void {
  try {
    const stamp = new Date().toISOString();
    appendFileSync(FINDER_SYNC_LOG, `[${stamp}] ${line}\n`);
  } catch {
    // Logging is best-effort; ignore if /tmp is wedged.
  }
}

// Allowlist of filesystem paths the renderer is permitted to read or write
// via fs:read-file / fs:write-file / shell:show-in-folder. Paths are only
// added here by main-process flows the user initiated: dialog selections,
// drag-drop, OS open-file. This closes the "compromised renderer can steal
// /Users/X/.ssh/id_rsa via IPC" hole.
//
// Paths are stored in BOTH the lexical-resolved and realpath forms (V1.0020).
// realpath closes a TOCTOU where the user picks /Desktop/safe.pdf, the
// allowlist would store the lexical path, and an attacker symlinks that
// path to /etc/hosts before the renderer issues readFile. We bless both
// forms so that the user's pick survives a non-malicious symlink swap (e.g.
// Sketch/Figma proxy paths) AND assertBlessed can check the realpath.
const blessedPaths = new Set<string>();
function blessPath(p: string | null | undefined): void {
  if (!p) return;
  const resolved = path.resolve(p);
  blessedPaths.add(resolved);
  try {
    blessedPaths.add(realpathSync.native(resolved));
  } catch {
    // Save targets may not exist yet (Save As). Future writes will pass
    // because the lexical path is allowlisted; realpath resolution happens
    // when the file finally exists.
  }
}
function isInsidePath(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}
function policyRealPath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return realpathSync.native(resolved);
  } catch {
    // Save targets may not exist yet. Resolve the closest existing ancestor
    // so symlinked parent directories cannot bypass protected-location checks.
    // Hard cap the walk at 64 iterations so a maliciously-deep path can't
    // wedge the loop.
    const missing: string[] = [];
    let cursor = resolved;
    let i = 0;
    while (!existsSync(cursor) && i++ < 64) {
      const next = path.dirname(cursor);
      if (next === cursor) break;
      missing.unshift(path.basename(cursor));
      cursor = next;
    }
    try {
      return path.join(realpathSync.native(cursor), ...missing);
    } catch {
      return resolved;
    }
  }
}
function assertBlessed(p: string): void {
  const resolved = path.resolve(p);
  // Realpath check (V1.0020): reject if neither the lexical path nor the
  // realpath is in the allowlist. A symlink pointed at /etc/hosts after the
  // user blessed /Desktop/safe.pdf would have a realpath outside the
  // allowlist and get rejected here.
  let real = resolved;
  try {
    real = realpathSync.native(resolved);
  } catch {
    // File doesn't exist (yet — Save As). Lexical match is enough since
    // there's no symlink to resolve through.
  }
  if (!blessedPaths.has(resolved) && !blessedPaths.has(real)) {
    throw new Error(`path not permitted: ${resolved}`);
  }
  // Defense-in-depth: reject anything under the app's own userData so the
  // renderer can never reach signature.raw / sigcert.enc / pending tabs.
  const userData = policyRealPath(app.getPath("userData"));
  const checked = policyRealPath(resolved);
  if (isInsidePath(checked, userData)) {
    throw new Error("path not permitted: userData");
  }
}

// Path validator for the system-wide `weavepdf://` URL scheme (V1.0020).
// Any process on the Mac can dispatch a `weavepdf://compress?paths=…` URL
// and macOS will route it to WeavePDF — so the receiving handler MUST treat
// the paths as untrusted. The Finder Sync extension is a legit caller, but
// browsers, scripts, mailto: payloads, etc. could also form these URLs.
//
// Two-layer check:
//   1. Path realpath must live inside one of the user's "documents" roots
//      (Desktop, Documents, Downloads, Movies, Music, Pictures, Public,
//      iCloud Drive, /Volumes/* for external drives + DMGs).
//   2. Path realpath must NOT be inside a sensitive subtree (~/.ssh, ~/.aws,
//      ~/.gnupg, ~/Library/Keychains, ~/Library/Application Support, /etc,
//      /System, /private, /usr, /bin, /sbin).
//   3. Extension must be one of the file types our menu supports (pdf,
//      png, jpg/jpeg, heic, heif). Belt-and-braces with the Finder Sync
//      extension's filter, which we don't trust.
const WEAVEPDF_URL_ALLOWED_EXTS = new Set([
  "pdf", "png", "jpg", "jpeg", "heic", "heif",
]);
const WEAVEPDF_URL_BLOCKED_BASENAMES = new Set([
  ".ssh", ".aws", ".gnupg", ".config", ".kube", ".docker",
  "Keychains", "Cookies",
]);
function isSafeWeavePdfPath(p: string): boolean {
  // 1. Resolve to realpath. If the file doesn't exist, reject — the URL
  //    handler operates on existing files.
  let real: string;
  try {
    real = realpathSync.native(p);
  } catch {
    return false;
  }

  // 2. Allowed extension.
  const ext = path.extname(real).replace(/^\./, "").toLowerCase();
  if (!WEAVEPDF_URL_ALLOWED_EXTS.has(ext)) return false;

  // 3. Blocked subtree check — walk components and reject anything sensitive.
  const home = app.getPath("home");
  const homeReal = (() => {
    try { return realpathSync.native(home); } catch { return home; }
  })();
  const components = real.split(path.sep);
  for (const comp of components) {
    if (WEAVEPDF_URL_BLOCKED_BASENAMES.has(comp)) return false;
  }
  // Hard system paths.
  for (const blocked of ["/etc", "/private/etc", "/System", "/usr", "/bin", "/sbin"]) {
    if (real === blocked || real.startsWith(blocked + path.sep)) return false;
  }
  // App's own data — never let a `weavepdf://` URL touch it.
  const userData = policyRealPath(app.getPath("userData"));
  if (isInsidePath(real, userData)) return false;
  const appSupport = path.join(homeReal, "Library", "Application Support");
  if (isInsidePath(real, appSupport)) return false;
  const libraryKeychains = path.join(homeReal, "Library", "Keychains");
  if (isInsidePath(real, libraryKeychains)) return false;

  // 4. Allowed roots.
  const allowedRoots = [
    path.join(homeReal, "Desktop"),
    path.join(homeReal, "Documents"),
    path.join(homeReal, "Downloads"),
    path.join(homeReal, "Movies"),
    path.join(homeReal, "Music"),
    path.join(homeReal, "Pictures"),
    path.join(homeReal, "Public"),
    path.join(homeReal, "Library", "Mobile Documents"), // iCloud Drive
    "/Volumes",
    "/tmp", // some workflows pipe via /tmp; ext check above limits damage
    os.tmpdir(),
  ];
  return allowedRoots.some((root) => isInsidePath(real, root));
}

const MAX_SIGNATURE_DATA_URL_BYTES = 5 * 1024 * 1024;
function assertSignatureDataUrl(dataUrl: string): void {
  if (typeof dataUrl !== "string") {
    throw new Error("Signature payload must be a data URL");
  }
  if (Buffer.byteLength(dataUrl, "utf8") > MAX_SIGNATURE_DATA_URL_BYTES) {
    throw new Error("Signature image is too large");
  }
  if (!/^data:image\/(?:png|jpeg);base64,[a-z0-9+/]+={0,2}$/i.test(dataUrl)) {
    throw new Error("Signature must be a PNG or JPEG data URL");
  }
}

function assertQpdfArgSafe(value: string, label: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${label} cannot contain line breaks`);
  }
}

async function runQpdfWithArgFile(
  bin: string,
  args: string[],
  label: string,
  okCodes = new Set([0]),
): Promise<void> {
  for (const [idx, arg] of args.entries()) {
    assertQpdfArgSafe(arg, `qpdf argument ${idx + 1}`);
  }
  await new Promise<void>((resolve, reject) => {
    // @- keeps sensitive arguments, especially encryption passwords, out of
    // `ps aux`. Each line is one qpdf argument.
    const child = spawn(bin, ["@-"]);
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.stdout.on("data", () => {});
    child.on("error", reject);
    child.on("exit", (code) => {
      if (okCodes.has(code ?? -1)) resolve();
      else reject(new Error(stderr.trim() || `${label} exited ${code}`));
    });
    child.stdin.end(`${args.join("\n")}\n`);
  });
}

function ownerPasswordOrRandom(ownerPassword: string | undefined): string {
  return ownerPassword && ownerPassword.length > 0
    ? ownerPassword
    : randomBytes(24).toString("base64url");
}

function queueOrSendOpen(filePath: string): void {
  blessPath(filePath);
  // Multi-window: route the file-open to the currently-active window so PDFs
  // that arrive while window A is focused land as a tab in A, not in some
  // arbitrary other window. Defaults to a tab in whichever window is on top.
  const target = getActiveWindow();
  const ready = !!target && !target.webContents.isLoading();
  // V1.0023: detailed logging so we can debug "opens but didn't focus"
  // reports without screen-recording. Drops to /tmp/weavepdf-quickaction.log.
  logFinderSync(
    `queueOrSendOpen ${filePath} — target=${target ? "yes" : "no"} ready=${ready} windowCount=${BrowserWindow.getAllWindows().length}`,
  );
  if (target && ready) {
    target.webContents.send(IpcChannel.OpenFilePath, filePath);
    bringWindowForward(target);
    return;
  }
  // V1.0025: if there are NO windows (user closed the last one with the
  // red X — macOS keeps the app running but with zero windows), queueing
  // the path was a dead-end — nothing would drain it. Create a fresh
  // window; its did-finish-load handler drains pendingOpenFiles for us.
  // This matches the existing app.on("activate") behaviour for dock-icon
  // clicks; we just hadn't wired the same fallback into the file-open path.
  pendingOpenFiles.push(filePath);
  logFinderSync(`  → queued (pending=${pendingOpenFiles.length})`);
  // V1.0026: only create a window when app.isReady(). The open-file event
  // fires very early during cold start (before whenReady) — calling
  // createMainWindow at that point throws "Cannot create BrowserWindow
  // before app is ready" and the app crashes (visible to the user as a
  // JS error dialog). On cold start the whenReady handler creates the
  // first window and drains pendingOpenFiles for us, so this branch is
  // only needed for the post-close, app-still-running case.
  if (app.isReady() && BrowserWindow.getAllWindows().length === 0) {
    logFinderSync(`  → no windows; creating one to drain the queue`);
    createMainWindow();
  }
}

// Reliably brings the WeavePDF window to the foreground after a file-open
// event or a `weavepdf://` URL dispatch. The polite `app.focus({steal:true})`
// + `target.focus()` calls are a hint, not a guarantee — macOS's window
// server rejects them during active user input elsewhere, when the app is
// hidden via ⌘H, when the window is on a different Space, or when the
// dispatch races with another app raising itself.
//
// To make this reliable across all those states, we use the same trick Zoom
// uses when joining a meeting from background:
//   1. `app.show()`  — un-hide the app from ⌘H state.
//   2. `target.show() + restore()` — handle minimized/hidden window state.
//   3. `target.setAlwaysOnTop(true, "screen-saver")` — float the window above
//      the entire window stack, system UI included. macOS can't reject this.
//   4. `target.focus()` + `app.focus({ steal: true })` — request app focus
//      while we're at the always-on-top level so the app actually activates.
//   5. After ~120 ms (long enough for the WindowServer to settle), drop
//      back to normal level. Window stays focused; no longer floating.
//   6. Re-assert focus once more after another tick to handle the case where
//      Space switching ate the first focus call.
function bringWindowForward(target: BrowserWindow): void {
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  target.moveTop();
  if (process.platform !== "darwin") return;

  const startBounds = target.getBounds();
  logFinderSync(
    `bringWindowForward — focused=${target.isFocused()} visible=${target.isVisible()} minimized=${target.isMinimized()} bounds=${startBounds.x},${startBounds.y},${startBounds.width}x${startBounds.height}`,
  );

  // Un-hide the app if it was hidden via ⌘H. show() is a no-op when not
  // hidden, safe to always call.
  app.show?.();

  // V1.0023: bring to front across ALL macOS Spaces during the pulse.
  // Without this, the window comes forward only on its own Space — if the
  // user happens to be on a different Space (or in a different Stage
  // Manager group), the window is "in front" but not visible to them.
  // Capture prior state so we restore it after the pulse.
  const wasVisibleOnAllWorkspaces = target.isVisibleOnAllWorkspaces();
  try {
    target.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    // Some old Electron versions throw if the window isn't fullscreen-able.
  }

  // V1.0024: defeat macOS's "Show Desktop" gesture (Fn key / hot-corner).
  // Show Desktop slides every window off-screen via a system animation;
  // app.focus()/setAlwaysOnTop don't undo that animation, so the window
  // becomes "active" but stays at its slid-off position and the user sees
  // nothing change. setBounds with the captured pre-Show-Desktop bounds
  // forces a reposition that breaks the Show Desktop transform. If the
  // window's current bounds are already off-screen (caught the moment
  // Show Desktop is active), nudge it to a known on-screen rect.
  try {
    const displays = require("electron").screen.getAllDisplays();
    const onScreen = displays.some((d: { bounds: { x: number; y: number; width: number; height: number } }) => {
      const db = d.bounds;
      return (
        startBounds.x + startBounds.width > db.x &&
        startBounds.x < db.x + db.width &&
        startBounds.y + startBounds.height > db.y &&
        startBounds.y < db.y + db.height
      );
    });
    if (!onScreen) {
      // Window is fully off-screen (Show Desktop active). Center on the
      // primary display so we have somewhere visible to land.
      const primary = require("electron").screen.getPrimaryDisplay();
      target.setBounds({
        x: Math.max(primary.workArea.x + 40, primary.workArea.x + Math.floor((primary.workArea.width - startBounds.width) / 2)),
        y: Math.max(primary.workArea.y + 40, primary.workArea.y + Math.floor((primary.workArea.height - startBounds.height) / 2)),
        width: Math.min(startBounds.width, primary.workArea.width - 80),
        height: Math.min(startBounds.height, primary.workArea.height - 80),
      });
      logFinderSync(`  recentered to primary display (was off-screen — likely Show Desktop)`);
    } else {
      // On-screen but possibly slid: re-set the same bounds to break
      // any in-progress slide animation. setBounds is a no-op if the
      // bounds didn't actually change at the AppKit level, so this is
      // cheap when nothing's wrong.
      target.setBounds(startBounds);
    }
  } catch (err) {
    logFinderSync(`  bounds reset failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Force the window above EVERYTHING for a beat. screen-saver level beats
  // every normal stacking — including focus-stealing prevention. Briefly
  // visually disruptive (the window may flash above a fullscreen video for
  // ~100 ms) but reliable. This is the only path that survives every
  // background scenario I've seen reported.
  target.setAlwaysOnTop(true, "screen-saver");
  app.focus({ steal: true });
  target.focus();
  target.moveTop();

  // V1.0023: AppleScript activation as the FINAL, most reliable focus
  // primitive on macOS. `app.focus({ steal: true })` is documented as a
  // hint and macOS's WindowServer can ignore it under load (Spaces switch,
  // active input in another app, recent activation policy changes). The
  // `osascript activate` call goes through NSWorkspace which is the same
  // path the dock icon uses — macOS treats this as a user-initiated
  // activation and won't reject it.
  try {
    spawn("osascript", ["-e", 'tell application "WeavePDF" to activate'], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch (err) {
    logFinderSync(`  osascript activate failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  setTimeout(() => {
    if (target.isDestroyed()) return;
    target.setAlwaysOnTop(false);
    // Restore prior cross-Space behaviour. We only forced it during the
    // pulse so the user's window-management preferences are preserved.
    try {
      target.setVisibleOnAllWorkspaces(wasVisibleOnAllWorkspaces, {
        visibleOnFullScreen: wasVisibleOnAllWorkspaces,
      });
    } catch {
      // ignore
    }
    // Re-assert focus once more in case the Space change or app switch ate
    // the first call. moveTop ensures we're at the top of the window stack
    // within the current Space.
    target.focus();
    target.moveTop();
    app.focus({ steal: true });
    const endBounds = target.getBounds();
    logFinderSync(
      `  after-pulse — focused=${target.isFocused()} visible=${target.isVisible()} bounds=${endBounds.x},${endBounds.y},${endBounds.width}x${endBounds.height}`,
    );
  }, 200);

  // V1.0024: retry loop. macOS's "Show Desktop" undo animation can take
  // 300-800ms during which the previously-frontmost app stays frontmost
  // and OUR activation requests are rejected. Trace logs from the user's
  // own machine showed `focused=false` after the 200ms pulse on this
  // path — every prior trick (alwaysOnTop, AppleScript, app.focus) was
  // landing during the animation and getting dropped.
  //
  // Strategy: poll `isFocused()` for up to 2.5s and re-fire the activation
  // primitives every 200ms while focus hasn't taken. Stops the moment
  // we're focused (no further work) so this is cheap when the initial
  // pulse already worked.
  let retryCount = 0;
  const RETRY_LIMIT = 12; // 12 × 200ms = 2.4s max
  const retryFocus = (): void => {
    if (target.isDestroyed()) return;
    if (target.isFocused()) {
      if (retryCount > 0) {
        logFinderSync(`  focus took on retry ${retryCount}`);
      }
      return;
    }
    if (retryCount >= RETRY_LIMIT) {
      logFinderSync(
        `  retry limit hit (${RETRY_LIMIT}); giving up — window may still be backgrounded`,
      );
      return;
    }
    retryCount++;
    target.focus();
    target.moveTop();
    app.focus({ steal: true });
    // Re-fire AppleScript activate every 4th retry — Apple Events are
    // queued but macOS's NSWorkspace coalesces duplicates, so spamming
    // doesn't help. Once per ~800ms is the sweet spot.
    if (retryCount % 4 === 1) {
      try {
        spawn("osascript", ["-e", 'tell application "WeavePDF" to activate'], {
          detached: true,
          stdio: "ignore",
        }).unref();
      } catch {
        // ignore — best effort
      }
    }
    setTimeout(retryFocus, 200);
  };
  // Kick off the retry loop after the main pulse finishes.
  setTimeout(retryFocus, 300);
}

async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// V1.0026: per-window snapshot of dirty tab names. Renderer publishes via
// the NotifyDirtyTabs IPC on every store change. Used by the close /
// before-quit handlers to show an "unsaved changes" confirmation dialog.
const dirtyTabsByWindowId = new Map<number, string[]>();
// One-shot allow-flag set when the user clicks "Close Anyway" so the
// preventDefault path lets the actual close go through.
const skipUnsavedConfirmForWindowId = new Set<number>();
// Set during app.before-quit so each window's close handler skips its
// own confirmation (we showed one combined dialog for the quit).
let appQuittingApproved = false;

function createMainWindow(): BrowserWindow {
  // V1.0031: any window-creation path means the user is going to interact
  // with WeavePDF, so we drop the accessory-only policy and let macOS
  // give us a dock icon + menu bar. No-op when already foreground.
  transitionToForeground();
  const preloadPath = path.join(__dirname, "preload.js");

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    title: "WeavePDF",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0B0B0E" : "#F7F7F8",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    vibrancy: "under-window",
    visualEffectState: "active",
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  // V1.0026: intercept window-close to confirm unsaved changes. The
  // renderer pushes its dirty tab list via NotifyDirtyTabs on every store
  // change; we keep the latest snapshot and consult it here. preventDefault
  // aborts the close; once the user accepts via the native dialog, we set
  // the skip flag and close() again.
  win.on("close", (event) => {
    const winId = win.id;
    if (skipUnsavedConfirmForWindowId.has(winId) || appQuittingApproved) {
      // The combined-quit dialog already approved or we're past confirm.
      skipUnsavedConfirmForWindowId.delete(winId);
      return;
    }
    const dirty = dirtyTabsByWindowId.get(winId) ?? [];
    if (dirty.length === 0) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      message:
        dirty.length === 1
          ? "“" + dirty[0] + "” has unsaved changes."
          : `${dirty.length} tabs have unsaved changes.`,
      detail:
        dirty.length === 1
          ? "If you close this window now, your edits will be lost."
          : "If you close this window now, edits in these tabs will be lost:\n\n• " +
            dirty.join("\n• "),
      buttons: ["Cancel", "Close Anyway"],
      cancelId: 0,
      defaultId: 0,
    });
    if (choice === 1) {
      skipUnsavedConfirmForWindowId.add(winId);
      // Re-issue the close after this tick — the current close was
      // preventDefault'd. Doing it sync inside this handler would recurse.
      setImmediate(() => {
        if (!win.isDestroyed()) win.close();
      });
    }
  });

  win.on("closed", () => {
    dirtyTabsByWindowId.delete(win.id);
    skipUnsavedConfirmForWindowId.delete(win.id);
  });

  // Hardening: any link, window.open, or embedded <webview> in content we
  // render (for example from a hostile PDF) gets routed safely instead of
  // replacing the renderer or spawning a new privileged window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, navUrl) => {
    // Allow the initial load (file:// in prod, http://localhost in dev);
    // block everything else from hijacking the renderer.
    const current = win.webContents.getURL();
    if (current && navUrl !== current) {
      event.preventDefault();
    }
  });
  win.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  win.webContents.once("did-finish-load", () => {
    // Flush any open-file paths that arrived before the window was ready.
    // Drain ALL queued paths and bring the window forward once if any drained
    // — covers the cold-start path where the user double-clicked a PDF that
    // launched WeavePDF; macOS auto-focuses cold launches, but the deferred
    // bringWindowForward also handles the edge case where another app stole
    // focus during the renderer load.
    let drained = false;
    while (pendingOpenFiles.length > 0) {
      const p = pendingOpenFiles.shift();
      if (p) {
        win.webContents.send(IpcChannel.OpenFilePath, p);
        drained = true;
      }
    }
    if (drained) bringWindowForward(win);
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // Multi-window: nothing to clean up here — Electron prunes the window from
  // BrowserWindow.getAllWindows() automatically. The renderer's Zustand state
  // is per-window (each window has its own renderer process), so nothing
  // outside this window needs to know it closed.

  return win;
}

async function readOpenedFile(filePath: string): Promise<OpenedFile> {
  const [buffer, stats] = await Promise.all([readFile(filePath), stat(filePath)]);
  return {
    path: filePath,
    name: basename(filePath),
    sizeBytes: stats.size,
    data: u8ToAb(buffer),
  };
}

function registerIpc(): void {
  // V1.0026: receive dirty-tab snapshots from each renderer. Stored
  // per-window-id so the close + before-quit handlers can show a precise
  // "unsaved changes" dialog without an async roundtrip during close
  // (which would force the dialog to be interrupt-able by the close —
  // worst-of-both-worlds UX).
  ipcMain.on(IpcChannel.NotifyDirtyTabs, (e, names: unknown) => {
    if (!Array.isArray(names)) return;
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    const safe = names.filter((n): n is string => typeof n === "string").slice(0, 200);
    dirtyTabsByWindowId.set(win.id, safe);
  });

  ipcMain.handle(
    IpcChannel.OpenFileDialog,
    async (e, options: OpenFileDialogOptions | undefined) => {
      const dialogOpts: Electron.OpenDialogOptions = {
        title: options?.title ?? "Open",
        properties: options?.multi ? ["openFile", "multiSelections"] : ["openFile"],
        filters: options?.filters ?? [{ name: "PDF", extensions: ["pdf"] }],
      };
      // Scope the dialog to the window that initiated the IPC so it appears
      // as a sheet on the right window in multi-window mode.
      const callingWin = BrowserWindow.fromWebContents(e.sender);
      const result = callingWin
        ? await dialog.showOpenDialog(callingWin, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts);
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true as const };
      }
      for (const p of result.filePaths) blessPath(p);
      const files = await Promise.all(result.filePaths.map(readOpenedFile));
      return { canceled: false as const, files };
    },
  );

  ipcMain.handle(
    IpcChannel.SaveFileDialog,
    async (e, options: SaveFileDialogOptions) => {
      const saveOpts: Electron.SaveDialogOptions = {
        title: options.title ?? "Save",
        defaultPath: options.suggestedName,
        filters: [{ name: "PDF", extensions: options.extensions }],
      };
      const callingWin = BrowserWindow.fromWebContents(e.sender);
      const result = callingWin
        ? await dialog.showSaveDialog(callingWin, saveOpts)
        : await dialog.showSaveDialog(saveOpts);
      if (result.canceled || !result.filePath) {
        return { canceled: true as const };
      }
      blessPath(result.filePath);
      return { canceled: false as const, path: result.filePath };
    },
  );

  ipcMain.handle(IpcChannel.ReadFile, async (_e, filePath: string) => {
    assertBlessed(filePath);
    return readOpenedFile(filePath);
  });

  ipcMain.handle(
    IpcChannel.WriteFile,
    async (_e, filePath: string, bytes: ArrayBuffer): Promise<WriteFileResult> => {
      try {
        assertBlessed(filePath);
        await writeFile(filePath, Buffer.from(bytes));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String((err as Error)?.message ?? err) };
      }
    },
  );

  ipcMain.handle(IpcChannel.ShowInFolder, async (_e, filePath: string) => {
    assertBlessed(filePath);
    shell.showItemInFolder(filePath);
  });

  // Used only by the WelcomeModal's "Open System Settings" button. Hard-coded
  // to the Login Items & Extensions pane URL — no caller can pass arbitrary
  // URL schemes through this channel.
  ipcMain.handle(IpcChannel.OpenSystemSettings, async () => {
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
    );
  });

  // Default-PDF-app handling.
  //
  // macOS doesn't expose default-app management through Electron's API. We
  // shell out to `/usr/bin/swift -` (Xcode CLT, ships with the system on any
  // dev machine and on most modern Macs that have updated to recent Sonoma+
  // versions), feeding inline Swift via stdin. The script uses the modern
  // `NSWorkspace.shared.urlForApplication(toOpen:)` /
  // `NSWorkspace.shared.setDefaultApplication(at:toOpen:)` APIs — both
  // available since macOS 12.
  //
  // Used by the renderer's DefaultPdfBanner to (1) detect whether to surface
  // the prompt, and (2) act on the user's "Make Default" click.
  const runSwift = (src: string): Promise<{ stdout: string; code: number }> =>
    new Promise((resolve) => {
      const child = spawn("/usr/bin/swift", ["-"]);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
      child.stdin.end(src);
      child.on("error", () => resolve({ stdout: "", code: -1 }));
      child.on("exit", (code) => {
        if (code !== 0 && stderr) console.error("[default-pdf swift]", stderr.trim());
        resolve({ stdout, code: code ?? -1 });
      });
    });

  ipcMain.handle(IpcChannel.GetDefaultPdfApp, async () => {
    const swiftSrc = `
import AppKit
import UniformTypeIdentifiers
if #available(macOS 12.0, *) {
  if let pdfType = UTType(filenameExtension: "pdf"),
     let appURL = NSWorkspace.shared.urlForApplication(toOpen: pdfType),
     let bundle = Bundle(url: appURL) {
    print(bundle.bundleIdentifier ?? "")
  }
}
`;
    const { stdout, code } = await runSwift(swiftSrc);
    if (code !== 0) {
      return { isDefault: false, currentBundleId: null };
    }
    const currentBundleId = stdout.trim() || null;
    return {
      isDefault: currentBundleId === "ca.adamhayat.weavepdf",
      currentBundleId,
    };
  });

  ipcMain.handle(IpcChannel.SetAsDefaultPdfApp, async () => {
    const appPath = "/Applications/WeavePDF.app";
    const swiftSrc = `
import AppKit
import UniformTypeIdentifiers
guard #available(macOS 12.0, *) else {
  FileHandle.standardError.write("requires macOS 12+\\n".data(using: .utf8)!)
  exit(2)
}
guard let pdfType = UTType(filenameExtension: "pdf") else {
  FileHandle.standardError.write("could not resolve PDF UTType\\n".data(using: .utf8)!)
  exit(3)
}
let appURL = URL(fileURLWithPath: ${JSON.stringify(appPath)})
let group = DispatchGroup()
group.enter()
NSWorkspace.shared.setDefaultApplication(at: appURL, toOpen: pdfType) { error in
  if let error = error {
    FileHandle.standardError.write(("error: " + error.localizedDescription + "\\n").data(using: .utf8)!)
    exit(4)
  }
  group.leave()
}
group.wait()
`;
    const { code } = await runSwift(swiftSrc);
    if (code === 0) return { ok: true };
    return { ok: false, error: `swift exited ${code}` };
  });

  ipcMain.handle(IpcChannel.PrintWindow, async (e) => {
    // V1.0021: legacy path. New code uses PrintPdfBytes (which prints the
    // PDF document only, not the app's UI chrome). This handler now does
    // nothing useful for PDF documents because webContents.print() on the
    // main window prints the entire renderer DOM (sidebar thumbnails +
    // toolstrip etc.). Kept as a no-op for back-compat to avoid runtime
    // errors if any old caller still invokes it.
    void e;
  });

  // V1.0021: clean PDF print. Caller passes already-laid-out PDF bytes
  // (overlays committed, n-up applied if requested). We write the bytes to
  // a temp file, open them in a HIDDEN BrowserWindow that loads only the
  // PDF — Electron/Chromium renders it with PDFium. Then we call
  // webContents.print() on that hidden window so the macOS native print
  // dialog appears with just the PDF as input. Critically: the user's
  // sidebar thumbnails, toolstrip, and titlebar are NOT in the hidden
  // window's DOM, so they can't bleed into the print output.
  // V1.0028: list available printers for the unified Print Preview panel.
  // Uses webContents.getPrintersAsync() — the modern replacement for the
  // sync getPrinters() API. Returns the same fields macOS exposes via CUPS:
  // name (CUPS device id, used as deviceName in print() options), displayName
  // (user-friendly), isDefault (one printer at a time), status (CUPS bitmask).
  ipcMain.handle(IpcChannel.ListPrinters, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return [];
    try {
      // Electron's typed PrinterInfo only declares `name` + `displayName`,
      // but the runtime payload also includes isDefault + status (CUPS).
      // Cast through unknown so we don't ship a `any`.
      const list = (await win.webContents.getPrintersAsync()) as unknown as Array<{
        name: string;
        displayName?: string;
        isDefault?: boolean;
        status?: number;
      }>;
      return list.map((p) => ({
        name: p.name,
        displayName: p.displayName || p.name,
        isDefault: !!p.isDefault,
        status: typeof p.status === "number" ? p.status : 0,
      }));
    } catch {
      return [];
    }
  });

  ipcMain.handle(
    IpcChannel.PrintPdfBytes,
    async (
      _e,
      bytes: ArrayBuffer,
      documentName?: string,
      options?: import("../shared/ipc").PrintOptions,
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!bytes || !(bytes instanceof ArrayBuffer)) {
        return { ok: false, error: "no bytes" };
      }
      if (bytes.byteLength === 0) return { ok: false, error: "empty bytes" };
      const buf = Buffer.from(bytes);

      // Use the document name (without .pdf) as the temp filename so macOS
      // shows a sensible job title in the print queue + dialog. Sanitize
      // aggressively — only ASCII alphanumerics, dash, underscore, dot.
      const safeName = (documentName || "document")
        .replace(/\.pdf$/i, "")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 100) || "document";
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "weavepdf-print-"));
      const pdfPath = path.join(tmpDir, `${safeName}.pdf`);
      await writeFile(pdfPath, buf);

      const hidden = new BrowserWindow({
        show: false,
        // Letter at 96 DPI ≈ 816×1056. Comfortable initial render area for
        // PDFium; doesn't affect what gets printed.
        width: 816,
        height: 1056,
        webPreferences: {
          // plugins:true enables the bundled PDFium plugin so file://*.pdf
          // renders cleanly inside the hidden window.
          plugins: true,
          // Stay locked down — print path doesn't need any of these.
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          javascript: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          partition: `print-${randomUUID()}`,
        },
      });

      // Hard-block any outbound load except the temp PDF itself. If a
      // hostile PDF tries to phone home through an embedded annotation,
      // the request is cancelled before it leaves the host.
      hidden.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
      const allowedPdfUrl = "file://" + pdfPath;
      hidden.webContents.session.webRequest.onBeforeRequest((details, cb) => {
        try {
          const u = new URL(details.url);
          if (u.protocol === "file:" && u.pathname === pdfPath) return cb({ cancel: false });
        } catch {
          // fall through
        }
        if (details.url === allowedPdfUrl) return cb({ cancel: false });
        // Allow Chromium-internal chrome:// URLs the PDFium UI uses.
        if (details.url.startsWith("chrome://") || details.url.startsWith("chrome-extension://")) {
          return cb({ cancel: false });
        }
        cb({ cancel: true });
      });
      hidden.webContents.on("will-navigate", (ev) => ev.preventDefault());
      hidden.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

      try {
        await hidden.loadFile(pdfPath);
        // Title the print job after the doc — macOS uses this in the
        // print queue + the default page header (when the user has
        // "Print headers and footers" enabled in the dialog). Cleaner
        // than the temp file path or generic "untitled".
        try {
          hidden.setTitle(safeName);
        } catch {
          // Some platforms throw on setTitle for hidden windows; ignore.
        }
        // Give PDFium a beat to lay out ALL pages. Without this the
        // print() call sometimes fires before later pages are composed
        // and prints a partial doc. 1.2s is comfortable for 100-page
        // PDFs on Adam's M1 — adjust upward if larger PDFs get clipped.
        await new Promise((r) => setTimeout(r, 1200));

        // V1.0028: when the unified panel passed `options`, print silently
        // with all settings pre-chosen. Otherwise (legacy path with no
        // options), show the native macOS dialog as V1.0021 did. This keeps
        // any future caller that doesn't yet provide options working.
        const useSilent = !!options?.deviceName;
        const printOpts: Electron.WebContentsPrintOptions = useSilent
          ? {
              silent: true,
              printBackground: false,
              header: "",
              footer: "",
              margins: { marginType: "default" },
              deviceName: options!.deviceName,
              color: options!.color,
              copies: Math.max(1, Math.floor(options!.copies || 1)),
              duplexMode: options!.duplexMode,
              landscape: options!.landscape,
              ...(options!.pageRanges && options!.pageRanges.length > 0
                ? { pageRanges: options!.pageRanges }
                : {}),
            }
          : {
              silent: false,
              printBackground: false,
              header: "",
              footer: "",
              margins: { marginType: "default" },
            };
        const printed = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
          hidden.webContents.print(printOpts, (success, failureReason) => {
            if (success) return resolve({ ok: true });
            // "cancelled" is the user hitting Cancel in the system
            // dialog — that's a normal outcome, not an error.
            if (failureReason === "cancelled") return resolve({ ok: false });
            resolve({ ok: false, error: failureReason || "print failed" });
          });
        });
        return printed;
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        if (!hidden.isDestroyed()) hidden.destroy();
        // Don't await — best-effort cleanup, fire and forget.
        void rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  );

  ipcMain.handle(IpcChannel.GetAppTheme, (): AppTheme => {
    return nativeTheme.shouldUseDarkColors ? "dark" : "light";
  });

  ipcMain.on(IpcChannel.WindowMinimize, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize();
  });
  ipcMain.on(IpcChannel.WindowMaximize, (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  ipcMain.on(IpcChannel.WindowClose, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close();
  });

  // Signatures are stored encrypted by macOS Keychain via safeStorage when
  // available. Ad-hoc-signed / unsigned Electron apps sometimes get
  // `safeStorage.isEncryptionAvailable() === false` (Keychain won't hand the
  // key to an app without a stable signing identity). In that case we fall
  // back to a plain-text file under userData so the feature still works —
  // users are shown a warning in the UI. The signature is a personal image,
  // stored in the user's own account folder; the blast radius if the fallback
  // triggers is similar to any other file in ~/Library/Application Support/.
  const sigEncPath = () => path.join(app.getPath("userData"), "signature.enc");
  const sigRawPath = () => path.join(app.getPath("userData"), "signature.raw");

  ipcMain.handle(IpcChannel.SignatureGet, async (): Promise<string | null> => {
    const enc = sigEncPath();
    const raw = sigRawPath();
    if (existsSync(enc) && safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(await readFile(enc));
      } catch {
        // Decryption failed — Keychain rejected, item missing, or build
        // identity changed. Don't fall through to a plaintext fallback;
        // surface null so the user re-creates the signature with the new
        // signing identity.
        return null;
      }
    }
    // Legacy plain signature.raw from V1.0019 and earlier — refuse + delete.
    // V1.0020 no longer writes this fallback; old builds may have left one.
    if (existsSync(raw)) {
      await unlink(raw).catch(() => {});
    }
    return null;
  });

  ipcMain.handle(IpcChannel.SignatureSet, async (_e, dataUrl: string): Promise<void> => {
    assertSignatureDataUrl(dataUrl);
    // V1.0020: refuse to persist a signature without Keychain. A captured
    // handwritten signature is a meaningful identity asset; keeping it on
    // disk in plaintext (even with 0o600) puts it one Time-Machine-restore
    // away from another user/device. If Keychain isn't available, surface
    // a clear error so the renderer can prompt the user to fix their
    // signing identity rather than silently downgrading their security.
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "Cannot save signature without Keychain encryption. " +
          "If WeavePDF is ad-hoc signed, run `bash scripts/setup-local-signing.sh` " +
          "and reinstall, then try again.",
      );
    }
    await writeFile(sigEncPath(), safeStorage.encryptString(dataUrl));
    // Clean up any stale plain copy from older builds.
    await unlink(sigRawPath()).catch(() => {});
  });

  ipcMain.handle(IpcChannel.SignatureClear, async (): Promise<void> => {
    await unlink(sigEncPath()).catch(() => {});
    await unlink(sigRawPath()).catch(() => {});
  });

  // ─── Digital certificates (PKCS#7) ──────────────────────────────────────
  // Self-signed certificate stored only with Keychain-backed encryption.
  // On-device key + P12 wrapping with an internal random passphrase; the
  // user never sees the passphrase. Signing uses @signpdf/signpdf which
  // inserts an invisible CMS signature dictionary into the PDF's byte range.
  const certEncPath = () => path.join(app.getPath("userData"), "sigcert.enc");
  const certRawPath = () => path.join(app.getPath("userData"), "sigcert.raw");
  const certMetaPath = () => path.join(app.getPath("userData"), "sigcert.meta.json");

  const loadCert = async (): Promise<{ p12: Buffer; pass: string } | null> => {
    const enc = certEncPath();
    const parseBlob = (s: string): { p12: Buffer; pass: string } | null => {
      try {
        const o = JSON.parse(s) as { p12: string; pass: string };
        return { p12: Buffer.from(o.p12, "base64"), pass: o.pass };
      } catch {
        return null;
      }
    };
    if (existsSync(enc) && safeStorage.isEncryptionAvailable()) {
      try {
        const decrypted = safeStorage.decryptString(await readFile(enc));
        return parseBlob(decrypted);
      } catch {
        return null;
      }
    }
    // Legacy plain cert.raw from older builds — refuse to use it + delete.
    if (existsSync(certRawPath())) {
      await unlink(certRawPath()).catch(() => {});
    }
    return null;
  };

  const storeCert = async (p12: Buffer, pass: string): Promise<void> => {
    // Only Keychain-backed storage is acceptable for a signing key. The
    // caller (SigGenCert) gates on `isEncryptionAvailable()`; this is the
    // second line of defense in case that gate is ever bypassed.
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Refusing to store signing key without Keychain encryption");
    }
    const blob = JSON.stringify({ p12: p12.toString("base64"), pass });
    await writeFile(certEncPath(), safeStorage.encryptString(blob));
    await unlink(certRawPath()).catch(() => {});
  };

  ipcMain.handle(
    IpcChannel.SigGenCert,
    async (
      _e,
      params: { name: string; email: string; org?: string; years?: number },
    ): Promise<DigitalCertInfo> => {
      // Refuse to generate a persisted cert without Keychain. Our fallback
      // path would write the P12 + passphrase in plaintext to userData,
      // which nullifies the passphrase and leaves the signing identity
      // readable to anything that can read files in the user's account.
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error(
          "Keychain is unavailable on this build. Digital-signature certificates require Keychain-backed storage; the image-signature fallback (plain file) is not safe for a signing key.",
        );
      }
      const { pki, md, random, asn1, util, pkcs12 } = forge;
      const keys = pki.rsa.generateKeyPair(2048);
      const cert = pki.createCertificate();
      cert.publicKey = keys.publicKey;
      cert.serialNumber = "01" + Date.now().toString(16);
      cert.validity.notBefore = new Date();
      cert.validity.notAfter = new Date();
      cert.validity.notAfter.setFullYear(
        cert.validity.notBefore.getFullYear() + (params.years ?? 5),
      );
      const attrs: { name: string; value: string }[] = [
        { name: "commonName", value: params.name },
        { name: "emailAddress", value: params.email },
      ];
      if (params.org) attrs.push({ name: "organizationName", value: params.org });
      cert.setSubject(attrs);
      cert.setIssuer(attrs);
      cert.setExtensions([
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, nonRepudiation: true, keyEncipherment: true },
        { name: "extKeyUsage", clientAuth: true, emailProtection: true },
      ]);
      cert.sign(keys.privateKey, md.sha256.create());
      // Random internal passphrase; never shown to the user.
      const pass = util.encode64(random.getBytesSync(24));
      const asn1p12 = pkcs12.toPkcs12Asn1(keys.privateKey, [cert], pass, {
        algorithm: "aes256",
        count: 100_000,
      });
      const derBytes = asn1.toDer(asn1p12).getBytes();
      const p12 = Buffer.from(derBytes, "binary");
      await storeCert(p12, pass);
      const meta: DigitalCertInfo = {
        name: params.name,
        email: params.email,
        org: params.org,
        createdAt: cert.validity.notBefore.toISOString(),
        expiresAt: cert.validity.notAfter.toISOString(),
      };
      await writeFile(certMetaPath(), JSON.stringify(meta));
      return meta;
    },
  );

  ipcMain.handle(IpcChannel.SigHasCert, async (): Promise<boolean> => {
    return (await loadCert()) !== null;
  });

  ipcMain.handle(IpcChannel.SigGetCertInfo, async (): Promise<DigitalCertInfo | null> => {
    if (!existsSync(certMetaPath())) return null;
    try {
      return JSON.parse((await readFile(certMetaPath())).toString("utf8")) as DigitalCertInfo;
    } catch {
      return null;
    }
  });

  ipcMain.handle(IpcChannel.SigClearCert, async (): Promise<void> => {
    await unlink(certEncPath()).catch(() => {});
    await unlink(certRawPath()).catch(() => {});
    await unlink(certMetaPath()).catch(() => {});
  });

  // Test-only bless hook. Gated on a VITE_E2E flag replaced at build time
  // (Vite inlines `import.meta.env.VITE_E2E` into the bundle). Production
  // builds ship with a literal "" value; the `if` is dead code there.
  if (import.meta.env.VITE_E2E === "1") {
    ipcMain.handle(IpcChannel.TestBlessPath, (_e, p: string) => {
      blessPath(p);
    });
  }

  // Blesses a path that the preload resolved from a drag-drop File object.
  // Synchronous so the renderer can immediately call readFile after dropping.
  ipcMain.on(IpcChannel.BlessDropPath, (event, p: string) => {
    if (typeof p === "string" && p.length > 0) blessPath(p);
    event.returnValue = true;
  });

  // Blesses an output path derived from an already-blessed input path (same
  // directory). Used by BatchModal for `input-processed.pdf` alongside `input.pdf`.
  // ─── Draft persistence (autosave + restore) ─────────────────────────
  // One slot per draftKey, keyed by sha256(draftKey). Slot contains
  // `manifest.json` (everything that fits in JSON) and optionally
  // `current.pdf` (the bytes when committed history exists). draftKey is the
  // disk path for opened files, or a synthetic `weavepdf-virtual://<uuid>`
  // URI for in-memory tabs (combined PDFs, DOCX/image imports) so every
  // open tab gets autosaved. Virtual drafts are resumed via the Recent
  // Drafts picker rather than by reopening a disk file.
  const draftsRoot = (): string => path.join(app.getPath("userData"), "drafts");
  const slotForKey = (draftKey: string): string => {
    // For real on-disk paths we still resolve to absolute first so two opens
    // of the same file from different cwds collapse to the same slot. For
    // synthetic `weavepdf-virtual://…` keys path.resolve is a no-op string
    // mash but doesn't change the hash.
    const normalised = draftKey.startsWith("weavepdf-virtual://")
      ? draftKey
      : path.resolve(draftKey);
    const hash = createHash("sha256").update(normalised).digest("hex");
    return path.join(draftsRoot(), hash);
  };

  ipcMain.handle(
    IpcChannel.DraftsSave,
    async (
      _e,
      manifest: DraftManifest,
      currentBytes: ArrayBuffer | null,
    ): Promise<void> => {
      const slot = slotForKey(manifest.draftKey);
      await mkdir(slot, { recursive: true });
      await writeFile(path.join(slot, "manifest.json"), JSON.stringify(manifest));
      if (currentBytes && currentBytes.byteLength > 0) {
        await writeFile(path.join(slot, "current.pdf"), Buffer.from(currentBytes));
      } else {
        await unlink(path.join(slot, "current.pdf")).catch(() => {});
      }
    },
  );

  ipcMain.handle(
    IpcChannel.DraftsLoad,
    async (_e, draftKey: string): Promise<DraftRecord | null> => {
      const slot = slotForKey(draftKey);
      const manifestPath = path.join(slot, "manifest.json");
      if (!existsSync(manifestPath)) return null;
      try {
        const manifest = JSON.parse(
          (await readFile(manifestPath)).toString("utf8"),
        ) as DraftManifest;
        const pdfPath = path.join(slot, "current.pdf");
        let currentBytes: ArrayBuffer | null = null;
        if (existsSync(pdfPath)) {
          const buf = await readFile(pdfPath);
          currentBytes = u8ToAb(buf);
        }
        return { manifest, currentBytes };
      } catch {
        return null;
      }
    },
  );

  ipcMain.handle(IpcChannel.DraftsClear, async (_e, draftKey: string): Promise<void> => {
    const slot = slotForKey(draftKey);
    if (existsSync(slot)) {
      await rm(slot, { recursive: true, force: true }).catch(() => {});
    }
  });

  ipcMain.handle(IpcChannel.DraftsList, async (): Promise<DraftManifest[]> => {
    const root = draftsRoot();
    if (!existsSync(root)) return [];
    const entries = await readdir(root);
    const out: DraftManifest[] = [];
    for (const e of entries) {
      const mp = path.join(root, e, "manifest.json");
      if (!existsSync(mp)) continue;
      try {
        out.push(JSON.parse((await readFile(mp)).toString("utf8")) as DraftManifest);
      } catch {
        /* skip corrupt */
      }
    }
    // Newest first.
    out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    return out;
  });

  ipcMain.handle(
    IpcChannel.BlessDerivedPath,
    (_e, sourcePath: string, derivedPath: string): boolean => {
      try {
        assertBlessed(sourcePath);
      } catch {
        return false;
      }
      const srcDir = path.dirname(path.resolve(sourcePath));
      const derivedDir = path.dirname(path.resolve(derivedPath));
      if (srcDir !== derivedDir) return false;
      blessPath(derivedPath);
      return true;
    },
  );

  ipcMain.handle(
    IpcChannel.SigSignPdf,
    async (
      _e,
      pdfBytes: ArrayBuffer,
      opts: { reason?: string; location?: string } = {},
    ): Promise<ArrayBuffer> => {
      const cert = await loadCert();
      if (!cert) throw new Error("No signing certificate. Generate one first.");
      let meta: DigitalCertInfo | null = null;
      if (existsSync(certMetaPath())) {
        try {
          meta = JSON.parse((await readFile(certMetaPath())).toString("utf8")) as DigitalCertInfo;
        } catch {
          /* ignore */
        }
      }
      const { PDFDocument } = await import("pdf-lib");
      const doc = await PDFDocument.load(Buffer.from(pdfBytes), {
        ignoreEncryption: true,
        updateMetadata: false,
      });
      pdflibAddPlaceholder({
        pdfDoc: doc,
        reason: opts.reason ?? "Signed with WeavePDF",
        contactInfo: meta?.email ?? "unknown",
        name: meta?.name ?? "Signer",
        location: opts.location ?? "macOS",
        appName: "WeavePDF",
      });
      // Keep object streams off so the saved placeholder uses a classic xref
      // table, which remains the most reliable input shape for @signpdf.
      const withPlaceholder = Buffer.from(await doc.save({ useObjectStreams: false }));
      const signer = new P12Signer(cert.p12, { passphrase: cert.pass });
      const signpdf = new SignPdf();
      const signed = await signpdf.sign(withPlaceholder, signer);
      return u8ToAb(signed);
    },
  );

  // ─── OCR (Apple Vision) ──────────────────────────────────────────────
  // Compiled Swift helper. Forge's extraResource:["resources"] copies the
  // whole folder into Contents/Resources/resources/, so the packaged path
  // has an extra "resources/" segment vs dev.
  const ocrBinaryPath = (): string => {
    const resourcesRoot = app.isPackaged
      ? path.join(process.resourcesPath, "resources")
      : path.join(__dirname, "..", "..", "resources");
    return path.join(resourcesRoot, "helpers", "ocr-bin");
  };

  ipcMain.handle(IpcChannel.OcrAvailable, async (): Promise<boolean> => {
    return existsSync(ocrBinaryPath());
  });

  // ─── qpdf (password unlock) ─────────────────────────────────────────
  // Look for qpdf on PATH. Fallback to homebrew's standard install path so
  // apps launched from /Applications (which don't inherit the shell's PATH)
  // can still find it.
  const qpdfBinaryPath = (): string | null => {
    const candidates = [
      "/opt/homebrew/bin/qpdf",
      "/usr/local/bin/qpdf",
      "/usr/bin/qpdf",
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return null;
  };

  ipcMain.handle(IpcChannel.QpdfAvailable, async (): Promise<boolean> => {
    return qpdfBinaryPath() !== null;
  });

  // Encrypt a PDF with a user (and optional owner) password. Owner defaults
  // to the user password if not supplied — both control full access.
  ipcMain.handle(
    IpcChannel.QpdfEncrypt,
    async (_e, bytes: ArrayBuffer, userPassword: string, ownerPassword?: string): Promise<ArrayBuffer> => {
      const bin = qpdfBinaryPath();
      if (!bin) throw new Error("qpdf not installed. `brew install qpdf` first.");
      assertQpdfArgSafe(userPassword, "PDF password");
      const effectiveOwnerPassword = ownerPasswordOrRandom(ownerPassword);
      assertQpdfArgSafe(effectiveOwnerPassword, "PDF owner password");
      // Per-invocation tmp dir via mkdtemp: gives a 0700 dir we own, so no
      // symlink races at /tmp. Also keeps the paths tidy in one rm -rf.
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "weavepdf-enc-"));
      const inPath = path.join(tmpDir, "in.pdf");
      const outPath = path.join(tmpDir, "out.pdf");
      await writeFile(inPath, Buffer.from(bytes));
      try {
        await runQpdfWithArgFile(
          bin,
          [
            "--encrypt",
            `--user-password=${userPassword}`,
            `--owner-password=${effectiveOwnerPassword}`,
            "--bits=256",
            "--",
            inPath,
            outPath,
          ],
          "qpdf --encrypt",
          new Set([0, 3]), // 3 = warnings but OK
        );
        const buf = await readFile(outPath);
        return u8ToAb(buf);
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  );

  // ─── DOCX / DOC / RTF → PDF (via textutil + printToPDF) ────────────────
  // macOS's built-in `textutil` converts .docx/.doc/.rtf → HTML. We then load
  // the HTML into a hidden, unsandboxed BrowserWindow with no preload and
  // call printToPDF() to get back PDF bytes. All on-device.
  ipcMain.handle(
    IpcChannel.ConvertDocToPdf,
    async (_e, bytes: ArrayBuffer, filename: string): Promise<ArrayBuffer> => {
      const ext = (filename.split(".").pop() ?? "docx").toLowerCase();
      return withTempDir("weavepdf-doc2pdf-", async (tmpDir) => {
        const inPath = path.join(tmpDir, `input.${ext}`);
        const htmlPath = path.join(tmpDir, "out.html");
        await writeFile(inPath, Buffer.from(bytes));
        // Run textutil. It picks the right format from the extension.
        await new Promise<void>((resolve, reject) => {
          const child = spawn("textutil", ["-convert", "html", "-output", htmlPath, inPath]);
          let stderr = "";
          child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
          child.on("error", reject);
          child.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(stderr.trim() || `textutil exited ${code}`));
          });
        });
        // Spawn a hidden renderer to print-to-PDF. No preload, no IPC
        // surface — just HTML → PDF. Every network / navigation path is
        // denied so a hostile .docx's HTML output can't phone home, read
        // file://, or hijack via meta-refresh.
        const hidden = new BrowserWindow({
          show: false,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            javascript: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            partition: `doc2pdf-${randomUUID()}`,
          },
        });
        const hidSession = hidden.webContents.session;
        hidSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
        // Block every outbound request. The HTML can still reference local
        // images/fonts via file://, which are technically intercepted too —
        // textutil embeds images inline as data: URLs, so this is fine.
        // V1.0020: tightened from prefix-startsWith to exact-equality check
        // on the URL pathname so a malicious HTML can't smuggle
        // `file:///tmp/weavepdf-doc2pdf-XXXX/out.html?../../../etc/passwd`
        // past the filter (the substring check would have accepted it).
        const allowedFileUrl = "file://" + htmlPath;
        hidSession.webRequest.onBeforeRequest((details, cb) => {
          if (details.url.startsWith("data:")) return cb({ cancel: false });
          try {
            const parsed = new URL(details.url);
            // Compare normalised pathname; rejects query/fragment-smuggled paths.
            if (parsed.protocol === "file:" && parsed.pathname === htmlPath && !parsed.search && !parsed.hash) {
              return cb({ cancel: false });
            }
          } catch {
            // Malformed URL → block.
          }
          // Defensive: accept the literal expected URL even if URL parsing
          // changes shape across Electron versions.
          if (details.url === allowedFileUrl) return cb({ cancel: false });
          cb({ cancel: true });
        });
        hidden.webContents.on("will-navigate", (ev) => ev.preventDefault());
        hidden.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        try {
          await hidden.loadFile(htmlPath);
          // Give images + fonts a beat to resolve before printing.
          await new Promise((r) => setTimeout(r, 200));
          const pdf = await hidden.webContents.printToPDF({
            pageSize: "Letter",
            printBackground: true,
            margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
          });
          return u8ToAb(pdf);
        } finally {
          hidden.destroy();
        }
      });
    },
  );

  // Plain text → .docx (via textutil, reverse of the import). Caller extracts
  // text from the PDF with pdf.js, passes the string, we write to a temp
  // .txt, run textutil, read back.
  ipcMain.handle(
    IpcChannel.ConvertTextToDocx,
    async (_e, text: string): Promise<ArrayBuffer> => {
      return withTempDir("weavepdf-docx-", async (tmpDir) => {
        const inPath = path.join(tmpDir, "in.txt");
        const outPath = path.join(tmpDir, "out.docx");
        await writeFile(inPath, text, "utf8");
        await new Promise<void>((resolve, reject) => {
          const child = spawn("textutil", ["-convert", "docx", "-output", outPath, inPath]);
          let stderr = "";
          child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
          child.on("error", reject);
          child.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(stderr.trim() || `textutil exited ${code}`));
          });
        });
        const buf = await readFile(outPath);
        return u8ToAb(buf);
      });
    },
  );

  // ─── Ghostscript (heavy compression) ──────────────────────────────────
  const gsBinaryPath = (): string | null => {
    const candidates = ["/opt/homebrew/bin/gs", "/usr/local/bin/gs", "/usr/bin/gs"];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return null;
  };

  ipcMain.handle(IpcChannel.GhostscriptAvailable, async (): Promise<boolean> => {
    return gsBinaryPath() !== null;
  });

  ipcMain.handle(
    IpcChannel.GhostscriptCompress,
    async (
      _e,
      bytes: ArrayBuffer,
      quality: "screen" | "ebook" | "printer" | "prepress",
    ): Promise<ArrayBuffer> => {
      const bin = gsBinaryPath();
      if (!bin) {
        throw new Error("Ghostscript not installed. `brew install ghostscript` first.");
      }
      return withTempDir("weavepdf-gs-", async (tmpDir) => {
        const inPath = path.join(tmpDir, "in.pdf");
        const outPath = path.join(tmpDir, "out.pdf");
        await writeFile(inPath, Buffer.from(bytes));
        await new Promise<void>((resolve, reject) => {
          const args = [
            "-sDEVICE=pdfwrite",
            "-dCompatibilityLevel=1.4",
            `-dPDFSETTINGS=/${quality}`,
            "-dNOPAUSE",
            "-dQUIET",
            "-dBATCH",
            `-sOutputFile=${outPath}`,
            inPath,
          ];
          const child = spawn(bin, args);
          let stderr = "";
          child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
          child.on("error", reject);
          child.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(stderr.trim() || `gs exited ${code}`));
          });
        });
        const buf = await readFile(outPath);
        return u8ToAb(buf);
      });
    },
  );

  // Custom-tuned Ghostscript compression: explicit DPI per content type plus
  // JPEG quality control. The user dials it in via the CompressModal Custom
  // tab. Math: /QFactor in [0.05..1.5] inversely correlates with quality;
  // standard mappings: 100 → 0.05, 90 → 0.15, 75 → 0.4, 50 → 0.76, 30 → 1.3.
  ipcMain.handle(
    IpcChannel.GhostscriptCompressAdvanced,
    async (
      _e,
      bytes: ArrayBuffer,
      opts: {
        colorDpi: number;
        grayDpi: number;
        monoDpi: number;
        jpegQuality: number; // 0..100
        compatibility?: "1.4" | "1.5" | "1.6" | "1.7";
      },
    ): Promise<ArrayBuffer> => {
      const bin = gsBinaryPath();
      if (!bin) {
        throw new Error("Ghostscript not installed. `brew install ghostscript` first.");
      }
      const compat = opts.compatibility ?? "1.6";
      // Quality → QFactor curve. 0.05 = effectively lossless; 1.5 = visibly
      // blurred. Anchored at: 100→0.06, 90→0.15, 75→0.40, 50→0.76, 25→1.3.
      const q = Math.max(1, Math.min(100, opts.jpegQuality));
      const qFactor = q >= 100
        ? 0.06
        : q >= 90
          ? 0.15
          : q >= 75
            ? 0.4
            : q >= 50
              ? 0.76
              : 1.3;
      return withTempDir("weavepdf-gs-adv-", async (tmpDir) => {
        const inPath = path.join(tmpDir, "in.pdf");
        const outPath = path.join(tmpDir, "out.pdf");
        await writeFile(inPath, Buffer.from(bytes));
        // V1.0030: gs 10.x stopped accepting `-dColorImageDict=<</QFactor.../>>`
        // as a command-line arg ("Invalid value for option, -dNAME= must be
        // followed by a valid token"). The 9.x syntax was undocumented and
        // is now rejected. Modern gs documents passing the dict via inline
        // PostScript with `-c "<<...>> setdistillerparams" -f input.pdf` —
        // verified working on gs 10.07 (default current homebrew version)
        // and back-compatible with 9.x.
        const dict =
          `<<` +
          `/ColorImageDict <</QFactor ${qFactor.toFixed(2)} /HSamples [2 1 1 2] /VSamples [2 1 1 2]>>` +
          `/GrayImageDict <</QFactor ${qFactor.toFixed(2)} /HSamples [2 1 1 2] /VSamples [2 1 1 2]>>` +
          `>> setdistillerparams`;
        await new Promise<void>((resolve, reject) => {
          const args = [
            "-sDEVICE=pdfwrite",
            `-dCompatibilityLevel=${compat}`,
            "-dNOPAUSE",
            "-dQUIET",
            "-dBATCH",
            "-dPDFSETTINGS=/default",
            "-dEmbedAllFonts=true",
            "-dSubsetFonts=true",
            "-dCompressFonts=true",
            "-dDetectDuplicateImages=true",
            // Color images (DPI + filter; QFactor comes from inline PS dict)
            "-dDownsampleColorImages=true",
            "-dColorImageDownsampleType=/Bicubic",
            `-dColorImageResolution=${Math.max(36, Math.min(600, opts.colorDpi | 0))}`,
            "-dAutoFilterColorImages=false",
            "-dColorImageFilter=/DCTEncode",
            // Gray images
            "-dDownsampleGrayImages=true",
            "-dGrayImageDownsampleType=/Bicubic",
            `-dGrayImageResolution=${Math.max(36, Math.min(600, opts.grayDpi | 0))}`,
            "-dAutoFilterGrayImages=false",
            "-dGrayImageFilter=/DCTEncode",
            // Monochrome / line art
            "-dDownsampleMonoImages=true",
            "-dMonoImageDownsampleType=/Subsample",
            `-dMonoImageResolution=${Math.max(72, Math.min(1200, opts.monoDpi | 0))}`,
            "-dEncodeMonoImages=true",
            "-dMonoImageFilter=/CCITTFaxEncode",
            `-sOutputFile=${outPath}`,
            // Inline PostScript distiller params, then run the input.
            "-c",
            dict,
            "-f",
            inPath,
          ];
          const child = spawn(bin, args);
          let stderr = "";
          child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
          child.on("error", reject);
          child.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(stderr.trim() || `gs exited ${code}`));
          });
        });
        const buf = await readFile(outPath);
        return u8ToAb(buf);
      });
    },
  );

  // qpdf lossless re-pack: object stream generation + stream recompression
  // + linearization for fast-web-view. Always safe — no image touching, no
  // font loss. Typical 5-15% reduction on already-modern PDFs, more on
  // documents authored by older tools.
  ipcMain.handle(
    IpcChannel.QpdfCompress,
    async (_e, bytes: ArrayBuffer): Promise<ArrayBuffer> => {
      const bin = qpdfBinaryPath();
      if (!bin) {
        throw new Error("qpdf not installed. Run `brew install qpdf` first.");
      }
      return withTempDir("weavepdf-qpdf-c-", async (tmpDir) => {
        const inPath = path.join(tmpDir, "in.pdf");
        const outPath = path.join(tmpDir, "out.pdf");
        await writeFile(inPath, Buffer.from(bytes));
        await new Promise<void>((resolve, reject) => {
          const args = [
            "--object-streams=generate",
            "--stream-data=compress",
            "--compress-streams=y",
            "--linearize",
            "--",
            inPath,
            outPath,
          ];
          const child = spawn(bin, args);
          let stderr = "";
          child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
          child.on("error", reject);
          child.on("exit", (code) => {
            // qpdf exit code 3 = warnings (still produced output OK)
            if (code === 0 || code === 3) resolve();
            else reject(new Error(stderr.trim() || `qpdf exited ${code}`));
          });
        });
        const buf = await readFile(outPath);
        return u8ToAb(buf);
      });
    },
  );

  // mutool clean -gggz: aggressive lossless cleanup from MuPDF. Each extra
  // -g pass is more thorough garbage collection (object dedup, unused removal,
  // sub-pixel cleanup). -z recompresses streams. Often beats qpdf on
  // text-heavy documents and PDFs with form-overlay redundancy.
  const mutoolBinaryPath = (): string | null => {
    const candidates = ["/opt/homebrew/bin/mutool", "/usr/local/bin/mutool", "/usr/bin/mutool"];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return null;
  };

  ipcMain.handle(IpcChannel.MutoolAvailable, async (): Promise<boolean> => {
    return mutoolBinaryPath() !== null;
  });

  ipcMain.handle(
    IpcChannel.MutoolClean,
    async (_e, bytes: ArrayBuffer): Promise<ArrayBuffer> => {
      const bin = mutoolBinaryPath();
      if (!bin) {
        throw new Error("mutool not installed. Run `brew install mupdf-tools` first.");
      }
      return withTempDir("weavepdf-mutool-", async (tmpDir) => {
        const inPath = path.join(tmpDir, "in.pdf");
        const outPath = path.join(tmpDir, "out.pdf");
        await writeFile(inPath, Buffer.from(bytes));
        await new Promise<void>((resolve, reject) => {
          // -gggz: g=garbage collect (3x = most aggressive), z=compress streams
          const args = ["clean", "-gggz", inPath, outPath];
          const child = spawn(bin, args);
          let stderr = "";
          child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
          child.on("error", reject);
          child.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(stderr.trim() || `mutool exited ${code}`));
          });
        });
        const buf = await readFile(outPath);
        return u8ToAb(buf);
      });
    },
  );

  ipcMain.handle(
    IpcChannel.QpdfDecrypt,
    async (_e, encryptedBytes: ArrayBuffer, password: string): Promise<ArrayBuffer> => {
      const bin = qpdfBinaryPath();
      if (!bin) {
        throw new Error("qpdf not installed. Run `brew install qpdf` to enable password unlock.");
      }
      return withTempDir("weavepdf-dec-", async (tmpDir) => {
        const inPath = path.join(tmpDir, "in.pdf");
        const outPath = path.join(tmpDir, "out.pdf");
        await writeFile(inPath, Buffer.from(encryptedBytes));
        await new Promise<void>((resolve, reject) => {
          // Password via stdin so it never appears in `ps aux`; `--` ends
          // option parsing so malicious paths starting with `-` or `@`
          // (qpdf command-file syntax) can't smuggle in flags.
          const args = ["--password-file=-", "--decrypt", "--", inPath, outPath];
          const child = spawn(bin, args);
          child.stdin.end(password + "\n");
          let stderr = "";
          child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
          child.on("error", reject);
          child.on("exit", (code) => {
            if (code === 0) resolve();
            // qpdf exit codes: 2 = invalid password, 3 = warnings (still OK-ish)
            else if (code === 2) reject(new Error("Incorrect password"));
            else reject(new Error(stderr.trim() || `qpdf exited ${code}`));
          });
        });
        const buf = await readFile(outPath);
        return u8ToAb(buf);
      });
    },
  );

  // ─── Apple Intelligence (Foundation Models) ─────────────────────────
  // Swift helper compiled against the full Xcode SDK. Spawned per call with
  // the input text in a tempfile (keeps large documents out of the argv
  // length limit and out of `ps aux`). Returns JSON { ok, text }.
  const aiBinaryPath = (): string => {
    const resourcesRoot = app.isPackaged
      ? path.join(process.resourcesPath, "resources")
      : path.join(__dirname, "..", "..", "resources");
    return path.join(resourcesRoot, "helpers", "ai-bin");
  };

  ipcMain.handle(IpcChannel.AiAvailable, async (): Promise<boolean> => {
    return existsSync(aiBinaryPath());
  });

  ipcMain.handle(
    IpcChannel.AiRun,
    async (
      _e,
      mode: "summarize" | "qa" | "rewrite",
      text: string,
      extra?: string,
    ): Promise<string> => {
      const bin = aiBinaryPath();
      if (!existsSync(bin)) {
        throw new Error(
          "AI helper not built. Run `node scripts/build-ai.mjs` (requires full Xcode).",
        );
      }
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "weavepdf-ai-"));
      const textPath = path.join(tmpDir, "in.txt");
      const extraPath = path.join(tmpDir, "extra.txt");
      await writeFile(textPath, text, "utf8");
      if (extra) await writeFile(extraPath, extra, "utf8");
      try {
        const args = extra
          ? [mode, textPath, "--extra-file", extraPath]
          : [mode, textPath];
        const json = await new Promise<string>((resolve, reject) => {
          const child = spawn(bin, args);
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
          child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
          child.on("error", reject);
          child.on("exit", (code) => {
            if (code === 0) resolve(stdout);
            else reject(new Error(stderr.trim() || `ai-bin exited ${code}`));
          });
        });
        const parsed = JSON.parse(json) as { ok: boolean; text: string };
        if (!parsed.ok) throw new Error("AI returned ok=false");
        return parsed.text;
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  );

  ipcMain.handle(IpcChannel.OcrRunImage, async (_e, pngBytes: ArrayBuffer): Promise<OcrBox[]> => {
    const bin = ocrBinaryPath();
    if (!existsSync(bin)) {
      throw new Error("OCR helper not built. Run `node scripts/build-ocr.mjs` to compile the Swift binary.");
    }
    // Vision needs a file path — write PNG to a tempfile, spawn the helper,
    // parse JSON, clean up. Keep the tempfile per-call to stay re-entrant safe.
    return withTempDir("weavepdf-ocr-", async (tmpDir) => {
      const tmp = path.join(tmpDir, "page.png");
      await writeFile(tmp, Buffer.from(pngBytes));
      const json = await new Promise<string>((resolve, reject) => {
        const child = spawn(bin, [tmp]);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
        child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code !== 0) reject(new Error(stderr.trim() || `ocr-bin exited ${code}`));
          else resolve(stdout);
        });
      });
      const parsed = JSON.parse(json) as OcrBox[];
      return parsed;
    });
  });
}

function broadcastTheme(): void {
  const theme: AppTheme = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(IpcChannel.ThemeUpdated, theme);
  }
}

function sendMenuCommand(cmd: MenuCommand): void {
  // Multi-window: every menu command targets the currently-focused window.
  // The user clicks a menu item while window B is on top → command goes to B.
  getActiveWindow()?.webContents.send(IpcChannel.MenuCommand, cmd);
}

// ─── Update check ────────────────────────────────────────────────────────
// Polls GitHub Releases for the latest published WeavePDF tag and compares
// against the running app's package.json version. Manual mode (Help → Check
// for Updates…) shows a dialog regardless of result. Auto mode (silent
// startup poll) only surfaces a dialog when a new version is available, so
// it never bothers the user when they're up-to-date.
//
// Why no electron-updater / Squirrel.Mac: those require an Apple-CA-anchored
// Developer ID signature for the auto-install verification step. We sign with
// a self-signed local cert, so silent auto-install isn't reachable. Manual
// "click to download the new DMG" is the right fit for the current beta.
const UPDATE_REPO_OWNER = "adamhayat";
const UPDATE_REPO_NAME = "WeavePDF";
const UPDATE_USER_AGENT = `WeavePDF/${app.getVersion()} (+https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME})`;

type ReleaseInfo = { tag: string; htmlUrl: string; name: string; body: string };

function compareSemver(a: string, b: string): number {
  // Returns -1 if a<b, 0 if equal, 1 if a>b. Tolerates leading 'v' and any
  // pre-release suffix (we don't ship pre-releases yet — pre-release suffix
  // makes the version sort LOWER than the same numeric without a suffix).
  const norm = (s: string) => s.replace(/^v/i, "").trim();
  const [aNum, aPre] = norm(a).split("-", 2);
  const [bNum, bPre] = norm(b).split("-", 2);
  const aParts = aNum.split(".").map((n) => Number(n) || 0);
  const bParts = bNum.split(".").map((n) => Number(n) || 0);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const x = aParts[i] ?? 0;
    const y = bParts[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  // Pre-release < release (e.g. 1.0.0-rc1 < 1.0.0).
  if (aPre && !bPre) return -1;
  if (!aPre && bPre) return 1;
  if (aPre && bPre) return aPre < bPre ? -1 : aPre > bPre ? 1 : 0;
  return 0;
}

async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  const url = `https://api.github.com/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases/latest`;
  // V1.0020: 10s timeout. Without this, a slow/hung GitHub request leaves
  // the silent startup poll dangling forever and a manual "Check for
  // Updates" never resolves.
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": UPDATE_USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // 404 = no releases yet (repo is fresh). Treat as "no update available"
    // rather than an error so first-time runs against an empty repo don't
    // surface a confusing dialog.
    if (res.status === 404) return null;
    throw new Error(`GitHub API ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as {
    tag_name?: string;
    html_url?: string;
    name?: string;
    body?: string;
    draft?: boolean;
    prerelease?: boolean;
  };
  if (json.draft || json.prerelease) return null;
  if (!json.tag_name || !json.html_url) return null;
  // V1.0020: belt-and-braces. We control the repo, so a hostile html_url
  // shouldn't appear, but if a future GitHub response drift includes a
  // redirect-style html_url field, we don't want to launch the user's
  // browser at an arbitrary host. Verify the host looks like GitHub.
  let htmlHost: string;
  try {
    htmlHost = new URL(json.html_url).hostname;
  } catch {
    return null;
  }
  if (htmlHost !== "github.com" && !htmlHost.endsWith(".github.com")) {
    return null;
  }
  return {
    tag: json.tag_name,
    htmlUrl: json.html_url,
    name: json.name || json.tag_name,
    body: json.body || "",
  };
}

async function checkForUpdatesAndNotify(opts: { silentIfUpToDate: boolean }): Promise<void> {
  const current = app.getVersion();
  let latest: ReleaseInfo | null = null;
  try {
    latest = await fetchLatestRelease();
  } catch (err) {
    if (!opts.silentIfUpToDate) {
      const target = getActiveWindow();
      const message = err instanceof Error ? err.message : String(err);
      if (target) {
        await dialog.showMessageBox(target, {
          type: "warning",
          message: "Couldn’t check for updates",
          detail: `Couldn’t reach GitHub. Check your internet connection and try again.\n\n${message}`,
          buttons: ["OK"],
          defaultId: 0,
        });
      }
    }
    return;
  }

  // No releases published yet, or only drafts/prereleases → treat as up-to-date.
  if (!latest) {
    if (!opts.silentIfUpToDate) {
      const target = getActiveWindow();
      if (target) {
        await dialog.showMessageBox(target, {
          type: "info",
          message: "WeavePDF is up to date",
          detail: `You're running V${formatDisplayVersion(current)}. No published releases on GitHub yet.`,
          buttons: ["OK"],
          defaultId: 0,
        });
      }
    }
    return;
  }

  const cmp = compareSemver(latest.tag, current);
  if (cmp <= 0) {
    if (!opts.silentIfUpToDate) {
      const target = getActiveWindow();
      if (target) {
        await dialog.showMessageBox(target, {
          type: "info",
          message: "WeavePDF is up to date",
          detail: `V${formatDisplayVersion(current)} is the latest version.`,
          buttons: ["OK"],
          defaultId: 0,
        });
      }
    }
    return;
  }

  // A newer release is available. Show the dialog regardless of mode.
  const target = getActiveWindow();
  if (!target) return;
  // Trim release notes to keep the dialog from ballooning. Most CHANGELOG
  // entries we paste in are dense; first ~600 chars conveys the gist.
  const notes = latest.body.length > 600 ? latest.body.slice(0, 600) + "…" : latest.body;
  const result = await dialog.showMessageBox(target, {
    type: "info",
    message: `WeavePDF ${latest.name} is available`,
    detail: `You're running V${formatDisplayVersion(current)}.\n\n${notes || "Open the release page on GitHub to download the new DMG."}`,
    buttons: ["Download", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (result.response === 0) {
    void shell.openExternal(latest.htmlUrl);
  }
}

function formatDisplayVersion(semver: string): string {
  // Mirrors the renderer's formatter — `1.0.18` → `1.0018`.
  const parts = semver.replace(/^v/i, "").split(".");
  const major = parts[0] ?? "1";
  const minor = parts[1] ?? "0";
  const patch = (parts[2] ?? "0").padStart(4, "0");
  return `${major}.${minor}${patch}`;
}

function buildAppMenu(): void {
  const isMac = process.platform === "darwin";
  const m = (cmd: MenuCommand) => () => sendMenuCommand(cmd);

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { label: "Enable Right Click Options…", click: m("showWelcomeFinder") },
              // V1.0030: removed `{ role: "services" }` from the app menu.
              // Services entries are macOS system-wide actions other apps
              // register (e.g. Activity Monitor, Allocations & Leaks). They
              // confused the user — they're not "WeavePDF background
              // services" and we don't add any of our own. Hidden to keep
              // our menu intentional.
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        // Chrome convention: ⌘T = new tab, ⌘N = new window.
        // ⌘T opens the file picker and adds the chosen PDF as a new tab in
        // the active window — there's no "blank tab" concept since a tab
        // without content has no meaning in a PDF editor. ⌘O is a long-
        // standing alias for the same flow.
        { label: "New Tab…", accelerator: "CmdOrCtrl+T", click: m("newTab") },
        // ⌘N creates a fresh BrowserWindow with its own renderer + independent
        // tab list. Matches Chrome / Safari / most browsers.
        { label: "New Window", accelerator: "CmdOrCtrl+N", click: () => createMainWindow() },
        { type: "separator" },
        { label: "Open…", accelerator: "CmdOrCtrl+O", click: m("open") },
        { type: "separator" },
        { label: "Save", accelerator: "CmdOrCtrl+S", click: m("save") },
        { label: "Save As…", accelerator: "Shift+CmdOrCtrl+S", click: m("saveAs") },
        { label: "Export Combined PDF…", accelerator: "CmdOrCtrl+E", click: m("export") },
        { type: "separator" },
        { label: "Print…", accelerator: "CmdOrCtrl+P", click: m("print") },
        { type: "separator" },
        // V1.0030: ⌘W now closes the active TAB (renderer-side). Falls
        // through to closing the window when only one tab exists. ⌘Q in
        // the WeavePDF menu remains the canonical "close app" action.
        // Replaces the previous `role: "close"` (which was labeled
        // "Close Window" and macOS Option-toggled to "Close All").
        { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: m("closeTab") },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", accelerator: "CmdOrCtrl+Z", click: m("undo") },
        { label: "Redo", accelerator: "Shift+CmdOrCtrl+Z", click: m("redo") },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { type: "separator" },
        { label: "Select All Pages", accelerator: "CmdOrCtrl+A", click: m("selectAllPages") },
        { label: "Find in Document…", accelerator: "CmdOrCtrl+F", click: m("search") },
      ],
    },
    {
      label: "Tools",
      submenu: [
        { label: "Add Text", click: m("addText") },
        { label: "Signature…", click: m("signature") },
        { label: "Highlight", click: m("highlight") },
        { label: "Whiteout", click: m("whiteout") },
        { type: "separator" },
        {
          label: "Shapes",
          submenu: [
            { label: "Rectangle", click: m("shapeRect") },
            { label: "Ellipse", click: m("shapeCircle") },
            { label: "Line", click: m("shapeLine") },
            { label: "Arrow", click: m("shapeArrow") },
            { type: "separator" },
            { label: "Freehand Draw", click: m("draw") },
          ],
        },
        { type: "separator" },
        {
          label: "Pages",
          submenu: [
            { label: "Rotate Left", accelerator: "CmdOrCtrl+[", click: m("rotateLeft") },
            { label: "Rotate Right", accelerator: "CmdOrCtrl+]", click: m("rotateRight") },
            { label: "Rotate 180°", accelerator: "Shift+CmdOrCtrl+]", click: m("rotate180") },
            { type: "separator" },
            { label: "Delete Selected Pages", accelerator: "Backspace", click: m("deletePages") },
            { label: "Extract Pages…", accelerator: "Alt+CmdOrCtrl+E", click: m("extractPages") },
          ],
        },
        { type: "separator" },
        { label: "Compress…", accelerator: "Alt+CmdOrCtrl+C", click: m("compress") },
        { label: "Add Watermark…", accelerator: "Alt+CmdOrCtrl+W", click: m("watermark") },
        { label: "Document Properties…", accelerator: "CmdOrCtrl+I", click: m("metadata") },
        { type: "separator" },
        { label: "Command Palette…", accelerator: "CmdOrCtrl+K", click: m("palette") },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: m("zoomIn") },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: m("zoomOut") },
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: m("zoomReset") },
        { type: "separator" },
        { label: "Next Page", accelerator: "Right", click: m("nextPage") },
        { label: "Previous Page", accelerator: "Left", click: m("prevPage") },
        { type: "separator" },
        { label: "Toggle Sidebar", accelerator: "CmdOrCtrl+B", click: m("toggleSidebar") },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac ? [{ type: "separator" as const }, { role: "front" as const }] : []),
      ],
    },
    {
      label: "Help",
      submenu: [
        { label: "Welcome to WeavePDF…", click: m("showWelcome") },
        {
          label: "Check for Updates…",
          click: () => {
            void checkForUpdatesAndNotify({ silentIfUpToDate: false });
          },
        },
        { type: "separator" },
        { label: "Keyboard Shortcuts…", accelerator: "CmdOrCtrl+/", click: m("keyboardShortcuts") },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── CLI mode ─────────────────────────────────────────────────────────────
// When launched with `--cli <op> <args...>` we skip the GUI entirely, run
// the op against pdf-lib, and exit. Powers Finder Quick Actions and Shortcuts.
//
// Ops supported (add more as needed):
//   --cli compress       <in> <out>
//   --cli merge          <in1.pdf|image> ... <inN.pdf|image> <out.pdf>
//   --cli rotate         <in> <out> <90|180|270>
//   --cli extract-first  <in> <out>
//   --cli extract-range  <in> <out> <startPage> <endPage>
//   --cli encrypt        <in> <out> <password|->   (- reads first stdin line)

const cliIdx = process.argv.indexOf("--cli");
const isCliMode = cliIdx !== -1;

async function runCli(args: string[]): Promise<number> {
  const { PDFDocument, degrees } = await import("pdf-lib");
  const [op, ...rest] = args;
  if (!op) {
    console.error("weavepdf --cli <op> <args...>");
    console.error(
      "ops: compress, merge, rotate, extract-first, extract-range, watermark, encrypt, decrypt, image-to-pdf",
    );
    return 2;
  }
  const loadPdf = async (p: string) => {
    const b = await readFile(p);
    return PDFDocument.load(b, { ignoreEncryption: true, updateMetadata: false });
  };
  const saveTo = async (doc: import("pdf-lib").PDFDocument, p: string, opts?: Parameters<import("pdf-lib").PDFDocument["save"]>[0]) => {
    const out = await doc.save(opts);
    await writeFile(p, Buffer.from(out));
  };
  const qpdfBinaryPath = (): string | null => {
    const candidates = [
      "/opt/homebrew/bin/qpdf",
      "/usr/local/bin/qpdf",
      "/usr/bin/qpdf",
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return null;
  };
  const directImageExtensions = new Set(["jpg", "jpeg", "png"]);
  const transcodableImageExtensions = new Set(["heic", "heif", "gif", "tif", "tiff", "bmp", "webp"]);
  const supportedImageExtensions = new Set([...directImageExtensions, ...transcodableImageExtensions]);
  const extensionOf = (p: string) => path.extname(p).replace(/^\./, "").toLowerCase();
  const loadImageBytesForPdf = async (input: string): Promise<{ bytes: Buffer; isPng: boolean }> => {
    const ext = extensionOf(input);
    // pdf-lib only natively embeds PNG + JPEG. For every other common image
    // format, shell out to macOS's built-in `sips` to transcode to JPEG in a
    // tempfile first. Covers HEIC/HEIF/GIF/TIFF/BMP/WebP with no extra deps.
    if (directImageExtensions.has(ext)) {
      return {
        bytes: await readFile(input),
        isPng: ext === "png",
      };
    }
    if (transcodableImageExtensions.has(ext)) {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "weavepdf-img2pdf-"));
      const tmpJpg = path.join(tmpDir, "converted.jpg");
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn("sips", ["-s", "format", "jpeg", input, "--out", tmpJpg]);
          let stderr = "";
          child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
          child.stdout.on("data", () => {});
          child.on("error", reject);
          child.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(stderr.trim() || `sips exited ${code}`));
          });
        });
        return { bytes: await readFile(tmpJpg), isPng: false };
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    throw new Error(`unsupported image extension .${ext || "(none)"}`);
  };
  const addImagePage = async (doc: import("pdf-lib").PDFDocument, input: string) => {
    const { bytes, isPng } = await loadImageBytesForPdf(input);
    const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    // Fit inside US Letter with 36pt margin, preserve aspect.
    const pageW = 612;
    const pageH = 792;
    const margin = 36;
    const maxW = pageW - margin * 2;
    const maxH = pageH - margin * 2;
    let w = img.width;
    let h = img.height;
    const scale = Math.min(maxW / w, maxH / h, 1);
    w *= scale;
    h *= scale;
    const page = doc.addPage([pageW, pageH]);
    // Top-align: horizontally centered, pinned to the top margin. Matches
    // what users expect when converting a narrow screenshot — the image
    // sits at the top of a US Letter page rather than floating in the
    // middle of a mostly-blank page.
    page.drawImage(img, {
      x: (pageW - w) / 2,
      y: pageH - margin - h,
      width: w,
      height: h,
    });
  };
  const appendMergeInput = async (outDoc: import("pdf-lib").PDFDocument, input: string) => {
    const ext = extensionOf(input);
    if (ext === "pdf") {
      const src = await loadPdf(input);
      const copied = await outDoc.copyPages(src, src.getPageIndices());
      for (const page of copied) outDoc.addPage(page);
      return;
    }
    if (supportedImageExtensions.has(ext)) {
      await addImagePage(outDoc, input);
      return;
    }
    throw new Error(`merge: unsupported input .${ext || "(none)"}; use PDFs or images`);
  };
  const mergeWithQpdf = async (inputs: string[], output: string): Promise<boolean> => {
    const bin = qpdfBinaryPath();
    if (!bin) return false;
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "weavepdf-qpdf-merge-"));
    try {
      const pdfParts: string[] = [];
      for (const [idx, input] of inputs.entries()) {
        const ext = extensionOf(input);
        if (ext === "pdf") {
          pdfParts.push(input);
        } else if (supportedImageExtensions.has(ext)) {
          const imagePdf = path.join(tmpDir, `image-${idx + 1}.pdf`);
          const imageDoc = await PDFDocument.create();
          await addImagePage(imageDoc, input);
          await saveTo(imageDoc, imagePdf);
          pdfParts.push(imagePdf);
        } else {
          throw new Error(`merge: unsupported input .${ext || "(none)"}; use PDFs or images`);
        }
      }
      await new Promise<void>((resolve, reject) => {
        // qpdf is more tolerant than pdf-lib's object copier for real-world
        // PDFs with dangling annotation/form/structure references. Use it as
        // the first merge path when present; no sensitive args here, so a
        // normal argv array safely preserves paths with spaces.
        const args = ["--warning-exit-0", "--empty", "--pages", ...pdfParts, "--", output];
        const child = spawn(bin, args);
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
        child.stdout.on("data", () => {});
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0 || code === 3) resolve();
          else reject(new Error(stderr.trim() || `qpdf merge exited ${code}`));
        });
      });
      return true;
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  if (op === "compress") {
    const [input, output] = rest;
    if (!input || !output) return fail("compress <in> <out>");

    // Try Ghostscript first — it actually shrinks PDFs (image re-sampling at
    // 150 DPI, JPEG re-encode, font subsetting). pdf-lib's object-streams
    // pass is nearly a no-op on PDFs that are already linearized, which the
    // user reported as "compress made a duplicate without shrinking it".
    //
    // Output goes to a temp file to keep input == output safe (the
    // weavepdf:// right-click handler passes input as both, for in-place
    // overwrite). Promote to final only if gs actually produced a smaller
    // file — replacing a small PDF with a larger gs output is worse than
    // doing nothing.
    const gsCandidates = ["/opt/homebrew/bin/gs", "/usr/local/bin/gs", "/usr/bin/gs"];
    const gs = gsCandidates.find((p) => existsSync(p)) ?? null;
    if (gs) {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "weavepdf-cli-compress-"));
      const tmpOut = path.join(tmpDir, "out.pdf");
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(gs, [
            "-sDEVICE=pdfwrite",
            "-dCompatibilityLevel=1.4",
            "-dPDFSETTINGS=/ebook",
            "-dNOPAUSE",
            "-dQUIET",
            "-dBATCH",
            `-sOutputFile=${tmpOut}`,
            input,
          ]);
          let stderr = "";
          child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
          child.on("error", reject);
          child.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(stderr.trim() || `gs exited ${code}`));
          });
        });
        const inSize = (await stat(input)).size;
        const outSize = (await stat(tmpOut)).size;
        if (outSize < inSize) {
          // Atomic move into place. Works whether output == input or not.
          await writeFile(output, await readFile(tmpOut));
          await rm(tmpDir, { recursive: true, force: true });
          return 0;
        }
        // Already optimized — don't replace the original with a same-or-larger
        // file. Fall through to copy-original-bytes behaviour so callers can
        // still trust that `output` exists when we return 0.
        if (input !== output) {
          await writeFile(output, await readFile(input));
        }
        await rm(tmpDir, { recursive: true, force: true });
        console.error(`compress: ${input} is already optimized (${inSize} → ${outSize}); kept original`);
        return 0;
      } catch (err) {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        console.error(`gs compression failed, falling back to pdf-lib: ${err instanceof Error ? err.message : String(err)}`);
        // Fall through.
      }
    }

    // Fallback: pdf-lib object-stream pass. Mostly a no-op on optimized PDFs;
    // this is the path users without ghostscript hit. Use temp+move so input
    // and output can be the same path.
    const doc = await loadPdf(input);
    if (input === output) {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "weavepdf-cli-compress-fb-"));
      const tmpOut = path.join(tmpDir, "out.pdf");
      try {
        await saveTo(doc, tmpOut, { useObjectStreams: true });
        await writeFile(output, await readFile(tmpOut));
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    } else {
      await saveTo(doc, output, { useObjectStreams: true });
    }
    return 0;
  }

  if (op === "merge") {
    if (rest.length < 3) return fail("merge <in1> <in2> ... <out>");
    const output = rest[rest.length - 1];
    const inputs = rest.slice(0, -1);
    try {
      const merged = await mergeWithQpdf(inputs, output);
      if (merged) return 0;
    } catch (err) {
      console.error(`qpdf merge failed; trying pdf-lib fallback: ${err instanceof Error ? err.message : String(err)}`);
    }
    const outDoc = await PDFDocument.create();
    for (const p of inputs) {
      await appendMergeInput(outDoc, p);
    }
    await saveTo(outDoc, output);
    return 0;
  }

  if (op === "rotate") {
    const [input, output, deg] = rest;
    if (!input || !output || !deg) return fail("rotate <in> <out> <90|180|270>");
    const d = parseInt(deg, 10);
    if (![90, 180, 270, -90].includes(d)) return fail("rotate: degrees must be 90, 180, or 270");
    const doc = await loadPdf(input);
    for (const page of doc.getPages()) {
      const current = page.getRotation().angle;
      page.setRotation(degrees((((current + d) % 360) + 360) % 360));
    }
    await saveTo(doc, output);
    return 0;
  }

  if (op === "extract-first") {
    const [input, output] = rest;
    if (!input || !output) return fail("extract-first <in> <out>");
    const src = await loadPdf(input);
    const out = await PDFDocument.create();
    const [first] = await out.copyPages(src, [0]);
    out.addPage(first);
    await saveTo(out, output);
    return 0;
  }

  if (op === "extract-range") {
    const [input, output, s, e] = rest;
    if (!input || !output || !s || !e) return fail("extract-range <in> <out> <startPage> <endPage>");
    const start = parseInt(s, 10);
    const end = parseInt(e, 10);
    const src = await loadPdf(input);
    const total = src.getPageCount();
    if (!(start >= 1 && end >= start && end <= total)) return fail(`range out of bounds (1..${total})`);
    const indices: number[] = [];
    for (let i = start; i <= end; i++) indices.push(i - 1);
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, indices);
    for (const p of copied) out.addPage(p);
    await saveTo(out, output);
    return 0;
  }

  if (op === "watermark") {
    const [input, output, text] = rest;
    if (!input || !output || !text) return fail("watermark <in> <out> <text>");
    const { StandardFonts: SF, rgb: rgbFn, degrees: degFn } = await import("pdf-lib");
    const doc = await loadPdf(input);
    const font = await doc.embedFont(SF.HelveticaBold);
    const rotation = 45;
    const rad = (rotation * Math.PI) / 180;
    for (const page of doc.getPages()) {
      const { width, height } = page.getSize();
      const fontSize = Math.min(width, height) * 0.12;
      const textWidth = font.widthOfTextAtSize(text, fontSize);
      const halfW = textWidth / 2;
      const halfH = fontSize * 0.35;
      const x = width / 2 - halfW * Math.cos(rad) + halfH * Math.sin(rad);
      const y = height / 2 - halfW * Math.sin(rad) - halfH * Math.cos(rad);
      page.drawText(text, {
        x, y, size: fontSize, font,
        color: rgbFn(0.7, 0.1, 0.1),
        opacity: 0.2,
        rotate: degFn(rotation),
      });
    }
    await saveTo(doc, output);
    return 0;
  }

  if (op === "encrypt") {
    const [input, output, passwordArg] = rest;
    if (!input || !output || !passwordArg) return fail("encrypt <in> <out> <password|->");
    const password = passwordArg === "-"
      ? readFileSync(0, "utf8").split(/\r?\n/, 1)[0] ?? ""
      : passwordArg;
    if (!password) return fail("encrypt: password cannot be empty");
    assertQpdfArgSafe(password, "PDF password");
    const ownerPassword = ownerPasswordOrRandom(undefined);
    const bin = ["/opt/homebrew/bin/qpdf", "/usr/local/bin/qpdf", "/usr/bin/qpdf"].find((p) => existsSync(p));
    if (!bin) return fail("qpdf not installed. `brew install qpdf` first.");
    await runQpdfWithArgFile(
      bin,
      [
        "--encrypt",
        `--user-password=${password}`,
        `--owner-password=${ownerPassword}`,
        "--bits=256",
        "--",
        input,
        output,
      ],
      "qpdf --encrypt",
      new Set([0, 3]),
    );
    return 0;
  }

  if (op === "image-to-pdf") {
    const [input, output] = rest;
    if (!input || !output) return fail("image-to-pdf <in-image> <out.pdf>");
    const ext = extensionOf(input);
    if (!supportedImageExtensions.has(ext)) {
      return fail(`image-to-pdf: unsupported extension .${ext}`);
    }
    const out = await PDFDocument.create();
    await addImagePage(out, input);
    await saveTo(out, output);
    return 0;
  }

  if (op === "decrypt") {
    const [input, output, passwordArg] = rest;
    if (!input || !output || !passwordArg) return fail("decrypt <in> <out> <password|->");
    const bin = ["/opt/homebrew/bin/qpdf", "/usr/local/bin/qpdf", "/usr/bin/qpdf"].find((p) => existsSync(p));
    if (!bin) return fail("qpdf not installed. `brew install qpdf` first.");
    const password = passwordArg === "-"
      ? readFileSync(0, "utf8").split(/\r?\n/, 1)[0] ?? ""
      : passwordArg;
    // V1.0020: parity with the encrypt path. qpdf's `--password-file=-`
    // reads stdin until EOF and treats embedded \n as part of the password,
    // but a multi-line password trips qpdf's own argv parsing in
    // edge cases. Reject newlines outright — same rule encrypt enforces.
    assertQpdfArgSafe(password, "PDF password");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, ["--password-file=-", "--decrypt", "--", input, output]);
      child.stdin.end(password + "\n");
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else if (code === 2) reject(new Error("incorrect password"));
        else reject(new Error(stderr.trim() || `qpdf exited ${code}`));
      });
    });
    return 0;
  }

  return fail(`unknown op: ${op}`);
}

function fail(msg: string): number {
  console.error(msg);
  return 2;
}

// macOS fires this before the app is ready when the user double-clicks a PDF
// (or drags one onto the app icon). Register early so we can queue the path.
// Skip in CLI mode — we don't want file-open events spawning windows.
//
// V1.0031: also start as ACCESSORY (no dock icon, no focus steal). This is
// the headless default — when the Finder Sync extension dispatches a
// `weavepdf://` URL while WeavePDF isn't running yet, macOS would
// otherwise activate WeavePDF as a foreground app and pull the user away
// from the desktop. With accessory policy, the app processes the URL
// invisibly. We bump back to "regular" only when a window is actually
// created (bare launch, dock click, or "combine" verb that opens its
// result in a tab).
let isHeadlessLaunch = process.platform === "darwin";
function transitionToForeground(): void {
  if (process.platform !== "darwin") return;
  if (!isHeadlessLaunch) return;
  try {
    app.setActivationPolicy("regular");
  } catch {
    // Some test contexts (no app instance) reject; ignore.
  }
  isHeadlessLaunch = false;
}

if (!isCliMode) {
  app.on("will-finish-launching", () => {
    if (process.platform === "darwin") {
      // Set the policy as early as macOS will let us — before any window
      // appears, before whenReady, before macOS has decided whether to
      // surface the dock icon.
      try {
        app.setActivationPolicy("accessory");
      } catch {
        // ignore
      }
    }
    app.on("open-file", (event, filePath) => {
      event.preventDefault();
      // File opens always need a window — bring the app forward.
      transitionToForeground();
      queueOrSendOpen(filePath);
    });
    app.on("open-url", (event, urlString) => {
      event.preventDefault();
      // URL handling stays headless by default; only the per-verb logic
      // in handleWeavePdfUrl bumps to foreground if it needs a window
      // (currently just "combine"). For in-place verbs (compress,
      // rotate, extract-first, convert), the action runs in the
      // background and the app quits when done — the user stays on
      // their desktop the whole time.
      queueOrHandleWeavePdfUrl(urlString);
    });
  });
}

// Queue for `weavepdf://` URLs that arrive before whenReady(). Drained inside
// the normal whenReady() block. The Finder Sync extension dispatches via
// `NSWorkspace.shared.open(URL)` — when the parent app is launched cold by
// such a URL, this is how we capture the verb without dropping it.
const pendingWeavePdfUrls: string[] = [];
let weavePdfUrlHandlerReady = false;

// V1.0031: track in-flight URL handlers so we can quit cleanly after the
// last cold-start URL action completes (and still no window is open). If
// the user fires a Finder right-click action while WeavePDF was not yet
// running, they expect WeavePDF to do its work and disappear — not stay
// running in the background forever.
let urlActionsInFlight = 0;

function queueOrHandleWeavePdfUrl(urlString: string): void {
  if (weavePdfUrlHandlerReady) {
    urlActionsInFlight++;
    void handleWeavePdfUrl(urlString).finally(() => {
      urlActionsInFlight--;
      void maybeQuitAfterHeadlessAction();
    });
  } else {
    pendingWeavePdfUrls.push(urlString);
  }
}

// Called after every URL handler completes (and after the initial cold-
// start URL drain in whenReady). Quits the app if:
//   - We're still in headless launch mode (no transitionToForeground
//     has fired — meaning no window was ever created).
//   - No URL handlers are still running.
//   - No windows are open.
// 300 ms grace lets file writes flush + log lines drain before exit.
async function maybeQuitAfterHeadlessAction(): Promise<void> {
  if (!isHeadlessLaunch) return;
  if (urlActionsInFlight > 0) return;
  await new Promise((r) => setTimeout(r, 300));
  if (urlActionsInFlight > 0) return; // another URL came in while we waited
  if (BrowserWindow.getAllWindows().length > 0) return; // a window opened
  logFinderSync("headless URL action(s) finished — quitting");
  app.quit();
}

// Returns a path that doesn't exist yet, deriving from `desired` by appending
// `-1`, `-2`, ... before the extension if necessary.
function uniqueOutputPath(desired: string): string {
  if (!existsSync(desired)) return desired;
  const ext = path.extname(desired);
  const stem = ext ? desired.slice(0, desired.length - ext.length) : desired;
  let n = 1;
  while (existsSync(`${stem}-${n}${ext}`)) n++;
  return `${stem}-${n}${ext}`;
}

// Handler for `weavepdf://<verb>?paths=<encoded-pipe-list>` URLs dispatched
// by the Finder Sync extension. Each verb has its own per-file or batch
// shape; runCli() is the existing CLI runner shared with --cli mode.
async function handleWeavePdfUrl(urlString: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    console.error("[weavepdf://] invalid URL:", urlString);
    logFinderSync(`invalid URL: ${urlString}`);
    return;
  }
  if (parsed.protocol !== "weavepdf:") return;

  const verb = parsed.host;
  const allowedVerbs = new Set([
    "compress",
    "extract-first",
    "rotate", // legacy alias for rotate-cw (V1.0014..V1.0027)
    "rotate-cw",
    "rotate-ccw",
    "convert",
    "combine",
  ]);
  if (!allowedVerbs.has(verb)) {
    console.error(`[weavepdf://] unknown verb: ${verb}`);
    logFinderSync(`unknown verb: ${verb} — abort`);
    return;
  }
  const rawPaths = (parsed.searchParams.get("paths") ?? "")
    .split("|")
    .filter(Boolean)
    .map((p) => decodeURIComponent(p));

  // V1.0020 hardening: any process on the Mac can dispatch a `weavepdf://`
  // URL and macOS will route it to us. Filter every path through
  // isSafeWeavePdfPath BEFORE any I/O — rejects sensitive locations
  // (~/.ssh, ~/.aws, /etc, /System, /Library/Keychains, app userData),
  // wrong extensions, and non-existent files. The Finder Sync extension
  // already pre-filters by extension, but we don't trust the URL source.
  const paths: string[] = [];
  const rejected: string[] = [];
  for (const p of rawPaths) {
    if (isSafeWeavePdfPath(p)) paths.push(p);
    else rejected.push(p);
  }
  if (rejected.length) {
    logFinderSync(`rejected ${rejected.length} unsafe path(s): ${rejected.join(", ")}`);
    // Surface to the user so a real Finder Sync invocation that hit a
    // sensitive path doesn't fail silently.
    const target = getActiveWindow();
    if (target) {
      void dialog.showMessageBox(target, {
        type: "warning",
        message: "WeavePDF rejected an unsafe file path",
        detail: `One or more paths were outside your normal document folders or pointed at sensitive system locations. WeavePDF only acts on PDFs and images in places like Desktop, Documents, Downloads, iCloud Drive, and external volumes.\n\nRejected:\n${rejected.slice(0, 5).join("\n")}${rejected.length > 5 ? `\n…and ${rejected.length - 5} more` : ""}`,
        buttons: ["OK"],
      });
    }
  }

  logFinderSync(`url verb=${verb} paths=${paths.length}: ${paths.join(", ")}`);

  if (paths.length === 0) {
    console.error(`[weavepdf://] verb=${verb} has no (safe) paths`);
    logFinderSync(`verb=${verb} has no safe paths — abort`);
    return;
  }

  const runUnary = async (
    cliVerb: string,
    suffix: string,
    opts?: { extra?: string[]; forceOutputExt?: string; inPlace?: boolean; reveal?: boolean },
  ) => {
    for (const input of paths) {
      const inputExt = path.extname(input).replace(/^\./, "").toLowerCase();
      const outExt = opts?.forceOutputExt ?? inputExt;
      const stem = inputExt ? input.slice(0, input.length - (inputExt.length + 1)) : input;
      // In-place verbs (rotate) overwrite the original file. New-file verbs
      // (compress, extract-first, convert) produce <stem><suffix>.<ext> and
      // reveal it in Finder so the user can see something happened.
      const outPath = opts?.inPlace ? input : uniqueOutputPath(`${stem}${suffix}.${outExt}`);
      logFinderSync(`  ${cliVerb}: ${input} → ${outPath}${opts?.inPlace ? " (in-place)" : ""}`);
      try {
        const code = await runCli([cliVerb, input, outPath, ...(opts?.extra ?? [])]);
        if (code !== 0) {
          console.error(`[weavepdf://] ${cliVerb} failed on ${input} (exit ${code})`);
          logFinderSync(`  ${cliVerb}: exit code ${code} (FAILED)`);
        } else if (existsSync(outPath)) {
          logFinderSync(`  ${cliVerb}: wrote ${outPath} (ok)`);
          if (opts?.reveal) {
            shell.showItemInFolder(outPath);
          }
        } else {
          logFinderSync(`  ${cliVerb}: exit 0 but ${outPath} doesn't exist (?!)`);
        }
      } catch (err) {
        console.error(`[weavepdf://] ${cliVerb} threw on ${input}:`, err);
        logFinderSync(`  ${cliVerb}: threw — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  try {
    switch (verb) {
      case "compress":
        // In-place: replaces the original with the Ghostscript-compressed
        // version. runCli internally uses a temp file + size guard so the
        // original is preserved if gs wouldn't actually shrink it.
        await runUnary("compress", "", { inPlace: true, reveal: false });
        break;
      case "extract-first":
        // V1.0030: don't reveal the new file in Finder. The user is
        // already looking at the source folder; popping a fresh Finder
        // window covers their context (especially annoying on the
        // desktop where it switches focus away from where they were
        // working). The new "<name>-page1.pdf" appears next to the
        // source on its own and the user notices it.
        await runUnary("extract-first", "-page1", { reveal: false });
        break;
      case "rotate":
      case "rotate-cw":
        // V1.0028: split into clockwise + counterclockwise. Old "rotate"
        // alias maps to clockwise for back-compat with V1.0014..V1.0027
        // dispatch URLs that may be cached in macOS's URL routing.
        await runUnary("rotate", "", { extra: ["90"], inPlace: true, reveal: false });
        break;
      case "rotate-ccw":
        // 270° clockwise = 90° counter-clockwise. Same in-place behaviour.
        await runUnary("rotate", "", { extra: ["270"], inPlace: true, reveal: false });
        break;
      case "convert":
        // V1.0030: same as extract-first — don't reveal. New PDF lands
        // next to the source image with the user already in context.
        await runUnary("image-to-pdf", "", { forceOutputExt: "pdf", reveal: false });
        break;
      case "combine": {
        if (paths.length < 2) {
          console.error("[weavepdf://] combine needs 2+ files");
          return;
        }
        const dir = path.dirname(paths[0]);
        const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
        const outPath = uniqueOutputPath(path.join(dir, `Merged-${stamp}.pdf`));
        const code = await runCli(["merge", ...paths, outPath]);
        if (code === 0 && existsSync(outPath)) {
          // Open the merged PDF directly in WeavePDF (creates a new tab)
          // instead of just revealing in Finder. Combine is the one verb
          // where the user almost always wants to immediately see the
          // result. queueOrSendOpen is the same path used by
          // double-clicking a PDF or dragging it onto the dock icon.
          queueOrSendOpen(outPath);
        }
        break;
      }
      default:
        console.error(`[weavepdf://] unknown verb: ${verb}`);
    }
  } catch (err) {
    console.error(`[weavepdf://] ${verb} dispatch failed:`, err);
  }
}

if (isCliMode) {
  // "accessory" hides the app from the Dock and app switcher entirely —
  // the CLI invocation doesn't steal focus from whatever Finder or the
  // foreground app the user is in. Must be set before whenReady.
  if (process.platform === "darwin") {
    app.setActivationPolicy("accessory");
  }
  const cliArgs = process.argv.slice(cliIdx + 1);
  app.whenReady().then(async () => {
    app.dock?.hide();
    try {
      const code = await runCli(cliArgs);
      process.exit(code);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
} else app.whenReady().then(() => {
  // Deny every permission request by default. WeavePDF is a local PDF editor
  // with no need for camera/mic/geo/notifications/etc. — if we add a feature
  // later that needs one, we whitelist it here explicitly.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });

  // Native macOS About panel under the WeavePDF menu uses these. The visible
  // version is the V1.0XXX form derived from package.json's semver patch.
  const semver = app.getVersion();
  const patch = parseInt(semver.split(".")[2] ?? "0", 10) || 0;
  const displayVersion = `V${semver.split(".")[0] ?? "1"}.${String(patch).padStart(4, "0")}`;
  app.setAboutPanelOptions({
    applicationName: app.name,
    applicationVersion: displayVersion,
    version: semver,
    credits: "Local-first PDF editor for macOS.",
    copyright: `© ${new Date().getFullYear()} WeavePDF`,
  });

  registerIpc();
  buildAppMenu();
  nativeTheme.on("updated", broadcastTheme);

  // V1.0031: don't unconditionally createMainWindow. If we're handling
  // a `weavepdf://` URL cold start (Finder Sync extension dispatch),
  // accessory mode means no window + no dock icon + no focus steal.
  // Per-verb handlers in handleWeavePdfUrl decide whether to bring up a
  // window (currently only "combine" does — it opens the merged result).
  weavePdfUrlHandlerReady = true;
  const hadQueuedUrls = pendingWeavePdfUrls.length > 0;
  for (const url of pendingWeavePdfUrls.splice(0)) {
    urlActionsInFlight++;
    void handleWeavePdfUrl(url).finally(() => {
      urlActionsInFlight--;
      void maybeQuitAfterHeadlessAction();
    });
  }

  // Windows/Linux: file paths come in as process.argv.
  if (process.platform !== "darwin") {
    for (const arg of process.argv.slice(1)) {
      if (arg && !arg.startsWith("-") && /\.(pdf|png|jpe?g|heic|heif)$/i.test(arg)) {
        queueOrSendOpen(arg);
      }
    }
  }

  // Bare-launch detection: if no URL or file event arrived, this was a
  // dock-icon / Spotlight launch and the user expects a window. Brief
  // setTimeout absorbs any straggler event arriving in the same tick.
  setTimeout(() => {
    const hasFiles = pendingOpenFiles.length > 0;
    const hasWindows = BrowserWindow.getAllWindows().length > 0;
    if (!hadQueuedUrls && !hasFiles && !hasWindows) {
      // Bare launch — foreground + show the main window.
      createMainWindow();
    }
  }, 100);

  app.on("activate", () => {
    // Dock icon click with no windows open → open a fresh one.
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });

  // Silent update poll on startup. Deferred a few seconds so it doesn't race
  // the renderer's first paint or compete for network with whatever the user
  // was about to do. Silent-if-up-to-date so it never bothers the user
  // unnecessarily; only surfaces a dialog when a newer version is available.
  setTimeout(() => {
    void checkForUpdatesAndNotify({ silentIfUpToDate: true });
  }, 5_000);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// V1.0026: ⌘Q / "Quit WeavePDF" with unsaved tabs across one or more
// windows. We aggregate dirty tab names from every window into a single
// dialog and then either let the quit proceed (setting appQuittingApproved
// so the per-window close handlers skip their own confirmation) or cancel.
app.on("before-quit", (event) => {
  if (appQuittingApproved) return;
  const allDirty: string[] = [];
  for (const win of BrowserWindow.getAllWindows()) {
    const list = dirtyTabsByWindowId.get(win.id) ?? [];
    for (const name of list) allDirty.push(name);
  }
  if (allDirty.length === 0) return;
  event.preventDefault();
  const focused = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const choice = focused
    ? dialog.showMessageBoxSync(focused, {
        type: "warning",
        message:
          allDirty.length === 1
            ? "“" + allDirty[0] + "” has unsaved changes."
            : `${allDirty.length} tabs have unsaved changes.`,
        detail:
          allDirty.length === 1
            ? "If you quit now, your edits will be lost."
            : "If you quit now, edits in these tabs will be lost:\n\n• " +
              allDirty.join("\n• "),
        buttons: ["Cancel", "Quit Anyway"],
        cancelId: 0,
        defaultId: 0,
      })
    : dialog.showMessageBoxSync({
        type: "warning",
        message: `${allDirty.length} tab${allDirty.length === 1 ? "" : "s"} with unsaved changes`,
        detail: allDirty.join("\n• "),
        buttons: ["Cancel", "Quit Anyway"],
        cancelId: 0,
        defaultId: 0,
      });
  if (choice === 1) {
    appQuittingApproved = true;
    app.quit();
  }
});
