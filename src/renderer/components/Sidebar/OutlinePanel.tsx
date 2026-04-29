import { useEffect, useState } from "react";
import { ChevronRight, ChevronDown, ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { useDocumentStore } from "../../stores/document";
import type { PDFDocumentProxy } from "../../lib/pdfjs";
import { cn } from "../../lib/cn";

type RawNode = {
  title: string;
  items: RawNode[];
  dest: unknown;
};

type Node = {
  title: string;
  children: Node[];
  pageIndex: number | null;
};

export function OutlinePanel() {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const setCurrentPage = useDocumentStore((s) => s.setCurrentPage);
  const [outline, setOutline] = useState<Node[] | null>(null);
  const [loading, setLoading] = useState(true);
  // Monotonic counter bumped whenever the user clicks "Expand/Collapse all" —
  // child items watch it via useEffect and reset their own `open` state.
  const [expandAllTick, setExpandAllTick] = useState(0);
  const [expandAllTo, setExpandAllTo] = useState<boolean | null>(null);

  useEffect(() => {
    setLoading(true);
    setOutline(null);
    if (!activeTab?.pdf) return;
    let cancelled = false;
    (async () => {
      try {
        const raw = (await activeTab.pdf!.getOutline()) as RawNode[] | null;
        if (cancelled) return;
        if (!raw) {
          setOutline([]);
          return;
        }
        const resolved = await Promise.all(raw.map((n) => resolveNode(activeTab.pdf!, n)));
        if (!cancelled) setOutline(resolved);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab?.id, activeTab?.version]);

  if (!activeTab?.pdf) {
    return (
      <div className="p-4 text-[12px] text-[var(--muted)]">No document open.</div>
    );
  }

  if (loading) {
    return (
      <div className="p-4 text-[12px] text-[var(--muted)]">Loading outline…</div>
    );
  }

  if (!outline || outline.length === 0) {
    return (
      <div className="p-4 text-[12px] text-[var(--muted)]">
        This PDF has no bookmarks.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="outline-panel">
      <div className="flex h-7 shrink-0 items-center justify-end gap-0.5 border-b border-[var(--panel-border)] px-1.5">
        <button
          type="button"
          onClick={() => {
            setExpandAllTo(true);
            setExpandAllTick((n) => n + 1);
          }}
          className="flex h-5 w-5 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]"
          title="Expand all"
          aria-label="Expand all"
        >
          <ChevronsUpDown className="h-3 w-3" strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={() => {
            setExpandAllTo(false);
            setExpandAllTick((n) => n + 1);
          }}
          className="flex h-5 w-5 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]"
          title="Collapse all"
          aria-label="Collapse all"
        >
          <ChevronsDownUp className="h-3 w-3" strokeWidth={2} />
        </button>
      </div>
      <div className="acr-scroll flex-1 overflow-y-auto p-2">
        {outline.map((n, i) => (
          <OutlineItem
            key={i}
            node={n}
            depth={0}
            expandAllTick={expandAllTick}
            expandAllTo={expandAllTo}
            onJump={(page) => {
              if (!activeTab || page == null) return;
              setCurrentPage(activeTab.id, Math.max(1, page));
            }}
          />
        ))}
      </div>
    </div>
  );
}

function OutlineItem({
  node,
  depth,
  expandAllTick,
  expandAllTo,
  onJump,
}: {
  node: Node;
  depth: number;
  expandAllTick: number;
  expandAllTo: boolean | null;
  onJump: (page: number | null) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = node.children.length > 0;
  useEffect(() => {
    if (expandAllTo !== null) setOpen(expandAllTo);
  }, [expandAllTick, expandAllTo]);
  return (
    <div>
      <div
        className={cn(
          "group flex cursor-pointer items-center gap-1 rounded px-1.5 py-1 text-[12px] hover:bg-[var(--hover-bg)]",
        )}
        style={{ paddingLeft: 4 + depth * 14 }}
        onClick={() => onJump(node.pageIndex)}
        role="button"
        tabIndex={0}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(!open);
            }}
            className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--muted)] hover:text-[var(--app-fg)]"
            aria-label={open ? "Collapse" : "Expand"}
          >
            {open ? (
              <ChevronDown className="h-3 w-3" strokeWidth={2} />
            ) : (
              <ChevronRight className="h-3 w-3" strokeWidth={2} />
            )}
          </button>
        ) : (
          <span className="h-4 w-4" />
        )}
        <span className="truncate">{node.title}</span>
      </div>
      {open && hasChildren && (
        <div>
          {node.children.map((c, i) => (
            <OutlineItem
              key={i}
              node={c}
              depth={depth + 1}
              expandAllTick={expandAllTick}
              expandAllTo={expandAllTo}
              onJump={onJump}
            />
          ))}
        </div>
      )}
    </div>
  );
}

async function resolveNode(pdf: PDFDocumentProxy, raw: RawNode): Promise<Node> {
  const pageIndex = await resolveDest(pdf, raw.dest);
  const children = await Promise.all((raw.items ?? []).map((i) => resolveNode(pdf, i)));
  return { title: raw.title || "Untitled", children, pageIndex };
}

async function resolveDest(pdf: PDFDocumentProxy, dest: unknown): Promise<number | null> {
  try {
    // `dest` is either a string (named dest) or an array of refs.
    let explicit: unknown[] | null = null;
    if (typeof dest === "string") {
      explicit = (await pdf.getDestination(dest)) as unknown[] | null;
    } else if (Array.isArray(dest)) {
      explicit = dest;
    }
    if (!explicit || explicit.length === 0) return null;
    const ref = explicit[0];
    // pdf.js returns a page reference; convert to page index.
    const pageIndex0 = await pdf.getPageIndex(ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0]);
    return pageIndex0 + 1;
  } catch {
    return null;
  }
}
