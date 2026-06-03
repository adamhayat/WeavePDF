# WeavePDF

A local-first PDF editor for macOS. No cloud, no account, no subscription.

WeavePDF opens, edits, signs, OCRs, encrypts, merges, redacts, and compresses PDFs — entirely on your Mac. Documents never leave the machine. Signatures live in the macOS Keychain, not on a server. It exists because Adobe Acrobat became rented infrastructure for a file format that should belong to you.

## Install

1. Download **WeavePDF.dmg** from the [latest release](https://github.com/adamhayat/WeavePDF/releases/latest).
2. Open the DMG and drag **WeavePDF** to your Applications folder.
3. The build isn't notarized yet, so macOS blocks the first launch. To allow it:
   - **macOS 15 (Sequoia) and later:** open **System Settings → Privacy & Security**, scroll to the WeavePDF notice, and click **Open Anyway**.
   - **macOS 14 and earlier:** right-click WeavePDF in Applications → **Open**, then confirm.

You only do this once. After that WeavePDF launches like any other app.

### Requirements

- macOS 14 or later (Apple Silicon).
- **OCR** uses Apple Vision, built into macOS — nothing to install.
- **Summarize / Rewrite** use Apple Intelligence and need macOS 15.1+ on a supported Mac.
- **Heavy compression** and **password encryption** shell out to Ghostscript and qpdf. If you want those, install them once: `brew install ghostscript qpdf`. Without them, those two features tell you what's missing instead of failing silently — everything else works without Homebrew.

## What it does

- Open and read PDFs with text selection, search, and an outline panel
- Edit text (whiteout + retype), add text, images, shapes, highlights, links, and sticky notes
- Sign with a drawn or typed signature, or apply a PKCS#7 digital signature
- Reorder, rotate, delete, insert, extract, and merge pages — including drag-out to Finder
- Redact (the covered content is rasterized away, not just hidden behind a box)
- OCR scanned pages into searchable text with Apple Vision
- Compress, watermark, add headers/footers and Bates numbers, crop, and lay out N-up / booklet
- Fill AcroForm fields, edit metadata, password-protect, and convert images and documents to PDF
- Five Finder Quick Actions: Compress, Convert to PDF, Extract first page, Combine into PDF, Rotate 90°

## What it doesn't do

WeavePDF names its limits up front:

- **Edit Text doesn't reflow.** It whites out the original and retypes at the same spot — it doesn't rewrap a paragraph like a word processor.
- **No form creation.** You can fill existing forms; building new fillable fields from scratch is out of scope.
- **No cloud, sync, account, or telemetry.** By design. Nothing phones home except a once-per-launch check to GitHub for a newer release.
- No PDF/A archival conformance, no accessibility (PDF/UA) tagging, no prepress.

## Privacy

WeavePDF is local-first on purpose. Your documents stay on your Mac. Signatures and signing certificates are encrypted into the macOS Keychain via `safeStorage` — never written in the clear, never uploaded. The only network request the app makes is checking GitHub for a newer version; you can ignore the prompt and nothing changes.

## Build from source

```bash
npm install
npm run dev        # run in a real Terminal — Electron Forge needs a TTY
npm run typecheck  # tsc --noEmit
npm run package    # builds the .app into out/
```

See [CLAUDE.md](CLAUDE.md) for the architecture and engineering rules, [BRAND.md](BRAND.md) for the identity, and [HANDOFF.md](HANDOFF.md) for current state.

## License

Personal project, all rights reserved. Not for redistribution.
