import { FilePlus2, PanelLeft, Save, Search, X, Share, BookOpen, FileText, Book } from "lucide-react";
import { useDocumentStore } from "../../stores/document";
import { useUIStore } from "../../stores/ui";
import { cn } from "../../lib/cn";
import { ShortcutTooltip } from "../ShortcutTooltip/ShortcutTooltip";
import { requestCloseTab, requestCloseTabs } from "../../lib/close-tab";
import type { ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const horizontalOnly: Modifier = ({ transform }) => ({ ...transform, y: 0 });

type SortableBag = {
  setNodeRef: (el: HTMLElement | null) => void;
  style: React.CSSProperties;
  attributes: ReturnType<typeof useSortable>["attributes"];
  listeners: ReturnType<typeof useSortable>["listeners"];
  isDragging: boolean;
};

function SortableTab({ id, children }: { id: string; children: (s: SortableBag) => ReactNode }) {
  const { setNodeRef, transform, transition, attributes, listeners, isDragging } = useSortable({ id });
  return (
    <>
      {children({
        setNodeRef,
        style: { transform: CSS.Translate.toString(transform), transition },
        attributes,
        listeners,
        isDragging,
      })}
    </>
  );
}

type Props = {
  onOpen: () => void;
  onSave: () => void;
  onExport: () => void;
};

export function Titlebar({ onOpen, onSave, onExport }: Props) {
  const tabs = useDocumentStore((s) => s.tabs);
  const activeTabId = useDocumentStore((s) => s.activeTabId);
  const activeTab = useDocumentStore((s) => s.activeTab());
  const setActiveTab = useDocumentStore((s) => s.setActiveTab);
  const moveTab = useDocumentStore((s) => s.moveTab);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const to = tabs.findIndex((t) => t.id === e.over!.id);
    if (to >= 0) moveTab(String(e.active.id), to);
  };
  const openContextMenu = useUIStore((s) => s.openContextMenu);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const openSearch = useUIStore((s) => s.openSearch);
  const openPalette = useUIStore((s) => s.openPalette);
  const viewMode = useUIStore((s) => s.viewMode);
  const setViewMode = useUIStore((s) => s.setViewMode);
  const hasDocs = tabs.length > 0;
  const cycleViewMode = () => {
    const next: typeof viewMode =
      viewMode === "single" ? "spread" : viewMode === "spread" ? "cover-spread" : "single";
    setViewMode(next);
  };

  function viewModeLabel(m: typeof viewMode): string {
    return m === "single" ? "single page" : m === "spread" ? "two-page spread" : "cover + spread";
  }

  return (
    <header className="drag-region flex h-11 shrink-0 items-center gap-1 border-b border-[var(--panel-border)] bg-[var(--panel-bg)] pl-[84px] pr-2">
      <ShortcutTooltip label="Toggle sidebar" shortcut="⇧⌘B">
        <button
          type="button"
          onClick={toggleSidebar}
          disabled={!hasDocs}
          className={cn(
            "no-drag flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] transition-colors",
            "hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]",
            "disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--muted)]",
            sidebarOpen && hasDocs && "text-[var(--app-fg)]",
          )}
          aria-label="Toggle sidebar"
          title="Toggle sidebar  ⇧⌘B"
        >
          <PanelLeft className="h-[15px] w-[15px]" strokeWidth={1.75} />
        </button>
      </ShortcutTooltip>

      {/* V1.0103: pre-V1.0103 the whole tab-strip container had `no-drag`
          when any tab was open — meant the empty space NEXT to / BETWEEN
          tabs (which looks like draggable titlebar) didn't drag the
          window. Particularly noticeable with one short tab and a wide
          window. Now: container stays draggable (inherits `drag` from the
          parent header); each tab button + close X is the only `no-drag`
          surface so clicks still work. Horizontal trackpad scroll inside
          a drag region works fine; scrollbar-drag is a rare path for
          tabs and stays as the trade-off. */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto acr-scroll px-1">
        {/* V1.0129: tabs can be dragged to reorder (Adam: "I should be able
            to move tabs around"). A 5 px activation distance keeps a plain
            click a click. Horizontal only. Keyboard/menu parity: right-click
            → Move Tab Left / Right. */}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[horizontalOnly]}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
            {tabs.map((t, idx) => (
              <SortableTab key={t.id} id={t.id}>
                {(sortable) => (
                  <button
                    ref={sortable.setNodeRef}
                    style={sortable.style}
                    {...sortable.attributes}
                    {...sortable.listeners}
                    type="button"
                    onClick={() => setActiveTab(t.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      const hasOthers = tabs.length > 1;
                      const hasRight = idx < tabs.length - 1;
                      openContextMenu(e.clientX, e.clientY, [
                        { kind: "item", label: "Close tab", onClick: () => void requestCloseTab(t.id), shortcut: "⌘W" },
                        { kind: "item", label: "Close other tabs", onClick: () => void requestCloseTabs(tabs.filter((o) => o.id !== t.id).map((o) => o.id)), disabled: !hasOthers },
                        { kind: "item", label: "Close tabs to the right", onClick: () => void requestCloseTabs(tabs.slice(idx + 1).map((o) => o.id)), disabled: !hasRight },
                        { kind: "separator" },
                        { kind: "item", label: "Move Tab Left", onClick: () => moveTab(t.id, idx - 1), disabled: idx === 0 },
                        { kind: "item", label: "Move Tab Right", onClick: () => moveTab(t.id, idx + 1), disabled: !hasRight },
                      ]);
                    }}
                    className={cn(
                      "no-drag group flex h-7 min-w-[140px] max-w-[240px] shrink-0 items-center gap-2 rounded-md border px-2.5 text-[13px] transition-colors",
                      sortable.isDragging && "z-10 opacity-80 shadow-lg",
                      t.id === activeTabId
                        ? "border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] text-[var(--app-fg)]"
                        : "border-transparent text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]",
                    )}
                    title={t.path ?? t.name}
                    data-testid="tab"
                    data-tab-name={t.name}
                    data-active={t.id === activeTabId || undefined}
                  >
                    <span className="truncate">
                      {t.dirty && (
                        <span
                          className="mr-1 inline-block h-1.5 w-1.5 translate-y-[-1px] rounded-full bg-[var(--color-accent)] align-middle"
                          aria-label="Unsaved changes"
                        />
                      )}
                      {t.name}
                    </span>
                    <span
                      role="button"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        // V1.0123: prompt when the tab holds unsaved work — this used
                        // to discard a placed signature / typed text with no warning.
                        void requestCloseTab(t.id);
                      }}
                      className={cn(
                        "no-drag ml-auto inline-flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 transition-opacity",
                        "hover:bg-[var(--active-bg)]",
                        "group-hover:opacity-100",
                        t.id === activeTabId && "opacity-70",
                      )}
                      aria-label={`Close ${t.name}`}
                      data-testid="tab-close"
                      data-tab-name={t.name}
                    >
                      <X className="h-3 w-3" strokeWidth={2} />
                    </span>
                  </button>
                )}
              </SortableTab>
            ))}
          </SortableContext>
        </DndContext>
      </div>

      <div className="no-drag flex items-center gap-1">
        <ShortcutTooltip label={`View · ${viewModeLabel(viewMode)}`} shortcut="⌘⌥1/2/3">
          <button
            type="button"
            onClick={cycleViewMode}
            disabled={!hasDocs}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] transition-colors",
              "hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]",
              "disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--muted)]",
              viewMode !== "single" && hasDocs && "text-[var(--app-fg)]",
            )}
            aria-label={`View mode: ${viewMode}`}
            title={`View · ${viewModeLabel(viewMode)} (click to cycle)  ⌘⌥1/2/3`}
            data-testid="view-mode-toggle"
          >
            {viewMode === "single" ? (
              <FileText className="h-[15px] w-[15px]" strokeWidth={1.75} />
            ) : viewMode === "spread" ? (
              <BookOpen className="h-[15px] w-[15px]" strokeWidth={1.75} />
            ) : (
              <Book className="h-[15px] w-[15px]" strokeWidth={1.75} />
            )}
          </button>
        </ShortcutTooltip>
        <ShortcutTooltip label="Command palette" shortcut="⌘K">
          <button
            type="button"
            onClick={openPalette}
            disabled={!hasDocs}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[11px] text-[var(--muted)] transition-colors",
              "hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]",
              "disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--muted)]",
            )}
            aria-label="Command palette"
            title="Command palette  ⌘K"
          >
            <kbd className="rounded bg-[var(--hover-bg)] px-1 py-0.5 font-mono text-[10px]">⌘K</kbd>
          </button>
        </ShortcutTooltip>
        <ShortcutTooltip label="Search" shortcut="⌘F">
          <button
            type="button"
            onClick={openSearch}
            disabled={!hasDocs}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] transition-colors",
              "hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]",
              "disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--muted)]",
            )}
            aria-label="Search"
            title="Search  ⌘F"
          >
            <Search className="h-[15px] w-[15px]" strokeWidth={1.75} />
          </button>
        </ShortcutTooltip>
        <ShortcutTooltip label="Save" shortcut="⌘S">
          <button
            type="button"
            onClick={onSave}
            disabled={!activeTab}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] transition-colors",
              "hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]",
              "disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--muted)]",
            )}
            aria-label="Save"
            title="Save  ⌘S"
            data-testid="save-button"
          >
            <Save className="h-[15px] w-[15px]" strokeWidth={1.75} />
          </button>
        </ShortcutTooltip>
        <ShortcutTooltip label="Export combined PDF" shortcut="⌘E">
          <button
            type="button"
            onClick={onExport}
            disabled={!hasDocs}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] transition-colors",
              "hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]",
              "disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--muted)]",
            )}
            aria-label="Export combined PDF"
            title="Export combined PDF  ⌘E"
            data-testid="export-button"
          >
            <Share className="h-[15px] w-[15px]" strokeWidth={1.75} />
          </button>
        </ShortcutTooltip>
        <ShortcutTooltip label="Open" shortcut="⌘O">
          <button
            type="button"
            onClick={onOpen}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors",
              "bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] active:bg-[var(--color-accent-press)]",
            )}
            title="Open  ⌘O"
          >
            <FilePlus2 className="h-[13px] w-[13px]" strokeWidth={2} />
            Open
          </button>
        </ShortcutTooltip>
      </div>
    </header>
  );
}
