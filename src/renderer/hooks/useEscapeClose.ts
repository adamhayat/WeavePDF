import { useEffect } from "react";

/**
 * V1.0123: dismiss a dialog with Escape.
 *
 * Escape is the universal macOS "get me out of here" gesture, but only three
 * of WeavePDF's twenty overlays honoured it — Print Preview, Shortcut Help and
 * Welcome — each with its own copy of the same `window.addEventListener`
 * effect. Every other dialog ignored Escape entirely, so the gesture appeared
 * to work at random. (Nobody was ever trapped: they all have a ✕ and a
 * backdrop click. This is a reflex/consistency defect, not a lockout.)
 *
 * This must be a per-modal window listener rather than one central handler in
 * App.tsx, for two reasons that are easy to get wrong:
 *   1. App.tsx's Escape runs through react-hotkeys-hook, which by design does
 *      NOT fire when the event targets an input / textarea / select — i.e.
 *      exactly when the user is typing in the dialog and most wants out.
 *   2. Several dialogs must refuse to close mid-operation (OCR while busy,
 *      Batch while running, Digital Sign while signing). Those flags are local
 *      component state that a central handler cannot see.
 *
 * Pass `enabled` mirroring the dialog's existing backdrop-click guard so the
 * two dismissal paths agree.
 */
export function useEscapeClose(
  open: boolean,
  onClose: () => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!open || !enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, enabled, onClose]);
}
