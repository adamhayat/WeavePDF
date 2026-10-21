// V1.0123: confirm before a tab close throws away unsaved work.
//
// Closing the WINDOW or quitting the app has always shown a Save / Cancel /
// Don't Save dialog (main.ts before-quit + per-window close). Closing a single
// TAB did not: ⌘W, the tab's ✕ and the "Close tab" context item all called
// `closeTab()` directly, so a placed-but-unbaked signature, a drawn shape,
// typed text or a deleted page vanished with no warning. It was the only
// destructive action in the app that never asked.
//
// The save function lives in App.tsx (it owns the Save-As dialog + bake
// pipeline), so it registers itself here and the Titlebar can reuse it without
// prop-drilling — same pattern as lib/pending-field.ts.

import { useDocumentStore } from "../stores/document";

type TabSaver = (tabId: string) => Promise<boolean>;

let saveTab: TabSaver | null = null;

export function setTabSaver(fn: TabSaver | null): void {
  saveTab = fn;
}

/** Close a tab, asking first when it carries unsaved changes.
 *  Resolves true when the tab was actually closed. */
export async function requestCloseTab(tabId: string): Promise<boolean> {
  const store = useDocumentStore.getState();
  const tab = store.tabs.find((t) => t.id === tabId);
  if (!tab) return false;
  if (!tab.dirty) {
    store.closeTab(tabId);
    return true;
  }

  let choice: "save" | "cancel" | "discard";
  try {
    choice = await window.weavepdf.confirmCloseTab(tab.name);
  } catch (err) {
    // If we couldn't even ask, keep the tab. Losing the user's work because a
    // dialog failed to open is the one outcome that must not happen.
    console.error("requestCloseTab: confirm failed", err);
    return false;
  }

  if (choice === "cancel") return false;
  if (choice === "save") {
    const ok = saveTab ? await saveTab(tabId) : false;
    // Save failed, or the user backed out of the Save-As sheet — keep the tab
    // open so the work is still reachable.
    if (!ok) return false;
  }
  useDocumentStore.getState().closeTab(tabId);
  return true;
}

/** V1.0126: close several tabs, asking about each one that has unsaved
 *  changes. "Close other tabs" / "Close tabs to the right" used to call the
 *  store directly and silently discard every dirty tab they hit. Cancel on
 *  any prompt stops there and keeps the rest open. */
export async function requestCloseTabs(tabIds: string[]): Promise<void> {
  for (const id of tabIds) {
    const closed = await requestCloseTab(id);
    if (!closed) return;
  }
}
