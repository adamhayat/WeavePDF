# TODO — WeavePDF

Running backlog. Newly-found work goes in as soon as it surfaces; checked items move to `CHANGELOG.md`.
See `HANDOFF.md` for current state and `CLAUDE.md` for the engineering rules.

## Now

- [ ] **Live check V1.0135 (Adam):** select a text box → ⌘C → ⌘V ONCE → exactly one copy, 12 pt down-right, same size as the original; ⌘V again → a second copy one step further; nothing lands at the middle of the view. Then Edit → Paste from the menu → one copy.
- [ ] **Live check V1.0134 (Adam):** the five-step click-through in HANDOFF (thumbnail shows the pasted screenshot; frame hugs the text; ⌘C/⌘V/⌘X on a text box and an image; shift-click two elements and drag both; colour dot + Add link turns text blue, survives ⌘S → Preview). The one thing headless could not prove: that the Edit-menu Copy/Paste roles dispatch the DOM `copy`/`paste` events with nothing focused — if ⌘C is silent live, see the HANDOFF note (keydown fallback, guarded).
- [ ] **Linked text has no underline** — only the colour. Needs an underline primitive in the bake (`drawLine` under the baseline, width from `widthOfTextAtSize`) + CSS `text-decoration` on screen, gated on a `link` flag the text edit doesn't carry yet.
- [ ] **Group drag across pages** — followers stay on their own page and move by the raw delta; a cross-page anchor drag should either carry the group or hold the followers. Also: followers are not clamped to the page edges (same family as "Nudge bounds").
- [ ] **Marquee (rubber-band) selection** — shift-click works; dragging a box on the page background to select several elements does not exist yet (the background pointer-down is taken by the tools).
- [ ] **Live check V1.0133 (Adam):** edit a PDF → ⌘S (same name) → close tab → double-click it in Finder → saved version shows first time. Also: Save As over a name that is open in another tab → Finder open shows the saved content.
- [ ] **Live check V1.0132 (Adam):** click a thumbnail → ↓/↑ step pages (highlight + viewer move, sidebar follows); typing in a text box → arrows move the caret; a selected placed shape → arrows nudge it.
- [ ] **pdf.js destroy races outside Print:** store setters (`closeTab`, `applyEdit`, …) call `void tab.pdf?.destroy()`; a getDocument starting during that teardown throws "the worker is being destroyed". Print preview retries (V1.0131); if it shows elsewhere, add a `pendingDestroys` tracker in pdfjs.ts that every getDocument awaits.
- [ ] **Live check V1.0129 (Adam):** drag a tab left/right; select 5 PDFs in Finder → Open → tabs in name order. If a drag doesn't move (Electron drag-region), fall back to the right-click Move Tab items and report.
- [ ] **Real print of V1.0127 (Adam):** open Print on the N2 Lottridge invoice → Paper reads US Letter → 2 per sheet, landscape → nothing cut off; close + reopen → settings kept.
- [ ] **Show the printer's unprintable edge in the preview** (~6 mm; PPD `*ImageableArea`, Brother Letter = 18 12 594 780). A same-size document printed at 100% unfitted can still lose content in that strip, and the preview doesn't show it.
- [x] (V1.0128, 2026-10-13) **Full page for 2/4/6/9 per sheet** — trims white margins. See CHANGELOG.
- [ ] **pdf-lib `embedPdf` ignores the box origin** — fixed in vector n-up (V1.0128) but `fitToPaper`, `scalePageContent` (vector) and other `embedPdf` callers still tile/scale the wrong region on offset-origin (Canva-style) pages. Switch them to `embedPages(pages, cropBoxes)` + a test per caller.
- [x] **Delete/move of a previously-SAVED element left its baked copy in the page** — fixed 2026-10-09 in V1.0126 (clean-page tab + tagged bakes stripped on reopen). See CHANGELOG.
- [ ] **Live click-through of V1.0125 (Adam):** right-click a whiteout → Arrange items; Bring to Front over a text box; Text tool click on a whited-out area places new text; save → open in Preview → identical.
- [x] **Layers / WYSIWYG whiteout (V1.0125, 2026-10-09)**: one stacking order for screen and bake; Arrange menu; buried elements ignore clicks. See CHANGELOG.
- [ ] **Drag a page out to Finder omits its editable elements** (V1.0126): the drag must start synchronously in `dragstart`, and `renderOutput` is async. Option: keep a cached flat render per (tab.version, pending identity), refreshed in the background.
- [ ] **Tool stays armed after drawing a shape** — grabbing the shape you just drew starts a NEW one. Ask Adam: auto-disarm after each shape (Preview-style) vs keep armed for repeated whiteouts.
- [ ] **Old (v1/v2) WeavePDF files keep burned-in copies** of their elements — unrecoverable by design; consider a one-time "flatten old WeavePDF edits" offer on open.
- [ ] **Text position screen-vs-file (UNVERIFIED claim from the V1.0126 UX review):** Edit Text replacements may save ~0.23×size LOWER than shown (stored yPt = span bottom, not baseline); new Add Text boxes ~0.13×size. Conflicts with V1.0123's measured ≤0.6 px drift for Add Text — needs ONE live side-by-side measurement (ask Adam before launching anything).
- [ ] **Wrap width screen-vs-file (UNVERIFIED, V1.0126 review):** the overlay wraps ~4 px narrower than the bake (padding inside maxWidth) and breaks inside long words where the bake doesn't. Needs a live check before changing.
- [ ] **Nudge bounds:** arrow-key nudges can push an element fully off the page.
- [ ] **Autosave drafts ignore element moves / text edits** after the last page operation (pre-existing; draft signature in useDraftPersistence.ts).
- [ ] **Dead code:** `commitAllPendingTextEdits` / `commitAllPendingShapeEdits` / `commitAllPendingImageEdits` in document.ts have no callers, and they still bake in a fixed per-type order. Delete them so nobody wires one back in and resurrects the old order.

- [x] **Re-test `CVOR_Certificate.PDF`** — 2026-08-17: delete page 2 keeps page 1 intact (164,226 ink px, unchanged); print preview at Range = 1 renders the certificate (92,970 ink px). Both were blank before V1.0121. See the table in `HANDOFF.md`.
- [x] (settled 2026-10-13, Adam's 2-up landscape print came out correctly oriented — no double rotation) **One real print of a landscape document.** Open question from V1.0121: the renderer bakes landscape into the page boxes *and* passes `-o landscape` to `lp`, which may double-apply in some drivers. Deliberately unchanged because no local probe can answer it — `cupsfilter` in PDF→PDF mode ignores both `landscape` and `media` (verified with a control). One print settles it. See the comment at the `lp` args in [main.ts](src/main/main.ts).
- [ ] **Port the e2e suite onto `connectOverCDP`.** `electron.launch` still hangs at the CDP browser-endpoint handshake, but attaching to a normally-launched app works fine **on the production build** — recipe + selectors in `HANDOFF.md`; the V1.0122 QA session added a second working pattern: open files via CDP `Input.dispatchDragEvent` with real paths (no test hooks needed; scripts in `test-results/qa-2026-08-18/` session scratchpad `qa1..qa9`). Rewriting `tests/e2e/helpers.ts#launchApp` to spawn the app with `--remote-debugging-port` and attach would revive the whole suite and remove the `VITE_E2E` rebuild requirement (and with it the Node-inspect fuse being on in test builds). **This is also the real fix for the V1.0122 review's P1 "the encrypted-PDF unit tests never cross the App.tsx boundary — a full revert of the unlock-at-open leaves all unit tests green":** the unlock lives in App.tsx wiring, which only an app-level test can pin. Tonight's live CDP QA verified it manually; a scripted CDP spec would make that permanent.
- [ ] **`url-listener-bin` orphans when the app is force-killed** — it kept running after `pkill -9` on the main app. Harmless day to day (a clean quit presumably reaps it), but it should exit when its parent dies.

## Next — confirmed usability defects, deferred (V1.0124 verification)

All VERIFIED against the source in V1.0124 and deliberately not fixed that session: each is an interaction rework rather than a guard, and none could be click-tested (the app was not launched). The rest of the V1.0123 claim list was either fixed in V1.0124 or verified FALSE — see CHANGELOG.

- [ ] **A drawn shape can't be moved — grabbing it duplicates it.** After drawing, the shape is selected but has no drag handles; pointer-down with the tool still armed starts a NEW shape on top. Needs the pending-shape overlay to accept a drag (as pending TEXT already does) and/or the tool to disarm after a draw.
- [x] (fixed V1.0126, 2026-10-09) **Sticky-note / text-prompt content is destroyed by an outside click.** Type a note, click elsewhere to check the text you're annotating, and everything typed is gone — the prompt reopens empty at the new spot. Should commit on outside click (or confirm), never discard silently.
- [x] (fixed V1.0126, 2026-10-09) **Emptying a text box leaves an invisible orphan that keeps the tab dirty forever.** Select-all + Delete inside a pending text box, click away: nothing is visible but the tab stays dirty, ⌘S rewrites the PDF and closing now prompts (V1.0124) about work that no longer exists. Remove the edit when its text goes empty.
- [ ] **Combined-PDF and DOCX export have no busy indicator.** ⌘E bakes + merges every tab before the save dialog appears; DOCX spends seconds in `pdfToMarkdown` + `textutil` AFTER the dialog closes. Both look frozen. (OCR and Compress are already well instrumented — copy their pattern.)
- [ ] **The AI modal is a hard lock while the on-device model runs** — no cancel, no timeout. Escape now closes it when idle (V1.0124) but not mid-run, which is the case that matters.
- [x] (fixed V1.0126, 2026-10-09) **Multi-tab closes still bypass the unsaved-work prompt.** V1.0124 wired ⌘W / tab ✕ / "Close tab" through `requestCloseTab`, but **"Close tabs to the right" and "Close other tabs" still call the store directly** and can discard several dirty tabs at once. Needs a single prompt summarising all affected tabs (the quit dialog already does exactly this — reuse it).
- [ ] **A shape drawn EARLIER still can't be recoloured.** V1.0124 made the colour popover restyle the *selected* shape, but there is no UI path to select a previously-drawn shape and reach the popover.

## Next

Correctness gaps found in the V1.0121 audit. All were reproduced by executing code; none are fixed yet.

- [ ] **`cropPages` ignores an existing CropBox** — the visible page *grows* and previously-hidden bleed/trim content becomes visible.
- [ ] **`cropPages` ignores the MediaBox origin** — cropping a non-zero-origin PDF shifts the page; a negative-origin page comes out blank.
- [ ] **`cropPages` ignores `/Rotate`** — "crop the top" removes the wrong edge on any rotated page.
- [ ] **`splitDoubleSpread` ignores `/Rotate`** — a rotated scanned spread yields one blank page plus one page containing both halves.
- [ ] **`scalePageContent` / `fitToPaper` drop `/Rotate`** — a rotated page prints sideways once either runs.
- [ ] **`bookletImpose` throws for any page count that isn't a multiple of 4** (`Can't embed page with missing Contents`).
- [ ] **`mergePdfs` still loses AcroForm / outline / labels.** V1.0121 fixed delete/extract/reorder by mutating in place; merge genuinely needs a new document, so it needs a different approach (copy the AcroForm across, or refuse-with-warning when a source has fields).
- [ ] **`insertBlankPageAfter` sizes from the MediaBox**, so on CropBox≠MediaBox documents the inserted page is visibly bigger than its neighbours.
- [ ] **n-up "2 pages per sheet" tiles onto a portrait sheet**, printing each page at 46% instead of the canonical 61% — should tile onto landscape.
- [ ] **Encrypted PDFs with object streams throw in every pdf-lib op, and delete/rotate/duplicate/crop have no error handling** — so with qpdf missing the operation silently does nothing. V1.0121's open-time unlock covers the normal path; this is the fallback path.
- [ ] **Header/footer, watermark, Bates and the OCR text layer are still not rotation-aware** (carried over from V1.0112).
- [ ] **fitToPaper still drops `/Rotate`** (tracked above) — note it now runs MORE often (V1.0121 made it the default for custom-size sources), so a rotated custom-size scan prints sideways. V1.0122 fixed the form-value loss half via `flattenFormsForPrint`; the rotation half needs fitToPaper itself to compose `/Rotate` into the draw transform.
- [ ] **v1.0119 Tab spec doesn't exercise the async-commit half** (review P3): it tabs between fields but never types-then-Tabs to prove focus survives the field's async `runCommit` re-render. Extend when the e2e suite is revived.
- [ ] **The "fit" single-sheet layout rasterizes via pdf.js render, which may not paint filled form-field values** (widget annotations need annotation-mode rendering) — same family as the V1.0122 flatten fix but a different pipeline; check `fitAllOntoSingleSheet` with a filled form.

## Someday

- [ ] **Apple Developer ID ($99/yr).** The only real fix for the repeating keychain "Always Allow" prompt: a Developer-ID signature carries a Team ID, which gives the keychain item a stable `teamid:` ACL partition instead of a per-build `cdhash:`. Self-signed certs cannot produce one (verified: adding an `OU` still yields `TeamIdentifier=not set`). Also ends Gatekeeper friction for anyone Adam shares a build with, and unlocks Tier-2 silent auto-update.
- [ ] **Prune the accumulated keychain partition list.** `WeavePDF Safe Storage` currently carries 51 stale `cdhash:` entries, one per historical build. Harmless but unbounded. Needs Adam's login password, so it is his command to run, not one to script.
- [ ] **Split the god objects** — `main.ts` (~3.6k lines) and `pdf-ops.ts` (~3.3k lines) by concern.
- [ ] **Extract pure logic for unit tests** — `isSafeWeavePdfPath`, `capHistory`, `computeReorder` still eagerly import Electron/pdf.js and so can't be tested.
- [ ] **Wire up the dead `lint` script** (eslint was declined once; revisit).
- [ ] Ghostscript-grade compression; drag-resize handles on baked elements; font matching in Edit Text; PDF/A conformance.
