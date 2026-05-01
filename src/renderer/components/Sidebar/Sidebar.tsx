import { useEffect, useRef, useState } from "react";
// V1.0045: removed @dnd-kit's drag-to-reorder. The thumbnail's plain
// drag is now reserved for HTML5 native drag-out (drag a page to Finder
// to extract it as a one-page PDF). Reorder lives in the right-click
// menu via "Move up" / "Move down" — same end result, no gesture
// disambiguation needed.
import { RotateCw, RotateCcw, Trash2 } from "lucide-react";
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

type Props = {
  /**
   * Restore a draft from the Revisions tab. Implementation lives in App.tsx
   * because draft restore touches the file system and tab/document store.
   */
  onRestoreRevision: (manifest: DraftManifest) => Promise<void>;
};

export function Sidebar({ onRestoreRevision }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const setCurrentPage = useDocumentStore((s) => s.setCurrentPage);
  const selectPage = useDocumentStore((s) => s.selectPage);
  const clearSelection = useDocumentStore((s) => s.clearSelection);
  const applyEdit = useDocumentStore((s) => s.applyEdit);
  const open = useUIStore((s) => s.sidebarOpen);
  const sidebarTab = useUIStore((s) => s.sidebarTab);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);
  const [pageLabelPrompt, setPageLabelPrompt] = useState<{ pageNumber: number } | null>(null);

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

  return (
    <>
    <aside className="flex h-full w-[200px] shrink-0 flex-col border-r border-[var(--panel-border)] bg-[var(--panel-bg)]">
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
        <RevisionsPanel onRestore={onRestoreRevision} />
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
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--panel-border)] px-3 text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">
          Pages
          <span className="tnum normal-case text-[var(--muted)]">
            {activeTab.currentPage} / {activeTab.numPages}
          </span>
        </div>
      )}

      {sidebarTab === "pages" && <div
        className="acr-scroll flex-1 overflow-y-auto p-3"
        onMouseDown={(e) => {
          // Clicking empty space clears the selection.
          if (e.target === e.currentTarget) clearSelection(activeTab.id);
        }}
      >
        <div className="flex flex-col gap-3">
          {Array.from({ length: activeTab.numPages }, (_, i) => i + 1).map((pageNumber) => (
            <Thumb
              key={`${activeTab.id}-${activeTab.version}-${pageNumber}`}
              pdf={activeTab.pdf!}
              pageNumber={pageNumber}
              active={activeTab.currentPage === pageNumber}
              selected={activeTab.selectedPages.has(pageNumber)}
              tab={activeTab}
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
                      if (!w.ok) alert(`Extract failed: ${w.error}`);
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
            />
          ))}
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
  onActivate: (mode: "set" | "toggle" | "range") => void;
  onContextMenu: (clientX: number, clientY: number) => void;
};

function Thumb({ pdf, pageNumber, active, selected, tab, onActivate, onContextMenu }: ThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<import("pdfjs-dist").PDFPageProxy["render"]> | null = null;
    (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const target = 150;
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
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, pageNumber, tab.version]);

  // V1.0045: the entire thumbnail is HTML5-draggable. Plain drag from anywhere
  // on the page card → drag-out. No modifier, no dedicated handle, no per-app
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
    const baseName = tab.name.replace(/\.pdf$/i, "");
    window.weavepdf.pages.startDrag({
      bytes: slice,
      pageNumber,
      fileName: `${baseName} - page ${pageNumber}.pdf`,
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
      title={
        tab.bytes
          ? `Page ${pageNumber} — click to view, drag to Finder to extract this page`
          : `Page ${pageNumber}`
      }
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
    </div>
  );
}
