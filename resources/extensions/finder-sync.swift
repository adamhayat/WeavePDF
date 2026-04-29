// WeavePDF Finder Sync extension.
//
// Compiled into a single `.appex` bundle and embedded inside
// `WeavePDF.app/Contents/PlugIns/`. macOS auto-discovers it on app install.
// User enables it once via System Settings → Login Items & Extensions →
// Finder, then a "WeavePDF" entry with a hover submenu appears in the Finder
// right-click context menu for PDFs and supported image types.
//
// Submenu items (5):
//   - Compress         — PDF only
//   - Combine into PDF — 2+ files of any supported type
//   - Convert to PDF   — image only
//   - Extract first page — PDF only
//   - Rotate 90°       — PDF only
//
// IPC architecture: macOS pkd requires app extensions to be sandboxed. A
// sandboxed extension cannot spawn arbitrary child processes (which the
// prior bash-dispatcher era relied on for TCC reasons). Instead, each menu
// action builds a `weavepdf://<verb>?paths=<enc-pipe-list>` URL and calls
// `NSWorkspace.shared.open(URL)`. The unsandboxed parent WeavePDF.app
// registers `weavepdf://` via CFBundleURLTypes and handles the URL in
// main.ts via `app.on('open-url')`, which calls the existing runCli logic
// in-process. The parent app has the user's TCC grants for files in
// ~/Desktop / ~/Documents / etc. (it's the user-launched PDF editor); the
// extension hands off file paths and lets the parent do the heavy work.
//
// Build: scripts/build-finder-sync.mjs.

import Cocoa
import FinderSync

class FinderSync: FIFinderSync {
    static let supported: Set<String> = [
        "pdf", "png", "jpg", "jpeg", "heic", "heif",
        "tif", "tiff", "gif", "bmp", "webp",
    ]
    static let imageOnly: Set<String> = [
        "png", "jpg", "jpeg", "heic", "heif",
        "tif", "tiff", "gif", "bmp", "webp",
    ]

    override init() {
        super.init()
        // Watch the entire filesystem so the menu shows everywhere a Finder
        // window can live. We don't need actual file-system events.
        FIFinderSyncController.default().directoryURLs = [URL(fileURLWithPath: "/")]
    }

    // MARK: - Menu

    override func menu(for menuKind: FIMenuKind) -> NSMenu {
        let m = NSMenu(title: "")
        guard menuKind == .contextualMenuForItems else { return m }

        let urls = FIFinderSyncController.default().selectedItemURLs() ?? []
        let ok = urls.filter { FinderSync.supported.contains($0.pathExtension.lowercased()) }
        guard !ok.isEmpty else { return m }

        let parent = NSMenuItem(title: "WeavePDF", action: nil, keyEquivalent: "")
        let sub = NSMenu(title: "WeavePDF")
        sub.autoenablesItems = false

        let pdfCount = ok.filter { $0.pathExtension.lowercased() == "pdf" }.count
        let imgCount = ok.filter { FinderSync.imageOnly.contains($0.pathExtension.lowercased()) }.count

        addItem(sub, "Compress", #selector(compressAction(_:)), enabled: pdfCount > 0)
        addItem(sub, "Combine into PDF", #selector(combineAction(_:)), enabled: ok.count >= 2)
        addItem(sub, "Convert to PDF", #selector(convertAction(_:)), enabled: imgCount > 0)
        addItem(sub, "Extract first page", #selector(extractAction(_:)), enabled: pdfCount > 0)
        addItem(sub, "Rotate 90°", #selector(rotateAction(_:)), enabled: pdfCount > 0)

        parent.submenu = sub
        m.addItem(parent)
        return m
    }

    private func addItem(_ menu: NSMenu, _ title: String, _ action: Selector, enabled: Bool) {
        let it = NSMenuItem(title: title, action: action, keyEquivalent: "")
        it.target = self
        it.isEnabled = enabled
        menu.addItem(it)
    }

    // MARK: - Action handlers
    //
    // Each action filters the selection by file type, then dispatches to the
    // unsandboxed parent app via a `weavepdf://<verb>?paths=...` URL. The
    // parent's app.on('open-url') handler in main.ts calls runCli() in-process
    // to do the actual PDF work.

    @objc func compressAction(_ sender: AnyObject?) {
        dispatch(verb: "compress", urls: selectedExt(["pdf"]))
    }

    @objc func combineAction(_ sender: AnyObject?) {
        let urls = selectedSupported()
        guard urls.count >= 2 else {
            DispatchQueue.main.async { self.alert("Combine needs 2+ files", "Select 2 or more PDFs or images.") }
            return
        }
        dispatch(verb: "combine", urls: urls)
    }

    @objc func convertAction(_ sender: AnyObject?) {
        dispatch(verb: "convert", urls: selectedExt(Array(FinderSync.imageOnly)))
    }

    @objc func extractAction(_ sender: AnyObject?) {
        dispatch(verb: "extract-first", urls: selectedExt(["pdf"]))
    }

    @objc func rotateAction(_ sender: AnyObject?) {
        dispatch(verb: "rotate", urls: selectedExt(["pdf"]))
    }

    // MARK: - URL-scheme dispatcher

    private func dispatch(verb: String, urls: [URL]) {
        guard !urls.isEmpty else { return }

        // Path-component encoding is conservative: encodes anything that
        // isn't safe in a URL path. Pipe `|` is our internal separator.
        let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "|&=?+#%"))
        let encoded = urls.map { u -> String in
            u.path.addingPercentEncoding(withAllowedCharacters: allowed) ?? u.path
        }.joined(separator: "|")

        let urlStr = "weavepdf://\(verb)?paths=\(encoded)"
        guard let dispatchURL = URL(string: urlStr) else {
            DispatchQueue.main.async { self.alert("WeavePDF", "Internal error: bad dispatch URL.") }
            return
        }

        // NSWorkspace.shared.open is allowed in a sandboxed extension because
        // the URL is dispatched through LaunchServices to whichever app
        // registered the `weavepdf://` scheme — our parent WeavePDF.app.
        NSWorkspace.shared.open(dispatchURL)
    }

    // MARK: - URL filters

    private func selectedExt(_ exts: [String]) -> [URL] {
        let urls = FIFinderSyncController.default().selectedItemURLs() ?? []
        let s = Set(exts.map { $0.lowercased() })
        return urls.filter { s.contains($0.pathExtension.lowercased()) }
    }

    private func selectedSupported() -> [URL] {
        let urls = FIFinderSyncController.default().selectedItemURLs() ?? []
        return urls.filter { FinderSync.supported.contains($0.pathExtension.lowercased()) }
    }

    // MARK: - User-facing alerts

    private func alert(_ title: String, _ message: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = message
        a.alertStyle = .warning
        a.runModal()
    }
}

// Note on the entry point: macOS app extensions (Finder Sync, Photo Editing,
// Share Extensions, etc.) need their binary's `main` symbol pointed at the
// `_NSExtensionMain` C function exported by the Foundation framework. That's
// what runs the extension lifecycle — XPC connection back to the host process,
// principal class instantiation, run loop. Without it, `launchd` spawns the
// extension process, sandbox is initialized, then the process exits cleanly,
// and Finder logs "Plugin must have pid! Extension request will fail".
//
// Xcode's extension templates wire this up via a build setting that sets
// `OTHER_LDFLAGS` to `-e _NSExtensionMain`. We do the equivalent in
// scripts/build-finder-sync.mjs by passing
// `-Xlinker -e -Xlinker _NSExtensionMain` to swiftc. No Swift main() needed —
// the linker directly binds the binary's entry to the dynamically-linked
// Foundation symbol.
