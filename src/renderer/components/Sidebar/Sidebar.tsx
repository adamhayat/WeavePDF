import { Fragment, useEffect, useMemo, useRef, useState } from "react";
// V1.0045: removed @dnd-kit's drag-to-reorder. The thumbnail's plain
// drag is now reserved for HTML5 native drag-out (drag a page to Finder
// to extract it as a PDF). Reorder lives in the right-click
// menu via "Move up" / "Move down" — same end result, no gesture
// disambiguation needed.
import { Plus, RotateCw, RotateCcw, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import { useDocumentStore, type DocumentTab } from "../../stores/document";
import { useUIStore } from "../../stores/ui";
import type { PDFDocumentProxy } from "../../lib/pdfjs";
// Lazy-loaded so the pdf-lib chunk doesn't pull at boot. Sidebar is
// rendered eagerly when a doc is open, but every pdf-ops call here fires
// from a click handler — chunk parses on the first such click.
const loadPdfOps = () => import("../../lib/pdf-ops");
import { u8ToAb } from "../../../shared/buffers";
import { cn } from "../../lib/cn";
import { OutlinePanel } from "./OutlinePanel";
import { RevisionsPanel } from "./RevisionsPanel";
import { PromptModal } from "../PromptModal/PromptModal";
import type { DraftManifest } from "../../../shared/ipc";

// V1.0105: module-scoped tracker for "internal" sidebar drags. When the user
// drags a thumbnail, `handleDragStart` calls `webContents.startDrag()` which
// initiates an OS-level Files drag with a temp PDF payload (`weavepdf-drag-*`
// in os.tmpdir()). That OS drag, if dropped back into the sidebar, lands as a
// Files drop on `onDrop`. Pre-V1.0105 the V1.0055 PDF-merge handler caught it
// and stacked the dragged page into the document — Adam: "Reordering pages
// seems to create new pages or duplicate them." `onDrop` now consults this
// ref. If the most recent dragstart fired within the last 30s, we treat the
// drop as an internal reorder and call `reorderPages` instead of `insertAfter`.
let internalDragState: { pageNumbers: number[]; startedAt: number } | null = null;

/** V1.0105: given the current page count, the 1-based pages being moved, and
 *  the 0-based drop index (where the moved block should sit relative to the
 *  ORIGINAL page list), produce a 0-based source-index array suitable for
 *  `reorderPages`. Pure function; tested via the e2e spec. */
export function computeReorder(
  numPages: number,
  movedPages1Based: number[],
  dropAt: number,
): number[] {
  const moved = Array.from(new Set(movedPages1Based.map((p) => p - 1))).sort(
    (a, b) => a - b,
  );
  const movedSet = new Set(moved);
  const rest: number[] = [];
  for (let i = 0; i < numPages; i++) {
    if (!movedSet.has(i)) rest.push(i);
  }
  // Translate dropAt (an index over all original pages) into a position over
  // the "rest" list by skipping moved pages that fell before the drop point.
  let adjustedDropAt = 0;
  for (let i = 0; i < dropAt && i < numPages; i++) {
    if (!movedSet.has(i)) adjustedDropAt++;
  }
  return [...rest.slice(0, adjustedDropAt), ...moved, ...rest.slice(adjustedDropAt)];
}

type Props = {
  /**
   * Restore a draft from the Revisions tab. Implementation lives in App.tsx
   * because draft restore touches the file system and tab/document store.
   */
  onRestoreRevision: (manifest: DraftManifest) => Promise<void>;
  /**
   * V1.0051: restore a saved-version snapshot. Implementation lives in
   * App.tsx for the same reason — touches readFile + tab store.
   */
  onRestoreSnapshot: (filePath: string, savedAt: string) => Promise<void>;
};

export function Sidebar({ onRestoreRevision, onRestoreSnapshot }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const setCurrentPage = useDocumentStore((s) => s.setCurrentPage);
  const selectPage = useDocumentStore((s) => s.selectPage);
  const clearSelection = useDocumentStore((s) => s.clearSelection);
  const applyEdit = useDocumentStore((s) => s.applyEdit);
  const open = useUIStore((s) => s.sidebarOpen);
  const sidebarTab = useUIStore((s) => s.sidebarTab);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);
  const thumbScale = useUIStore((s) => s.sidebarThumbScale);
  const setThumbScale = useUIStore((s) => s.setSidebarThumbScale);
  const showToast = useUIStore((s) => s.showToast);
  const [pageLabelPrompt, setPageLabelPrompt] = useState<{ pageNumber: number } | null>(null);
  // V1.0055: drop-target index for an external-PDF drop into the thumbnails
  // panel. `null` = no drag in progress; integer N = "insert at position N"
  // (0 = before page 1, numPages = after last page). Drives the blue
  // insertion line rendered between thumbnails.
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const thumbsContainerRef = useRef<HTMLDivElement | null>(null);

  if (!open || !activeTab?.pdf) return null;

  const selectedCount = activeTab.selectedPages.size;

  const handleDelete = async () => {
    if (!activeTab.bytes || activeTab.selectedPages.size === 0) return;
    if (activeTab.selectedPages.size === activeTab.numPages) {
      // PDFs must have at least one page. Offer to close the doc instead
      // rather than silently no-op.
      const confirmed = window.confirm(
        `You can't delete every page. Close this document instead?\n\n(${activeTab.name})`,
      );
      if (confirmed) {
        useDocumentStore.getState().closeTab(activeTab.id);
      }
      return;
    }
    const pages = Array.from(activeTab.selectedPages).sort((a, b) => a - b);
    const { deletePages } = await loadPdfOps();
    const newBytes = await deletePages(activeTab.bytes, pages);
    await applyEdit(activeTab.id, newBytes);
  };

  const handleRotate = async (delta: 90 | -90 | 180) => {
    if (!activeTab.bytes) return;
    const targets =
      activeTab.selectedPages.size > 0
        ? Array.from(activeTab.selectedPages)
        : [activeTab.currentPage];
    const { rotatePages } = await loadPdfOps();
    const newBytes = await rotatePages(activeTab.bytes, targets, delta);
    await applyEdit(activeTab.id, newBytes);
  };

  // V1.0045: explicit reorder by index swap, called from the right-click
  // "Move up" / "Move down" menu items. Replaces the @dnd-kit drag-to-
  // reorder so plain drag on the thumbnail can be reserved for HTML5
  // native drag-out (drag a page out to Finder).
  const movePage = async (pageNumber: number, delta: -1 | 1) => {
    if (!activeTab.bytes) return;
    const newIndex = pageNumber - 1 + delta;
    if (newIndex < 0 || newIndex >= activeTab.numPages) return;
    const order = Array.from({ length: activeTab.numPages }, (_, i) => i);
    [order[pageNumber - 1], order[newIndex]] = [order[newIndex], order[pageNumber - 1]];
    const { reorderPages } = await loadPdfOps();
    const newBytes = await reorderPages(activeTab.bytes, order);
    await applyEdit(activeTab.id, newBytes, { newCurrentPage: newIndex + 1 });
  };

  const applyPageLabel = async (pageNumber: number, prefix: string) => {
    if (!activeTab.bytes) return;
    const ranges = [];
    if (pageNumber > 1) {
      ranges.push({ startPage: 1, style: "decimal" as const });
    }
    ranges.push({
      startPage: pageNumber,
      style: "decimal" as const,
      prefix: prefix.trim() || undefined,
      firstNumber: 1,
    });
    const { setPageLabels } = await loadPdfOps();
    const b = await setPageLabels(activeTab.bytes, ranges);
    await applyEdit(activeTab.id, b);
  };

  const insertBlankAfterPage = async (afterPage: number) => {
    if (!activeTab.bytes) return;
    const { insertBlankPageAfter } = await loadPdfOps();
    const newBytes = await insertBlankPageAfter(activeTab.bytes, afterPage);
    await applyEdit(activeTab.id, newBytes, { newCurrentPage: afterPage + 1 });
  };

  // V1.0105: the sidebar grows with the thumbnail zoom so 2× thumbs don't
  // clip. Base 200px = 150pt thumb + 26px gutter + 12px+12px padding rounded.
  // Width = 50px chrome + 150 × scale.
  const sidebarWidthPx = Math.round(50 + 150 * thumbScale);

  return (
    <>
    <aside
      className="flex h-full shrink-0 flex-col border-r border-[var(--panel-border)] bg-[var(--panel-bg)]"
      style={{ width: sidebarWidthPx }}
    >
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-[var(--panel-border)] px-1">
        <SidebarTabButton
          active={sidebarTab === "pages"}
          onClick={() => setSidebarTab("pages")}
          testId="sidebar-tab-pages"
        >
          Pages
        </SidebarTabButton>
        <SidebarTabButton
          active={sidebarTab === "outline"}
          onClick={() => setSidebarTab("outline")}
          testId="sidebar-tab-outline"
        >
          Outline
        </SidebarTabButton>
        <SidebarTabButton
          active={sidebarTab === "revisions"}
          onClick={() => setSidebarTab("revisions")}
          testId="sidebar-tab-revisions"
        >
          Revisions
        </SidebarTabButton>
      </div>
      {sidebarTab === "outline" ? (
        <OutlinePanel />
      ) : sidebarTab === "revisions" ? (
        <RevisionsPanel onRestore={onRestoreRevision} onRestoreSnapshot={onRestoreSnapshot} />
      ) : selectedCount > 0 ? (
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--panel-border)] pl-3 pr-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-[var(--app-fg)]">
              <span className="tnum">{selectedCount}</span> selected
            </span>
            <button
              type="button"
              onClick={() => clearSelection(activeTab.id)}
              className="text-[11px] text-[var(--muted)] hover:text-[var(--app-fg)]"
            >
              Clear
            </button>
          </div>
          <div className="flex items-center gap-0.5">
            <SidebarIcon
              label="Rotate left"
              onClick={() => handleRotate(-90)}
              data-testid="rotate-left"
            >
              <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.8} />
            </SidebarIcon>
            <SidebarIcon
              label="Rotate right"
              onClick={() => handleRotate(90)}
              data-testid="rotate-right"
            >
              <RotateCw className="h-3.5 w-3.5" strokeWidth={1.8} />
            </SidebarIcon>
            <SidebarIcon
              label="Delete pages"
              onClick={handleDelete}
              data-testid="delete-pages"
              danger
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
            </SidebarIcon>
          </div>
        </div>
      ) : (
        <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-[var(--panel-border)] pl-3 pr-1 text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">
          <span>Pages</span>
          <span className="tnum normal-case text-[var(--muted)]">
            {activeTab.currentPage} / {activeTab.numPages}
          </span>
        </div>
      )}
      {/* V1.0106: zoom strip always visible regardless of selection state.
          Pre-V1.0106 the zoom buttons lived in the no-selection header — but
          clicking a thumb selects the page, which switches the header to the
          rotate/delete toolbar and hid the zoom controls. Adam: "I don't see
          a way to make the left sidebar smaller." Now zoom + reset live in
          their own slim strip directly under the header, always reachable. */}
      {sidebarTab === "pages" && (
        <div className="flex h-7 shrink-0 items-center justify-end gap-0.5 border-b border-[var(--panel-border)] pr-1">
          <SidebarIcon
            label="Smaller thumbnails"
            onClick={() => setThumbScale(thumbScale - 0.2)}
            data-testid="sidebar-zoom-out"
          >
            <ZoomOut className="h-3.5 w-3.5" strokeWidth={1.8} />
          </SidebarIcon>
          <button
            type="button"
            onClick={() => setThumbScale(1)}
            title="Reset thumbnail size"
            className="tnum h-6 min-w-[32px] rounded px-1 text-[10px] text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]"
            data-testid="sidebar-zoom-reset"
          >
            {Math.round(thumbScale * 100)}%
          </button>
          <SidebarIcon
            label="Larger thumbnails"
            onClick={() => setThumbScale(thumbScale + 0.2)}
            data-testid="sidebar-zoom-in"
          >
            <ZoomIn className="h-3.5 w-3.5" strokeWidth={1.8} />
          </SidebarIcon>
        </div>
      )}

      {sidebarTab === "pages" && <div
        className="acr-scroll flex-1 overflow-y-auto p-3"
        onMouseDown={(e) => {
          // Clicking empty space clears the selection.
          if (e.target === e.currentTarget) clearSelection(activeTab.id);
        }}
        // V1.0055: dropping a PDF file directly into the thumbnails panel
        // merges its pages into the open document at the drop point. Plain
        // drops elsewhere on the window (page area, title bar) keep the
        // existing window-level "open as new tab" behavior — App.tsx's
        // global drop handler is bypassed here via stopPropagation.
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "copy";
          // Compute insertion index from the drop point relative to the
          // existing thumbnails. Above a thumbnail's vertical midpoint =
          // "insert before this page"; below = "insert after". With no
          // thumbnails matched, default to "append at end".
          const container = thumbsContainerRef.current;
          if (!container) return;
          const thumbs = Array.from(
            container.querySelectorAll<HTMLDivElement>("[data-page-number]"),
          );
          let insertAt = thumbs.length;
          for (let i = 0; i < thumbs.length; i++) {
            const r = thumbs[i].getBoundingClientRect();
            if (e.clientY < r.top + r.height / 2) {
              insertAt = i;
              break;
            }
          }
          setDropTargetIndex(insertAt);
        }}
        onDragLeave={(e) => {
          // Only clear when the drag actually leaves the panel (relatedTarget
          // outside the scroller). Otherwise React fires dragLeave whenever
          // the cursor crosses between child elements and the indicator
          // would flicker.
          const next = e.relatedTarget as Node | null;
          if (!next || !(e.currentTarget as Node).contains(next)) {
            setDropTargetIndex(null);
          }
        }}
        onDrop={async (e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.stopPropagation(); // suppress App.tsx window-global "new tab" handler
          const dropAt = dropTargetIndex;
          setDropTargetIndex(null);
          if (dropAt == null || !activeTab?.bytes) return;

          // V1.0105: detect internal drag (a sidebar thumbnail dragged
          // within the same sidebar). The OS-level drag started by
          // `webContents.startDrag()` carries a temp file under
          // `os.tmpdir()/weavepdf-drag-*/`. If the dropped file path
          // includes that marker AND a recent dragstart set
          // `internalDragState`, treat the drop as a reorder rather than
          // a PDF merge — Adam: "Reordering pages seems to create new
          // pages or duplicate them."
          const droppedPaths: string[] = [];
          let internalMarkerSeen = false;
          for (const f of Array.from(e.dataTransfer.files)) {
            const filePath = window.weavepdf.getPathForFile(f);
            if (!filePath) continue;
            droppedPaths.push(filePath);
            if (filePath.includes("weavepdf-drag-")) internalMarkerSeen = true;
          }
          const recentInternal =
            internalDragState && Date.now() - internalDragState.startedAt < 30_000;
          if (internalMarkerSeen && recentInternal && internalDragState) {
            const movedPages = internalDragState.pageNumbers;
            internalDragState = null;
            try {
              const newOrder = computeReorder(activeTab.numPages, movedPages, dropAt);
              // No-op if the dropped block is already at the drop point.
              const isUnchanged = newOrder.every((src, i) => src === i);
              if (isUnchanged) return;
              const { reorderPages } = await loadPdfOps();
              const newBytes = await reorderPages(activeTab.bytes, newOrder);
              // Land the caret on the first moved page in its new position.
              const newFirstMovedIndex = newOrder.indexOf(
                Math.min(...movedPages.map((p) => p - 1)),
              );
              await applyEdit(activeTab.id, newBytes, {
                newCurrentPage: newFirstMovedIndex + 1,
              });
            } catch (err) {
              console.error("reorder pages", err);
              showToast("Couldn't reorder those pages.", "warn");
            }
            return;
          }

          // External PDF drop — V1.0055 merge behaviour.
          const pdfPaths = droppedPaths.filter((p) =>
            p.split(".").pop()?.toLowerCase() === "pdf",
          );
          if (pdfPaths.length === 0) return;
          try {
            const { insertAfter, countPages } = await loadPdfOps();
            let bytes: Uint8Array = activeTab.bytes;
            let cursor = dropAt;
            // Stack each dropped PDF in drop order at the cursor; advance
            // the cursor by each PDF's page count so they land contiguously
            // when the user drops two or more PDFs at once.
            for (const p of pdfPaths) {
              const file = await window.weavepdf.readFile(p);
              const newBytes = new Uint8Array(file.data);
              const added = await countPages(newBytes);
              bytes = await insertAfter(bytes, newBytes, cursor);
              cursor += added;
            }
            await applyEdit(activeTab.id, bytes);
          } catch (err) {
            console.error("merge pdf", err);
            showToast("Couldn't add that PDF.", "warn");
          }
        }}
      >
        <div className="flex flex-col gap-3" ref={thumbsContainerRef}>
          {dropTargetIndex === 0 && <DropIndicator />}
          {/* V1.0095: Fragment key dropped `activeTab.version`. Pre-V1.0095 every commit unmounted + remounted all Thumbs, kicking off a fresh pdf.js render task per page per applied edit. Thumb's own useEffect already lists `tab.version` in its deps and re-renders the thumbnail when needed; we don't need to throw the whole component instance away. Same pattern as PageCanvas (see its key=line 187 comment). */}
          {Array.from({ length: activeTab.numPages }, (_, i) => i + 1).map((pageNumber) => (
            <Fragment key={`${activeTab.id}-${pageNumber}`}>
            <Thumb
              pdf={activeTab.pdf!}
              pageNumber={pageNumber}
              active={activeTab.currentPage === pageNumber}
              selected={activeTab.selectedPages.has(pageNumber)}
              tab={activeTab}
              thumbScale={thumbScale}
              onActivate={(mode) => {
                if (mode === "set") {
                  setCurrentPage(activeTab.id, pageNumber);
                  selectPage(activeTab.id, pageNumber, "set");
                } else {
                  selectPage(activeTab.id, pageNumber, mode);
                }
              }}
              onContextMenu={(clientX, clientY) => {
                const selection =
                  activeTab.selectedPages.has(pageNumber) && activeTab.selectedPages.size > 1
                    ? Array.from(activeTab.selectedPages).sort((a, b) => a - b)
                    : [pageNumber];
                const multi = selection.length > 1;
                useUIStore.getState().openContextMenu(clientX, clientY, [
                  {
                    kind: "item",
                    label: "Move up",
                    disabled: multi || pageNumber === 1,
                    onClick: () => void movePage(pageNumber, -1),
                  },
                  {
                    kind: "item",
                    label: "Move down",
                    disabled: multi || pageNumber === activeTab.numPages,
                    onClick: () => void movePage(pageNumber, 1),
                  },
                  { kind: "separator" },
                  {
                    kind: "item",
                    label: multi ? "Rotate left 90°" : "Rotate left 90°",
                    shortcut: "⌘[",
                    onClick: async () => {
                      if (!activeTab.bytes) return;
                      const { rotatePages } = await loadPdfOps();
                      const b = await rotatePages(activeTab.bytes, selection, -90);
                      await applyEdit(activeTab.id, b);
                    },
                  },
                  {
                    kind: "item",
                    label: "Rotate right 90°",
                    shortcut: "⌘]",
                    onClick: async () => {
                      if (!activeTab.bytes) return;
                      const { rotatePages } = await loadPdfOps();
                      const b = await rotatePages(activeTab.bytes, selection, 90);
                      await applyEdit(activeTab.id, b);
                    },
                  },
                  {
                    kind: "item",
                    label: "Rotate 180°",
                    onClick: async () => {
                      if (!activeTab.bytes) return;
                      const { rotatePages } = await loadPdfOps();
                      const b = await rotatePages(activeTab.bytes, selection, 180);
                      await applyEdit(activeTab.id, b);
                    },
                  },
                  { kind: "separator" },
                  {
                    kind: "item",
                    label: multi ? `Duplicate ${selection.length} pages` : "Duplicate page",
                    disabled: multi,
                    onClick: async () => {
                      if (!activeTab.bytes) return;
                      const { duplicatePage } = await loadPdfOps();
                      const b = await duplicatePage(activeTab.bytes, pageNumber);
                      await applyEdit(activeTab.id, b);
                    },
                  },
                  {
                    kind: "item",
                    label: multi ? `Extract ${selection.length} pages…` : "Extract page…",
                    onClick: async () => {
                      if (!activeTab.bytes) return;
                      const { extractPages } = await loadPdfOps();
                      const extracted = await extractPages(activeTab.bytes, selection);
                      const result = await window.weavepdf.saveFileDialog({
                        title: "Extract Pages",
                        suggestedName: activeTab.name.replace(/\.pdf$/i, "") + `-extract.pdf`,
                        extensions: ["pdf"],
                      });
                      if (result.canceled) return;
                      const w = await window.weavepdf.writeFile(result.path, u8ToAb(extracted));
                      if (!w.ok) {
                        console.error("extract", w.error);
                        showToast("Couldn't extract those pages.", "warn");
                      }
                    },
                  },
                  { kind: "separator" },
                  {
                    kind: "item",
                    label: "Set page label…",
                    disabled: multi,
                    onClick: () => setPageLabelPrompt({ pageNumber }),
                  },
                  { kind: "separator" },
                  {
                    kind: "item",
                    label: multi ? `Delete ${selection.length} pages` : "Delete page",
                    danger: true,
                    disabled: selection.length === activeTab.numPages,
                    onClick: async () => {
                      if (!activeTab.bytes) return;
                      const { deletePages } = await loadPdfOps();
                      const b = await deletePages(activeTab.bytes, selection);
                      await applyEdit(activeTab.id, b);
                    },
                  },
                ]);
              }}
              onAddPageAfter={() => void insertBlankAfterPage(pageNumber)}
              showAddPageAfter={pageNumber < activeTab.numPages}
            />
            {dropTargetIndex === pageNumber && <DropIndicator />}
            </Fragment>
          ))}
          {/* V1.0090: explicit "New page" affordance. Pre-V1.0090 Adam
              could only add a page via a drag-to-duplicate trick he
              stumbled onto — undiscoverable. This sticky bottom button
              inserts a blank page at the end of the doc by default; if
              a single page is selected, inserts AFTER it (matches PDF
              Expert's mental model). Size matches the doc's first page
              so mixed-paper docs don't regress to an unexpected paper. */}
          <button
            type="button"
            data-testid="sidebar-new-page"
            onClick={async () => {
              const selection = Array.from(activeTab.selectedPages);
              const afterPage = selection.length === 1 ? selection[0] : activeTab.numPages;
              await insertBlankAfterPage(afterPage);
            }}
            className="mt-1 flex h-10 items-center justify-center gap-1.5 rounded-md border border-dashed border-[var(--panel-border)] text-[12px] text-[var(--muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            title="Insert a blank page after the current selection (or at the end)"
          >
            <span className="text-[14px] leading-none">+</span>
            <span>New page</span>
          </button>
        </div>
      </div>}
    </aside>
    <PromptModal
      open={!!pageLabelPrompt}
      title="Set page label"
      description={`Add a prefix starting on page ${pageLabelPrompt?.pageNumber ?? 1}. Leave blank to return that range to plain page numbers.`}
      label="Prefix"
      initialValue=""
      placeholder="Section A-"
      submitLabel="Apply label"
      allowEmpty
      onSubmit={(value) =>
        pageLabelPrompt
          ? applyPageLabel(pageLabelPrompt.pageNumber, value)
          : undefined
      }
      onClose={() => setPageLabelPrompt(null)}
    />
    </>
  );
}

function SidebarTabButton({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-6 flex-1 items-center justify-center rounded text-[11px] font-medium uppercase tracking-wider transition-colors",
        active
          ? "bg-[var(--panel-bg-raised)] text-[var(--app-fg)]"
          : "text-[var(--muted)] hover:text-[var(--app-fg)]",
      )}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

function SidebarIcon({
  label,
  onClick,
  children,
  danger,
  ...rest
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
  "data-testid"?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] transition-colors",
        "hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]",
        danger && "hover:bg-[color-mix(in_srgb,var(--color-destructive)_15%,transparent)] hover:text-[var(--color-destructive)]",
      )}
      data-testid={rest["data-testid"]}
    >
      {children}
    </button>
  );
}

type ThumbProps = {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  active: boolean;
  selected: boolean;
  tab: DocumentTab;
  thumbScale: number;
  onActivate: (mode: "set" | "toggle" | "range") => void;
  onContextMenu: (clientX: number, clientY: number) => void;
  onAddPageAfter: () => void;
  showAddPageAfter: boolean;
};

/** V1.0055: 2px horizontal accent bar shown between thumbnails during an
 *  external-PDF drag to mark the insertion point. */
function DropIndicator() {
  return (
    <div
      className="h-0.5 w-full rounded-full bg-[var(--color-accent)]"
      aria-hidden
    />
  );
}

function AddPageSegment({
  afterPage,
  onClick,
  widthPx,
}: {
  afterPage: number;
  onClick: () => void;
  widthPx: number;
}) {
  return (
    <div
      className="group -my-1 flex h-7 items-center justify-center"
      data-testid={`sidebar-add-page-slot-${afterPage}`}
    >
      <button
        type="button"
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClick();
        }}
        style={{ width: widthPx }}
        className={cn(
          "group/add flex h-6 items-center gap-2 rounded-md px-1 text-[11px] font-medium text-[var(--muted)] opacity-0 transition",
          "group-hover:opacity-100 hover:bg-[var(--hover-bg)] hover:text-[var(--color-accent)] hover:opacity-100",
          "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50",
        )}
        data-testid={`sidebar-add-page-after-${afterPage}`}
        aria-label={`Add page after page ${afterPage}`}
      >
        <span className="h-px flex-1 rounded-full bg-[var(--panel-border-strong)] transition-colors group-hover/add:bg-[var(--color-accent)]" />
        <span className="flex items-center gap-1 whitespace-nowrap">
          <Plus className="h-3 w-3" strokeWidth={1.8} />
          Add page
        </span>
        <span className="h-px flex-1 rounded-full bg-[var(--panel-border-strong)] transition-colors group-hover/add:bg-[var(--color-accent)]" />
      </button>
    </div>
  );
}

function collapsePageRanges(pageNumbers: number[]): string {
  if (pageNumbers.length === 0) return "";
  const pages = [...pageNumbers].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = pages[0];
  let prev = pages[0];
  for (let i = 1; i < pages.length; i++) {
    const page = pages[i];
    if (page === prev + 1) {
      prev = page;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = page;
    prev = page;
  }
  ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  return ranges.join(", ");
}

function pageDragFileName(tabName: string, pageNumbers: number[]): string {
  const baseName = tabName.replace(/\.pdf$/i, "");
  if (pageNumbers.length === 1) {
    return `${baseName} - page ${pageNumbers[0]}.pdf`;
  }
  return `${baseName} - pages ${collapsePageRanges(pageNumbers)}.pdf`;
}

function Thumb({
  pdf,
  pageNumber,
  active,
  selected,
  tab,
  thumbScale,
  onActivate,
  onContextMenu,
  onAddPageAfter,
  showAddPageAfter,
}: ThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  // V1.0090: thumbnail must reflect pending overlays the user has placed
  // but not yet committed. Pre-V1.0090 the canvas only rendered baked
  // bytes via pdf.js, so on a new/blank doc with several pending text
  // overlays the thumbnail looked completely empty. Adam: "the preview
  // on the left sidebar doesnt update as we update the content, see its
  // blank". The agent recommendation was "show baked-only" but his real
  // complaint was that BAKED + PENDING aren't both reflected. Compromise:
  // after the baked render, overlay simple indicator rectangles for each
  // pending text/image/shape on this page — enough to communicate "stuff
  // is here" without trying to be a perfect mini-renderer.
  // V1.0094 / V1.0095 freeze fix.
  //
  // V1.0094 step 1: pre-V1.0094 these were inline `.filter(...)` calls
  // computed during render. Each render created brand-new array references,
  // which were in the useEffect dep array below — so every parent re-render
  // re-fired the effect, kicking off a fresh pdf.js `page.render(...)` per
  // thumbnail. Memoising the slices stops that loop.
  //
  // V1.0095 step 2: even with stable refs across "no-op" renders, the effect
  // STILL re-fires for every actual edit — every drag-move pointer event,
  // every keystroke while editing text — because the zustand arrays get a
  // new ref per mutation. With N pending edits and a fast typist, the
  // pdf.js worker (single-threaded) backs up faster than it can drain;
  // the main thread eventually waits and the app freezes. Adam: "every time
  // I open it and try to edit text, sometimes even without editing."
  //
  // The thumbnail is 150px wide — moving an indicator rect by 1pt is
  // invisible at that scale. So we depend only on the COUNT signature
  // (changes only when an overlay is added or removed) and read the latest
  // arrays via refs inside the effect. The thumbnail's pending-rect
  // positions are stale during a drag but snap to the right place on
  // overlay add/remove or any commit (`tab.version` bump).
  const pendingText = useMemo(
    () => tab.pendingTextEdits.filter((e) => e.page === pageNumber),
    [tab.pendingTextEdits, pageNumber],
  );
  const pendingImage = useMemo(
    () => tab.pendingImageEdits.filter((e) => e.page === pageNumber),
    [tab.pendingImageEdits, pageNumber],
  );
  const pendingShape = useMemo(
    () => tab.pendingShapeEdits.filter((e) => e.page === pageNumber),
    [tab.pendingShapeEdits, pageNumber],
  );
  const pendingCount = pendingText.length + pendingImage.length + pendingShape.length;
  // Latest-values refs for the effect to read without re-firing on every
  // pointer move.
  const pendingTextRef = useRef(pendingText);
  const pendingImageRef = useRef(pendingImage);
  const pendingShapeRef = useRef(pendingShape);
  pendingTextRef.current = pendingText;
  pendingImageRef.current = pendingImage;
  pendingShapeRef.current = pendingShape;

  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<import("pdfjs-dist").PDFPageProxy["render"]> | null = null;
    (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      // V1.0105: thumb width scales with sidebarThumbScale (0.6×–2.0×).
      const target = 150 * thumbScale;
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = target / baseViewport.width;
      const viewport = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      setDims({ w: viewport.width, h: viewport.height });
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      task = page.render({ canvasContext: ctx, viewport });
      try {
        await task.promise;
      } catch {
        /* cancelled */
      }
      if (cancelled) return;
      // V1.0090: overlay pending edits as indicator rects. PDF-point
      // coords scale by `scale` directly (since target=150 means CSS px
      // = PDF-point × scale). Y flips because PDF origin is bottom-left.
      const pageHPt = baseViewport.height;
      // Subtle accent fill at low alpha so the thumbnail still reads as
      // "the page". 30% alpha is enough to see at thumbnail scale.
      ctx.fillStyle = "rgba(109, 94, 245, 0.30)"; // var(--color-accent) at 30%
      ctx.strokeStyle = "rgba(109, 94, 245, 0.55)";
      ctx.lineWidth = 0.5;
      // V1.0095: read the latest arrays via refs (NOT via deps) so that
      // every keystroke / drag pointer-move doesn't re-queue a pdf.js
      // render task. Positions in the thumbnail are stale during a drag
      // but snap when overlay count changes or version bumps.
      for (const e of pendingTextRef.current) {
        const w = (e.widthPt ?? Math.max(40, e.size * 6)) * scale;
        const h = e.size * 1.2 * scale;
        const x = e.xPt * scale;
        const y = (pageHPt - e.yPt - e.size) * scale;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
      }
      for (const e of pendingImageRef.current) {
        const w = e.widthPt * scale;
        const h = e.heightPt * scale;
        const x = e.xPt * scale;
        const y = (pageHPt - e.yPt - e.heightPt) * scale;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
      }
      for (const e of pendingShapeRef.current) {
        // Compute a bounding box per shape kind. Skip kinds we can't
        // cheaply bound; the indicator is best-effort.
        let bbox: { x: number; y: number; w: number; h: number } | null = null;
        if ("widthPt" in e && "heightPt" in e && "xPt" in e && "yPt" in e) {
          bbox = {
            x: e.xPt * scale,
            y: (pageHPt - e.yPt - e.heightPt) * scale,
            w: e.widthPt * scale,
            h: e.heightPt * scale,
          };
        }
        if (bbox) {
          ctx.fillRect(bbox.x, bbox.y, bbox.w, bbox.h);
          ctx.strokeRect(bbox.x, bbox.y, bbox.w, bbox.h);
        }
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, pageNumber, tab.version, pendingCount, thumbScale]);

  // V1.0045: the entire thumbnail is HTML5-draggable. Plain drag from anywhere
  // on the page card -> drag-out. No modifier, no dedicated handle, no per-app
  // training. Reorder lives in the right-click menu's "Move up / Move down".
  // Implementation: the wrapping <div> (NOT a <button>) carries
  // `draggable={true}` because Chromium will not initiate a native drag on a
  // <button> ancestor (the button intercepts mousedown for its own click and
  // dragstart never fires). Click-to-select stays on an inner <button> so
  // keyboard + a11y remain intact.
  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    if (!tab.bytes) return;
    // Cancel the browser's default native drag (uses the canvas image as the
    // drag image, looks bad). Electron's `webContents.startDrag()` will begin
    // a new OS-level drag with the file payload + WeavePDF app icon.
    e.preventDefault();
    const slice = tab.bytes.slice().buffer;
    const selectedPages = Array.from(tab.selectedPages).sort((a, b) => a - b);
    const pageNumbers =
      selected && selectedPages.length > 1 ? selectedPages : [pageNumber];
    // V1.0105: remember which pages this drag carries so a drop back into
    // the sidebar's thumbnail panel can be resolved as a reorder rather
    // than as the V1.0055 PDF merge.
    internalDragState = { pageNumbers, startedAt: Date.now() };
    window.weavepdf.pages.startDrag({
      bytes: slice,
      pageNumbers,
      fileName: pageDragFileName(tab.name, pageNumbers),
    });
  };

  return (
    <div
      draggable={!!tab.bytes}
      onDragStart={handleDragStart}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      className="group relative flex flex-col items-center gap-1.5"
      data-testid="thumb-row"
      data-page-number={pageNumber}
    >
      <button
        type="button"
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey) onActivate("toggle");
          else if (e.shiftKey) onActivate("range");
          else onActivate("set");
        }}
        // The button is intentionally non-draggable so dragstart fires on the
        // outer <div> instead. (Buttons stop dragstart from bubbling to
        // ancestors, but with draggable={false} on the button, the drag
        // gesture never starts on the button at all — it begins on the div
        // wrapping it.)
        draggable={false}
        className="relative cursor-default"
        aria-label={`Page ${pageNumber}`}
        data-testid="thumb-button"
        data-selected={selected || undefined}
      >
        <div
          className={cn(
            "relative overflow-hidden rounded-[10px] bg-white ring-1 transition-all",
            selected
              ? "ring-2 ring-[var(--color-accent)]"
              : active
                ? "ring-2 ring-[var(--color-accent)]/60"
                : "ring-[var(--thumb-ring)] group-hover:ring-[var(--panel-border-strong)]",
          )}
          style={{ width: dims?.w ?? 150, height: dims?.h ?? 195 }}
        >
          <canvas
            ref={canvasRef}
            style={{ width: "100%", height: "100%", display: "block", pointerEvents: "none" }}
          />
          {selected && (
            <div className="pointer-events-none absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--color-accent)] text-white">
              <svg viewBox="0 0 12 12" className="h-2.5 w-2.5">
                <path d="M2.5 6l2.5 2.5L9.5 3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          )}
        </div>
      </button>
      <span
        className={cn(
          "tnum text-[11px] transition-colors",
          active || selected
            ? "font-medium text-[var(--app-fg)]"
            : "text-[var(--muted)]",
        )}
      >
        {pageNumber}
      </span>
      {showAddPageAfter && (
        <AddPageSegment
          afterPage={pageNumber}
          onClick={onAddPageAfter}
          widthPx={Math.round(150 * thumbScale)}
        />
      )}
    </div>
  );
}
