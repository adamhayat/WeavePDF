// V1.0123 regression pins for the Escape-to-dismiss contract.
//
// Escape worked in only 3 of WeavePDF's 20 overlays. The other 17 ignored it,
// so the gesture appeared to work at random. This suite pins the WIRING —
// that every dialog component actually calls the shared hook, and with the
// same guard as its backdrop click — because that is the part a future edit
// silently breaks (a new modal added without the hook looks fine in review).
//
// The hook's runtime behaviour is not exercised here: these components need a
// DOM + React renderer, which this project's vitest setup deliberately does
// not carry. Live behaviour is verified by hand.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const COMPONENTS = join(__dirname, "..", "..", "src", "renderer", "components");

/** dialog file → the guard its Escape must respect (null = always closes). */
const DIALOGS: Record<string, string | null> = {
  "CompressModal/CompressModal": null,
  "SignatureModal/SignatureModal": null,
  "MetadataModal/MetadataModal": null,
  "WatermarkModal/WatermarkModal": null,
  "ExtractModal/ExtractModal": null,
  "HeaderFooterModal/HeaderFooterModal": null,
  "FormFillModal/FormFillModal": null,
  "PageLayoutModal/PageLayoutModal": null,
  "RecentDraftsModal/RecentDraftsModal": null,
  "CommandPalette/CommandPalette": null,
  "BatchModal/BatchModal": "!running",
  "OcrModal/OcrModal": "!busy",
  "AiModal/AiModal": "!busy",
  "PromptModal/PromptModal": "!busy",
  "DigitalSignModal/DigitalSignModal": 'phase !== "signing" && phase !== "generating"',
};

const read = (rel: string) => readFileSync(join(COMPONENTS, `${rel}.tsx`), "utf8");

describe("V1.0123: every dialog can be dismissed with Escape", () => {
  for (const [rel, guard] of Object.entries(DIALOGS)) {
    it(`${rel.split("/")[1]} calls useEscapeClose${guard ? ` (guarded by ${guard})` : ""}`, () => {
      const src = read(rel);
      expect(src).toContain("useEscapeClose(open, onClose");
      if (guard) {
        // The Escape guard must match the backdrop guard, or the two ways of
        // dismissing the dialog disagree about when it's safe to close.
        expect(src).toContain(`useEscapeClose(open, onClose, ${guard})`);
      }
    });
  }

  it("the three dialogs that already had Escape still handle it", () => {
    // These predate the hook and use their own window listener. If someone
    // deletes one, this catches it.
    for (const rel of [
      "PrintPreviewModal/PrintPreviewModal",
      "ShortcutHelpModal/ShortcutHelpModal",
      "WelcomeModal/WelcomeModal",
    ]) {
      expect(read(rel)).toMatch(/Escape/);
    }
  });

  it("the shared hook exists and listens on window, not via react-hotkeys-hook", () => {
    const hook = join(__dirname, "..", "..", "src", "renderer", "hooks", "useEscapeClose.ts");
    expect(existsSync(hook)).toBe(true);
    const src = readFileSync(hook, "utf8");
    // A window listener is required: react-hotkeys-hook ignores events whose
    // target is an input/textarea/select — i.e. exactly when the user is
    // typing in the dialog and most wants out.
    expect(src).toContain('window.addEventListener("keydown"');
    expect(src).toContain('window.removeEventListener("keydown"');
  });
});
