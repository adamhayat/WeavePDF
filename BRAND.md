# WeavePDF — Brand & Identity

A quiet, local-only Mac-native PDF editor that replaces Adobe Acrobat.

## Positioning

WeavePDF is a Mac-native, local-only PDF editor for prosumers and small-business professionals — lawyers, designers, accountants, indie operators — who need real PDF tools without renting them. It opens, edits, signs, OCRs, encrypts, merges, redacts, and compresses, all on-device. No cloud, no account, no subscription, no telemetry. It exists because Adobe Acrobat became rented infrastructure for a file format that should belong to the user.

**Elevator pitch:** A local-first Mac PDF editor that replaces Acrobat without the rent.

**Pillars**
- **Local.** Documents never leave the machine. Signatures live in Keychain, not a server.
- **Calm.** The chrome retreats; the page is the interface. Nothing pulses, blinks, or upsells.
- **Permanent.** A one-time tool you actually own. No tier, no trial, no cloud dependency to outlive you.

**Anti-positioning — what WeavePDF is not**
- Not SaaS. Not a subscription.
- Not in the cloud. Nothing syncs.
- Not bloated. No prepress, no portfolios, no AI assistant chatbot.
- Not Adobe. No nag, no upgrade prompt, no account.
- Not a converter site or browser tool dressed as an app.

## Naming & Spelling

**Locked casing:** `WeavePDF` everywhere in human-facing copy. CamelCase, capital P-D-F. Use `weavepdf` only for slugs, package names, bundle IDs, and CLI invocation.

| Surface | Form |
|---|---|
| Body copy, marketing, UI labels, About panel | `WeavePDF` |
| `package.json` `name`, npm slug | `weavepdf` |
| Bundle ID | `ca.adamhayat.weavepdf` |
| App binary / DMG | `WeavePDF.app`, `WeavePDF.dmg` |
| CLI invocation | `weavepdf --cli ...` |
| Test hook | `window.__weavepdfTest__` |
| Domain | `weavepdf.com` (`.app` reserve) |

**Pronunciation:** WEEV-pee-dee-eff.

**Plural form:** Always pluralize the *thing*, never the brand. Write "PDFs" or "documents." Never "WeavePDFs."

**Tagline candidates** (pick one when shipping)
1. *PDFs, on your Mac. That's it.*
2. *A quiet PDF editor for people who own their files.*
3. *Acrobat's job, without the rent.*
4. *Open. Edit. Done. Locally.*
5. *The PDF editor that stays out of the way.*

## Voice & Tone

WeavePDF speaks like a confident craftsperson, not a startup. Plainspoken, dry, occasionally warm. It assumes the reader is an adult professional with work to do. It never sells, never apologizes for itself, never explains a feature it could just demonstrate. Mac-indie register: Bear, Things, Reeder, Linear's docs page — not Notion's marketing.

**Voice attributes**
- **Plain.** Short Anglo-Saxon words over Latinate ones. "Open" not "initialize."
- **Direct.** State the thing. No "we're excited to announce."
- **Quiet.** Lowercase enthusiasm. No exclamation points outside a literal "Hi!" example.
- **Considered.** Every sentence earns its place. Cut adverbs, cut "really," cut "very."
- **Trust-respecting.** Talks to the user as a peer. Never patronizing, never cute.
- **Honest.** Names the limit before the user finds it. "We don't reflow text. Edit Text whites out and retypes."

**Do / Don't**

| Context | Say this | Don't say this |
|---|---|---|
| App tagline | A quiet PDF editor for your Mac. | The most powerful PDF editor for Mac! |
| Save-As confirmation | Saved a copy. The original is untouched. | Successfully exported document!! |
| Empty state | No document open. Drop a PDF, or press ⌘O. | Welcome to WeavePDF! Let's get started on your journey. |
| Error toast | Couldn't open that file. | Oops! Something went wrong :( |
| About string | Local-first PDF editor for macOS. | Revolutionary AI-powered PDF platform |
| Settings header | Preferences | Customize your experience |
| Compress preset | Smallest — 72 dpi | Super-Fast Tiny File ⚡ |
| Sign-up CTA | (none — there's nothing to sign up for) | Start your free trial today! |
| Feature shipped | Page layout. N-up, booklet, fit-to-paper. | We're thrilled to introduce our brand-new Page Layout experience! |
| Confirm destructive | Replace file? The original will be overwritten. | Are you absolutely sure you want to do this?? |

**Tone by context**
- **Errors** — neutral, factual, no exclamation. "Couldn't read that PDF. The file may be encrypted." Never blame the user.
- **Success** — silent when possible. A toast only when the action wasn't visible. "Saved." "Exported."
- **Marketing** — declarative, dry, slightly knowing. Trusts the reader to recognize what's *not* being said.
- **Settings / Preferences** — system-style. Match macOS Preferences voice: noun phrases, no second person. "Default zoom," not "Choose your default zoom."

**For an AI assistant writing WeavePDF copy:** Write the way macOS itself writes. Lead with the noun. Cut every word that isn't load-bearing. No exclamation points. No "simple," "easy," "powerful," "seamless," "intuitive," "revolutionary," "delightful." Don't anthropomorphize the app. Don't use "we" unless explicitly speaking from the maker. When in doubt, write half as much.

## Color Palette

The palette stays neutral-first to let documents lead. The accent moves from Acrofox's electric violet (`#6D5EF5`) to a deeper, less saturated **Loom Indigo** — closer to ink than neon, evoking thread and inkstone rather than brand-software. The shift signals the rename without breaking visual continuity, and the lower saturation reads more premium against the descriptor name.

**Recommended accent: `#3B4CCA` Loom Indigo** (light) / `#7A8AFF` softened (dark). Replaces electric violet.

| Token | Hex (light) | Hex (dark) | Role |
|---|---|---|---|
| `--accent` | `#3B4CCA` | `#7A8AFF` | Primary accent, focus rings, selected tool, active tab underline |
| `--accent-soft` | `#E7EAFB` | `#1E2440` | Hover surface, subtle accent fill |
| `--bg` | `#FBFBFA` | `#101113` | App background |
| `--surface` | `#FFFFFF` | `#181A1D` | Panels, modals, sidebar |
| `--surface-2` | `#F4F4F2` | `#1F2126` | Toolstrip, titlebar, secondary panels |
| `--page` | `#FFFFFF` | `#0E0F11` | PDF page canvas backdrop |
| `--border` | `#E6E6E2` | `#2A2D33` | Hairlines, separators |
| `--border-strong` | `#D2D2CC` | `#3A3D44` | Inputs, popover edges |
| `--text` | `#16181B` | `#ECECEA` | Body text |
| `--text-muted` | `#5C6066` | `#9CA0A8` | Secondary text, hints |
| `--text-subtle` | `#8A8E94` | `#6E727A` | Tertiary text, captions, version footer |
| `--success` | `#30D158` | `#32D74B` | Confirmation toasts (kept) |
| `--warn` | `#FF9F0A` | `#FF9F0A` | Caution states (kept) |
| `--destructive` | `#FF453A` | `#FF453A` | Delete, redact, irreversible (kept) |
| `--thread` | `#B8AE9A` | `#5E5749` | Decorative warm-graphite for the loom motif background only |

**Do not use**
- Neon, fluorescent, or saturated yellow.
- Gradients on text, buttons, or wordmark. Gradients permitted only on the app icon background.
- A sixth hue without owner sign-off. Stay in this table.
- The accent on more than one focal element per screen.
- Pure `#000` or pure `#FFF` for text — use the tokens above.

## Typography

**Primary stack:** `system-ui, -apple-system, "SF Pro Text", "SF Pro Display", "Helvetica Neue", sans-serif`. WeavePDF is Mac-native and inherits SF Pro from the OS — no webfont download, no licensing, perfect rendering on every Mac.

**Wordmark face:** **GT America Mono** (or, if unlicensed at ship, the system fallback `ui-monospace, "SF Mono"`). The wordmark is the one place where the brand asserts itself — a wide-set monospace rendering of `weave` paired with the upright caps `PDF` carries the woven, threaded feel without resorting to a literal loom illustration. Single pick, no alternates.

**Type scale** (kept from baseline; serves the dense PDF UI well)

| Size | px | Use |
|---|---|---|
| Caption | 11 | Footer, version stamp, legal |
| Small | 13 | Sidebar labels, tooltips, secondary UI |
| Body | 15 | Default body text, menus, modal copy |
| Title | 20 | Section heads, modal titles |
| Display-S | 28 | Marketing H2, About panel header |
| Display-L | 36 | Marketing H1, hero |

**Numerals:** Tabular figures (`font-variant-numeric: tabular-nums`) on every page count, file size, percentage, version stamp, and form-field number. Page 12 / 348 must align with Page 1 / 348.

## Wordmark

The wordmark renders as `weave` in lowercase mono + `PDF` in uppercase mono, joined with no space, on one line: **`weavePDF`** as a logotype, while body copy uses the conventional `WeavePDF`. The lowercase-then-caps shift visually mimics the over-under of a weave and disambiguates the descriptor "PDF" as a *thing being woven through*, not just a category tag.

**Specs**
- Letterforms: GT America Mono (or `ui-monospace` fallback). Weight 500.
- Tracking: `-0.01em` on `weave`, `0` on `PDF`.
- Color: `--text` on `--bg` in both themes. The wordmark is not accent-colored.
- Optional thread mark: a 1px hairline in `--accent` running under the `e` and continuing under the `P`, suggesting a single thread pulled through both halves. Use only at Display-L size or larger; omit at Title and below.
- Minimum width: **88 px** wide on screen, **24 mm** in print. Below that, use the icon alone.
- Clear space: minimum padding around the wordmark equal to the cap-height of `P`.

**Don'ts**
- Never break `weave` and `PDF` onto two lines.
- Never tilt, italicize, outline, drop-shadow, or gradient-fill.
- Never recolor the wordmark to the accent. The accent is a focus tool, not a brand surface.
- Never substitute a different `PDF` casing — it's always uppercase in the wordmark.
- Never reproduce smaller than 88 px wide.

## Iconography & App Icon

**App icon concept** — a macOS squircle with a near-flat, slightly luminous background graduating from `#1E2440` at the bottom-right to `#3B4CCA` at the top-left (Loom Indigo, deepened). Centered: a single page glyph (rounded-corner rectangle, ~62% of the squircle) rendered in soft `#FBFBFA`, with **two thin threads in `#7A8AFF`** crossing diagonally over its surface to form a low-contrast `W`. The threads pass *over* and *under* each other at the crossing point — the only literal weaving cue in the entire identity. No fox, no folded corner, no shadow on the page beyond a 1px inner border.

The icon must read at 16 px. At that size only the page silhouette + crossing threads are visible; the background fades to a single tone. Test at every size in the iconset before shipping.

**Glyph candidates considered, then rejected:**
- A literal two-strand braid → too domestic, reads as crafts hobby.
- A stack of pages with a needle stitch → too literal, dates badly.
- Stylized loom / heddle → unrecognizable below 64 px.

**Recommended primary:** the page-with-two-threads-over-under above.

**Hard constraints**
- 1024×1024 PNG master in `resources/icon.png`.
- `iconutil` pipeline produces `resources/icon.icns` from `icon.iconset/` at 16/32/64/128/256/512/1024 + @2x variants. Existing `scripts/generate-icon.mjs` flow stays; SVG source replaces the fox.
- macOS supplies the squircle radius — the icon background is a flat-filled squircle, no manual rounded corners.
- No text in the icon. The `W` is implied by the threads, not spelled.
- No drop shadow under the icon — macOS adds the shadow.

**System icon language (in-app)**
- Continue using `lucide-react` everywhere icons appear.
- Stroke width: `1.75`. Round caps, round joins.
- Size: `16` for toolstrip, `14` for sidebar, `20` for empty-state CTAs.
- Color inherits `currentColor`; never hardcode hex on a lucide icon.

**Empty-state illustrations:** None. Empty states are typography + a single CTA. A WeavePDF empty state is one centered line of body text, one accent-tinted CTA button, and nothing else. No spot illustrations, no characters, no decorative thread motifs.

## Motion & Interaction

WeavePDF moves the way a well-built drawer slides. Motion threads in and out — never spikes, bounces, or glows. Animation exists to clarify state, not to perform.

- **Standard transition:** 180 ms, cubic-bezier(0.2, 0, 0, 1).
- **Larger transitions** (modals open/close, sidebar toggle): 300 ms, same curve.
- **Error feedback:** 80 ms, 2px horizontal shake, no color flash.
- **No** bounce, no spring overshoot, no drop-shadow pulses, no "delight" micro-animations.
- **Cursors stay mapped:** copy / text / cell / crosshair from the existing baseline. No changes.
- **Hover affordances:** opacity step (1.0 → 0.85), no scale. Buttons don't grow on hover.
- **Drag is the verb.** Whenever an interaction can be a drag — page reorder, region select, signature place, image insert — make it a drag first, with a click fallback.

## Copy Seeds

**App Store / DMG first-line description** (under 100 chars)
> A local-first PDF editor for macOS. No cloud, no account, no subscription.

**Long description** (95 words)
> WeavePDF is a Mac-native PDF editor that runs entirely on your machine. Open, edit, sign, OCR, encrypt, merge, redact, and compress without an account or a subscription. Apple Vision powers OCR. Apple Intelligence handles summaries and rewrites on-device. Signatures live in Keychain, never on a server. Five Finder Quick Actions plug PDF work into the rest of macOS. Built for prosumers, lawyers, designers, and small-business operators who want real PDF tools without the rent. One file, one app, one purchase. The original PDF stays untouched until you choose otherwise.

**Three taglines**
1. PDFs, locally.
2. Acrobat's job, without the rent.
3. A quieter PDF editor.

**About-panel credits string**
> Local-first PDF editor for macOS.

**Empty state — no document open**
> No document open. Drop a PDF here, or press ⌘O.
> CTA label: **Open file**

**Save-As confirmation**
> Saved a copy. The original is untouched.

**Generic error toast template** (5 words)
> Couldn't `<verb>` `<thing>`. `<reason>`.
> e.g. *Couldn't open that file. The PDF may be encrypted.*

## Rename checklist (Acrofox → WeavePDF)

**Package + bundle**
- [ ] `package.json` → `name: "weavepdf"`, `productName: "WeavePDF"`
- [ ] Bump version per Critical Rule on rename event
- [ ] Bundle identifier `ca.adamhayat.acrofox` → `ca.adamhayat.weavepdf`
- [ ] `forge.config.ts` → `packagerConfig.name`, `appBundleId`, `appCategoryType` audit, `MakerDMG.name`, `MakerZIP` artifact name
- [ ] Electron Forge fuse config — verify `EnableNodeCliInspectArguments` stays ON
- [ ] DMG output filename `Acrofox.dmg` → `WeavePDF.dmg`
- [ ] `out/Acrofox-darwin-arm64/` → rebuild produces `out/WeavePDF-darwin-arm64/`

**Main process**
- [ ] `src/main/main.ts` — window title strings
- [ ] `app.setAboutPanelOptions` — `applicationName`, `credits`, `copyright`
- [ ] `buildAppMenu` — top-level "Acrofox" menu → "WeavePDF"
- [ ] `CFBundleDocumentTypes` role string "Acrofox" → "WeavePDF"
- [ ] CLI binary self-reference (`Acrofox --cli`) → `WeavePDF --cli` and lowercase `weavepdf` alias
- [ ] Any `console.log` / log file path containing `acrofox`
- [ ] Quick Action log path `/tmp/acrofox-quickaction.log` → `/tmp/weavepdf-quickaction.log`

**Renderer**
- [ ] `ShortcutHelpModal` footer string "Acrofox · Local-first PDF editor for macOS"
- [ ] `App.tsx` — any title attributes, palette descriptions
- [ ] Brand mentions in modal headers, About surface
- [ ] CSS class names containing `acrofox` (audit; rename for clarity, not strictly required)
- [ ] Window title format `<doc> — Acrofox` → `<doc> — WeavePDF`

**Test surface**
- [ ] `window.__acrofoxTest__` namespace → `window.__weavepdfTest__`
- [ ] All `tests/e2e/*.spec.ts` strings expecting `Acrofox`, `acrofox-`
- [ ] Playwright `executablePath` — `Acrofox.app/Contents/MacOS/Acrofox` → `WeavePDF.app/Contents/MacOS/WeavePDF`
- [ ] Test fixture filenames if any contain `acrofox`

**Quick Actions**
- [ ] `Compress with Acrofox.workflow` → `Compress with WeavePDF.workflow`
- [ ] `Convert to PDF with Acrofox.workflow` → `Convert to PDF with WeavePDF.workflow`
- [ ] `Extract first page with Acrofox.workflow` → `Extract first page with WeavePDF.workflow`
- [ ] `Combine into PDF with Acrofox.workflow` (currently labeled Merge) → `Combine into PDF with WeavePDF.workflow`
- [ ] `Rotate 90 with Acrofox.workflow` → `Rotate 90 with WeavePDF.workflow`
- [ ] `scripts/install-quick-actions.sh` — installer help text, source paths, success/failure messages

**Resources**
- [ ] `resources/icon.svg` — replace fox with new page-and-threads glyph
- [ ] `resources/icon.icns` — regenerate via `scripts/generate-icon.mjs`
- [ ] `resources/icon.iconset/*` — all sizes
- [ ] `resources/icon.png` — 1024×1024 master

**Install + LaunchServices**
- [ ] `/Applications/Acrofox.app` → `/Applications/WeavePDF.app` (kill, delete, copy, xattr clear)
- [ ] `lsregister -f /Applications/WeavePDF.app` flush
- [ ] Desktop alias at `~/Desktop/Acrofox` → `~/Desktop/WeavePDF`
- [ ] User data directory (`~/Library/Application Support/Acrofox/`) — decide: migrate-on-launch or fresh start; document in `HANDOFF.md`
- [ ] Keychain entry name (`Acrofox` keychain item) — migrate-on-launch via safeStorage re-encrypt under new service name
- [ ] LaunchServices file association registration

**Environment + IPC**
- [ ] Any reserved env vars `ACROFOX_*` → `WEAVEPDF_*`
- [ ] IPC channel names containing `acrofox` (audit `src/shared/ipc.ts`)

**Project docs**
- [ ] `CLAUDE.md` — title, references, paths
- [ ] `AGENTS.md` — title, references
- [ ] `HANDOFF.md` — title, every embedded reference (history can stay; current state must rename)
- [ ] `CHANGELOG.md` — `[Unreleased]` entry: "Renamed Acrofox to WeavePDF"
- [ ] `BRAND.md` — this file (already named for the new identity)
- [ ] `README.md` — full rewrite or replace top section

**External surfaces**
- [ ] GitHub repo description + topics
- [ ] Domains: register `weavepdf.com`, `weavepdf.app`, `getweavepdf.com`, `weave-pdf.com`
- [ ] App Store / Mac App Store metadata if/when shipped
- [ ] Any social handles or marketing surfaces

## Critical brand rules

1. **Always write the brand as `WeavePDF`** in body copy. Never `weave pdf`, `Weave PDF`, `Weavepdf`, `WEAVEPDF`, or `weavePDF` outside the wordmark logotype.
2. **Never shorten to `Weave` alone in product copy.** Weave Communications (NYSE: WEAV) is a separate live trademark holder. The compound is the brand; the compound stays.
3. **Slugs are lowercase: `weavepdf`.** Bundle ID is `ca.adamhayat.weavepdf`. CLI is `weavepdf`. Test hook is `__weavepdfTest__`.
4. **Never use exclamation points in error messages, success toasts, or settings copy.** Marketing prose may use one per page maximum, and only when load-bearing.
5. **Never describe WeavePDF as "simple," "easy," "powerful," "seamless," "intuitive," "revolutionary," or "delightful."** Prefer "quiet," "considered," "real," "local," "fast."
6. **Never anthropomorphize the app.** No "WeavePDF wants…" / "WeavePDF thinks…" / "WeavePDF noticed…". The app does things; it doesn't have feelings.
7. **Default to system voice for UI copy.** macOS-native register first, brand voice second. The app should read as a Mac app with personality, not a brand-app with Mac styling.
8. **The accent color appears on at most one focal element per screen.** No accent buttons next to accent badges next to accent links.
9. **Light + dark theme follows `nativeTheme.shouldUseDarkColors`.** Never propose an in-app theme toggle.
10. **The wordmark is never accent-colored.** Black on light, near-white on dark. Period.
11. **No illustrations, mascots, characters, or spot art anywhere in the product.** Empty states are typography. Onboarding is typography. The icon is the only image.
12. **When in doubt, write half as much.** Cut the second sentence. The user is busy.

## Versioning + Display

Single source of truth: `package.json` `"version"` (semver). Display format `V1.0<patch4>` is derived from the patch field — semver `1.0.1` → `V1.0001`, `1.0.42` → `V1.0042`. Two visible surfaces:
- macOS About panel via `app.setAboutPanelOptions` ([src/main/main.ts](src/main/main.ts))
- Footer of the `⌘/` Keyboard Shortcuts panel ([src/renderer/components/ShortcutHelpModal/ShortcutHelpModal.tsx](src/renderer/components/ShortcutHelpModal/ShortcutHelpModal.tsx))

Bump the patch by 1 on every code-changing turn and reflect it in `HANDOFF.md`'s Status line and `CHANGELOG.md`'s `[Unreleased]` section. **The Acrofox → WeavePDF rename is a code-changing event and triggers a patch bump per this rule.**

## How future Claude Code sessions should use this file

This file is the canonical source for WeavePDF's voice, visual language, and naming. When you write any UI copy, marketing copy, error message, modal title, About string, button label, README paragraph, or design comp for WeavePDF, default to what's in here. Read `HANDOFF.md` first, then `CLAUDE.md`, then this file when the task touches text, color, type, or identity.

**Conflict resolution**
- Inline user request always wins over BRAND.md.
- For voice / visual / naming questions, **BRAND.md outranks `CLAUDE.md`**.
- For engineering rules (local-only, signatures in Keychain, save-as protection, pdf.js worker bundling, etc.), **`CLAUDE.md` outranks BRAND.md**.

**When to update BRAND.md** — rarely. Update only on a major identity event: rename, accent shift, wordmark change, or a deliberate voice pivot signed off by Adam. Do not update BRAND.md to record a single new copy string. Add the string to the relevant component or doc and leave this file alone.

**When in doubt:** write the way macOS itself writes. Plain, short, factual, no exclamation. Trust the user. Cut the second sentence.
