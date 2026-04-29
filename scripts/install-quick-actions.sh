#!/usr/bin/env bash
# Post-install helper for the WeavePDF Finder integration.
#
# As of V1.0005, WeavePDF's Finder right-click integration is provided by an
# embedded Finder Sync App Extension at
#   /Applications/WeavePDF.app/Contents/PlugIns/WeavePDFFinderSync.appex
# which is built and embedded automatically by `npm run package` (see
# scripts/build-finder-sync.mjs and the postPackage hook in forge.config.ts).
#
# macOS auto-discovers the extension when the .app is installed, so there is
# no `cp` step like there used to be for the V1.0001..V1.0004 .workflow
# bundles. This script's only jobs now are:
#
#   1. Sweep any stale `* with WeavePDF.workflow` (V1.0001..V1.0003) and
#      `WeavePDF.workflow` (V1.0004 dispatcher) entries out of
#      ~/Library/Services/. They'd otherwise still appear in Finder right-click
#      alongside the new extension's submenu and confuse things.
#   2. Sweep legacy `* with Acrofox.workflow` entries (pre-V1.0002 rename).
#   3. Print enable instructions for the extension itself.
#
# Re-run this any time after `npm run package` + reinstall.

set -euo pipefail

DST="${HOME}/Library/Services"

if [[ ! -x "/Applications/WeavePDF.app/Contents/MacOS/WeavePDF" ]]; then
    echo "Warning: /Applications/WeavePDF.app not installed yet." >&2
    echo "  Build with 'npm run package', then copy to /Applications first." >&2
    exit 1
fi

if [[ ! -e "/Applications/WeavePDF.app/Contents/PlugIns/WeavePDFFinderSync.appex" ]]; then
    echo "Warning: extension not found inside the installed app at" >&2
    echo "  /Applications/WeavePDF.app/Contents/PlugIns/WeavePDFFinderSync.appex" >&2
    echo "  Re-run 'npm run package' and reinstall — the postPackage hook should" >&2
    echo "  build and embed it." >&2
    exit 1
fi

# Sweep stale workflows. We only touch *.workflow names that contain "WeavePDF"
# or "Acrofox" so we don't disturb unrelated user services.
shopt -s nullglob
removed=0
for stale in \
    "$DST/WeavePDF.workflow" \
    "$DST"/*"with WeavePDF.workflow" \
    "$DST"/*"with Acrofox.workflow" ; do
    if [[ -e "$stale" ]]; then
        rm -rf "$stale"
        echo "  removed stale: $(basename "$stale")"
        removed=$((removed + 1))
    fi
done

# Refresh the Services index.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -kill -domain user 2>/dev/null || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -seed -domain user 2>/dev/null || true
killall pbs 2>/dev/null || true

cat <<EOF

Done — $removed stale workflow(s) removed.

The Finder Sync extension is bundled inside WeavePDF.app and discovered
automatically by macOS. Enable it once via:

  System Settings → Login Items & Extensions → Finder
    → toggle on "WeavePDF"

Then right-click a PDF or image in Finder → "WeavePDF" → hover for the
submenu (Compress / Combine into PDF / Convert to PDF / Extract first page /
Rotate 90°).

If the WeavePDF entry doesn't appear after enabling, run:
  killall Finder

EOF
