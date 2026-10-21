/**
 * V1.0126: ⌘E / ⌘I / ⌘B / ⌘L / ⌘R / ⌘J format a SELECTED text box — but ⌘E
 * and ⌘I are also native menu accelerators (Export Combined PDF, Document
 * Properties), which fire regardless of what the page does with the key. The
 * box records the moment it handled one; the menu router skips a command that
 * arrives right after. A mouse click on the menu item is never affected.
 */
let handledAt = 0;

export function markBoxShortcut(): void {
  handledAt = Date.now();
}

export function boxJustHandledShortcut(windowMs = 400): boolean {
  return Date.now() - handledAt < windowMs;
}
