import { useEffect, useRef } from "react";
import { useDocumentStore, type DocumentTab } from "../stores/document";
import { u8ToAb } from "../../shared/buffers";
import type { DraftManifest } from "../../shared/ipc";

const DEBOUNCE_MS = 1500;

/**
 * Subscribes to the document store and writes a draft slot per dirty tab,
 * debounced. Drafts persist across app restarts so the user can resume an
 * untitled or in-progress edit even after closing the tab or quitting WeavePDF.
 *
 * Slot keys come from `tab.draftKey`:
 *   - real disk path for opened files (e.g. /Users/.../foo.pdf)
 *   - synthetic `weavepdf-virtual://<uuid>` for in-memory tabs (combined PDFs,
 *     image/DOCX imports). Both are autosaved; only path-keyed drafts get
 *     auto-prompted on reopen — virtual ones surface in the Recent Drafts UI.
 *
 * When a tab's draftKey changes (Save As, virtual → saved), the OLD slot is
 * cleared so we don't leave orphans pinning the user's name list.
 */
export function useDraftPersistence(): void {
  // Per-tab last-saved snapshot signature, so we only write when something
  // actually changed (avoid burning disk every render).
  const lastSig = useRef<Map<string, string>>(new Map());
  // Pending debounce timers, one per tab.
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Tab id → last-known draftKey so we can clear orphaned slots on rename.
  const lastKey = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const flushTab = async (tab: DocumentTab) => {
      // Detect draftKey rename (e.g. virtual → saved disk path) and clear
      // the old slot before writing the new one.
      const prevKey = lastKey.current.get(tab.id);
      if (prevKey && prevKey !== tab.draftKey) {
        try {
          await window.weavepdf.drafts.clear(prevKey);
          lastSig.current.delete(prevKey);
        } catch {
          /* swallow — clearing is best-effort */
        }
      }
      lastKey.current.set(tab.id, tab.draftKey);

      // V1.0035: only autosave drafts when the user has APPLIED at least
      // one edit (`tab.history.length > 0`). Pure pending overlays — a
      // single click that created a tiny shape, an accidental highlight on
      // a fillable PDF's annotation layer — were noisy: they triggered a
      // "Restore unsaved work?" prompt on every reopen for changes the
      // user didn't intend. Real edits get committed via applyEdit, which
      // grows history; THAT's the signal worth restoring across launches.
      // Tradeoff: a user who draws a shape, doesn't commit, then walks
      // away and the laptop dies, won't see the shape back. The V1.0026
      // close-confirm dialog still warns them on intentional close so
      // they can save first.
      const hasState = tab.history.length > 0;
      if (!hasState) {
        // Nuke any stale slot from a previous edit cycle.
        try {
          await window.weavepdf.drafts.clear(tab.draftKey);
          lastSig.current.delete(tab.draftKey);
        } catch {
          /* ignore */
        }
        return;
      }

      // Cheap signature: counts + version + zoom/page + first 32 bytes of
      // the bytes hash via length/version. If unchanged, nothing to do.
      const sig = [
        tab.version,
        tab.bytes?.byteLength ?? 0,
        tab.pendingTextEdits.length,
        tab.pendingImageEdits.length,
        tab.pendingShapeEdits.length,
        tab.history.length,
        tab.currentPage,
        tab.zoom.toFixed(2),
      ].join("|");
      if (lastSig.current.get(tab.draftKey) === sig) return;

      // Inline pending image bytes as base64 so the manifest is self-contained.
      const pendingImageEdits = tab.pendingImageEdits.map((e) => ({
        ...e,
        bytes: arrayBufferToBase64(e.bytes),
      }));

      const manifest: DraftManifest = {
        draftKey: tab.draftKey,
        sourcePath: tab.path,
        originalName: tab.name,
        savedAt: new Date().toISOString(),
        sourceSizeBytes: tab.sizeBytes,
        hasAppliedChanges: tab.history.length > 0,
        pendingTextEdits: tab.pendingTextEdits,
        pendingImageEdits,
        pendingShapeEdits: tab.pendingShapeEdits,
        currentPage: tab.currentPage,
        zoom: tab.zoom,
      };

      // Only write the bytes when the user has applied an edit (not just
      // floating overlays). For overlay-only state, restoring the original
      // bytes + pending list reproduces the same view at a fraction of disk.
      const bytesPayload =
        tab.history.length > 0 && tab.bytes
          ? u8ToAb(tab.bytes)
          : null;

      try {
        await window.weavepdf.drafts.save(manifest, bytesPayload);
        lastSig.current.set(tab.draftKey, sig);
      } catch (err) {
        // Don't surface autosave failures to the user — they'll retry on
        // the next change. Just log to the renderer console for diagnosis.
        console.warn("Draft autosave failed:", err);
      }
    };

    const schedule = (tab: DocumentTab) => {
      const existing = timers.current.get(tab.id);
      if (existing) clearTimeout(existing);
      const handle = setTimeout(() => {
        timers.current.delete(tab.id);
        // Re-read the latest tab state at fire time — debounced flush
        // shouldn't write a stale snapshot from N changes ago.
        const fresh = useDocumentStore
          .getState()
          .tabs.find((t) => t.id === tab.id);
        if (fresh) void flushTab(fresh);
      }, DEBOUNCE_MS);
      timers.current.set(tab.id, handle);
    };

    const handleSnapshot = (state: ReturnType<typeof useDocumentStore.getState>) => {
      const liveIds = new Set(state.tabs.map((t) => t.id));
      // Garbage collect timers for closed tabs so we don't fire after unmount.
      for (const [tabId, handle] of timers.current) {
        if (!liveIds.has(tabId)) {
          clearTimeout(handle);
          timers.current.delete(tabId);
        }
      }
      // Forget signatures for closed tabs — keeps the map bounded.
      for (const tabId of Array.from(lastKey.current.keys())) {
        if (!liveIds.has(tabId)) lastKey.current.delete(tabId);
      }

      for (const tab of state.tabs) schedule(tab);
    };

    handleSnapshot(useDocumentStore.getState());
    const unsub = useDocumentStore.subscribe(handleSnapshot);
    return () => {
      unsub();
      for (const handle of timers.current.values()) clearTimeout(handle);
      timers.current.clear();
    };
  }, []);
}

function arrayBufferToBase64(bytes: Uint8Array): string {
  // Chunked conversion — String.fromCharCode(...arr) blows the stack for
  // large images.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + chunk, bytes.length))),
    );
  }
  return btoa(binary);
}
