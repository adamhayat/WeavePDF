import { useEffect, useRef, useState, useMemo } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { RotateCw, RotateCcw, Trash2, ArrowUpRight } from "lucide-react";
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const pageIds = useMemo(
    () => (activeTab ? Array.from({ length: activeTab.numPages }, (_, i) => `p-${i + 1}`) : []),
    [activeTab?.numPages, activeTab?.id, activeTab?.version],
  );

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

  const handleDragEnd = async (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id || !activeTab.bytes) return;
    const oldIndex = pageIds.indexOf(String(active.id));
    const newIndex = pageIds.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    // 0-based indices in new display order.
    const newOrder = arrayMove(
      Array.from({ length: activeTab.numPages }, (_, i) => i),
      oldIndex,
      newIndex,
    );
    const { reorderPages } = await loadPdfOps();
    const newBytes = await reorderPages(activeTab.bytes, newOrder);
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
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={pageIds} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-3">
              {pageIds.map((id, i) => {
                const pageNumber = i + 1;
                return (
                  <SortableThumb
                    key={`${activeTab.id}-${activeTab.version}-${id}`}
                    id={id}
                    pdf={activeTab.pdf!}
                    pageNumber={pageNumber}
                    active={activeTab.currentPage === pageNumber}
                    selected={activeTab.selectedPages.has(pageNumber)}
                    onActivate={(mode) => {
                      if (mode === "set") {
                        setCurrentPage(activeTab.id, pageNumber);
                        selectPage(activeTab.id, pageNumber, "set");
                      } else {
                        selectPage(activeTab.id, pageNumber, mode);
                      }
                    }}
                    onContextMenu={(clientX, clientY) => {
                      const selection = activeTab.selectedPages.has(pageNumber) && activeTab.selectedPages.size > 1
                        ? Array.from(activeTab.selectedPages).sort((a, b) => a - b)
                        : [pageNumber];
                      const multi = selection.length > 1;
                      useUIStore.getState().openContextMenu(clientX, clientY, [
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
                          disabled: multi, // multi-duplicate is ambiguous
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
                    tab={activeTab}
                  />
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
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
  id: string;
  pdf: PDFDocumentProxy;
  pageNumber: number;
  active: boolean;
  selected: boolean;
  tab: DocumentTab;
  onActivate: (mode: "set" | "toggle" | "range") => void;
  onContextMenu: (clientX: number, clientY: number) => void;
};

function SortableThumb({ id, pdf, pageNumber, active, selected, tab, onActivate, onContextMenu }: ThumbProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
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

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
      }}
      className="group relative flex flex-col items-center gap-1.5"
      data-testid="thumb-row"
      data-page-number={pageNumber}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey) onActivate("toggle");
          else if (e.shiftKey) onActivate("range");
          else onActivate("set");
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(e.clientX, e.clientY);
        }}
        className="relative"
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
            style={{ width: "100%", height: "100%", display: "block" }}
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
      {/*
        V1.0044: Drag-out handle. Plain drag on the thumbnail is bound to
        @dnd-kit's sortable reorder, so the drag-to-Finder gesture lives on
        this dedicated handle. It's an absolutely-positioned overlay sibling
        of the button (NOT a child) — Chromium will not fire a fresh
        `dragstart` on a `draggable=true` element nested inside a `<button>`
        ancestor, because the button captures the mousedown for its own
        click-handling and the pointer events never reach the inner span.
        Hoisting the span out into the parent's `relative` flex column makes
        it a top-level draggable in the page tree, so dragstart fires
        reliably on the handle alone.
        Pre-V1.0044 attempts: ⌥ Option modifier on the whole thumbnail (V1.0043,
        fragile UX + extraction latency aborted the gesture); same handle but
        nested inside the button (V1.0044a, dragstart never fired).
      */}
      {tab.bytes && (
        <span
          role="button"
          tabIndex={-1}
          draggable={true}
          onPointerDown={(e) => {
            // Don't activate the page click or @dnd-kit's pointer sensor.
            e.stopPropagation();
          }}
          onMouseDown={(e) => {
            // Mousedown also stops here so the button beneath doesn't see it.
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
          }}
          onDragStart={(e) => {
            // Cancel the browser's default drag (which would be the icon as
            // a transparent PNG); Electron's `webContents.startDrag()` will
            // begin a new OS-level drag with the file payload + app icon.
            e.preventDefault();
            if (!tab.bytes) return;
            const slice = tab.bytes.slice().buffer;
            const baseName = tab.name.replace(/\.pdf$/i, "");
            window.weavepdf.pages.startDrag({
              bytes: slice,
              pageNumber,
              fileName: `${baseName} - page ${pageNumber}.pdf`,
            });
          }}
          title={`Drag to Finder / Desktop to extract page ${pageNumber} as a PDF`}
          aria-label={`Drag page ${pageNumber} to Finder`}
          className={cn(
            "absolute top-1 left-1 z-10 flex h-5 w-5 cursor-grab items-center justify-center rounded-full",
            "bg-[var(--panel-bg-raised)] text-[var(--muted)] shadow ring-1 ring-[var(--panel-border)]",
            "transition-opacity duration-150 hover:text-[var(--color-accent)] active:cursor-grabbing",
            "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
            selected && "opacity-100",
          )}
          data-testid="thumb-drag-out"
        >
          <ArrowUpRight className="h-3 w-3" strokeWidth={2.2} />
        </span>
      )}
    </div>
  );
}
