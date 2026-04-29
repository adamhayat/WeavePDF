import {
  Type,
  FileEdit,
  PenLine,
  Highlighter,
  Square,
  Circle,
  Minus,
  MoveUpRight,
  Eraser,
  Pencil,
  Image as ImageIcon,
  MessageSquare,
  Crop,
  RotateCw,
  RotateCcw,
  Trash2,
  Undo2,
  Redo2,
  Minimize2,
  Printer,
  Share,
  Save,
  Scissors,
  Droplets,
  FileText,
  Link as LinkIcon,
  Ruler,
  ShieldAlert,
} from "lucide-react";
import { useDocumentStore } from "../../stores/document";
import { useUIStore } from "../../stores/ui";
// Lazy-loaded so the pdf-lib chunk doesn't pull at boot. The Toolstrip
// is rendered eagerly when a doc is open, but rotatePages/deletePages
// only fire on a click — chunk parses on first such click.
const loadPdfOps = () => import("../../lib/pdf-ops");
import { cn } from "../../lib/cn";
import { ColorPopover } from "./ColorPopover";
import { ShortcutTooltip } from "../ShortcutTooltip/ShortcutTooltip";

type Props = {
  onSave: () => void;
  onExport: () => void;
  onPrint: () => void;
};

export function Toolstrip({ onSave, onExport, onPrint }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const applyEdit = useDocumentStore((s) => s.applyEdit);
  const undo = useDocumentStore((s) => s.undo);
  const redo = useDocumentStore((s) => s.redo);
  const tool = useUIStore((s) => s.tool);
  const setTool = useUIStore((s) => s.setTool);
  const openSignature = useUIStore((s) => s.openSignature);
  const openCompress = useUIStore((s) => s.openCompress);
  const openMetadata = useUIStore((s) => s.openMetadata);
  const openWatermark = useUIStore((s) => s.openWatermark);
  const openExtract = useUIStore((s) => s.openExtract);
  const openImagePicker = useUIStore((s) => s.openImagePicker);
  const openHeaderFooter = useUIStore((s) => s.openHeaderFooter);
  const openCrop = useUIStore((s) => s.openCrop);

  if (!activeTab) return null;

  const hasSelection = activeTab.selectedPages.size > 0;
  const canUndo =
    activeTab.history.length > 0 ||
    activeTab.pendingTextEdits.length > 0 ||
    activeTab.pendingImageEdits.length > 0 ||
    activeTab.pendingShapeEdits.length > 0;
  const canRedo = activeTab.redoStack.length > 0;

  const rotate = async (delta: 90 | -90 | 180) => {
    if (!activeTab.bytes) return;
    const targets = hasSelection
      ? Array.from(activeTab.selectedPages)
      : [activeTab.currentPage];
    const { rotatePages } = await loadPdfOps();
    const newBytes = await rotatePages(activeTab.bytes, targets, delta);
    await applyEdit(activeTab.id, newBytes);
  };

  const deleteSelected = async () => {
    if (!activeTab.bytes || !hasSelection) return;
    if (activeTab.selectedPages.size === activeTab.numPages) {
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

  const targetLabel = hasSelection
    ? `${activeTab.selectedPages.size} page${activeTab.selectedPages.size > 1 ? "s" : ""}`
    : `page ${activeTab.currentPage}`;

  const tt = (t: typeof tool) => () => setTool(tool === t ? "none" : t);

  return (
    <div
      className="no-drag flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--panel-border)] bg-[var(--panel-bg)] px-3"
      data-testid="toolstrip"
    >
      <ToolGroup>
        <ToolButton
          label="Text"
          hint="T"
          icon={<Type className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          active={tool === "text"}
          onClick={tt("text")}
          data-testid="tool-text"
        />
        <ToolButton
          label="Edit"
          hint="E"
          icon={<FileEdit className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          active={tool === "editText"}
          onClick={tt("editText")}
          data-testid="tool-edit-text"
          title="Edit existing text — click a word"
        />
        <ToolButton
          label="Sign"
          hint="S"
          icon={<PenLine className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          active={tool === "signature"}
          onClick={openSignature}
          data-testid="tool-signature"
        />
        <ToolButton
          label="Image"
          hint="I"
          icon={<ImageIcon className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          onClick={openImagePicker}
          data-testid="tool-image"
          title="Place an image"
        />
        <ToolButton
          label="Note"
          hint="N"
          icon={<MessageSquare className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          active={tool === "sticky"}
          onClick={tt("sticky")}
          data-testid="tool-sticky"
          title="Sticky note — click to place"
        />
        <ToolButton
          label="Highlight"
          hint="H"
          icon={<Highlighter className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          active={tool === "highlight"}
          onClick={tt("highlight")}
          data-testid="tool-highlight"
        />
        <ToolButton
          label="Whiteout"
          hint="W"
          icon={<Eraser className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          active={tool === "whiteout"}
          onClick={tt("whiteout")}
          data-testid="tool-whiteout"
          title="Whiteout — drag to cover an area"
        />
        <ToolButton
          label="Redact"
          hint="X"
          icon={<ShieldAlert className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          active={tool === "redact"}
          onClick={tt("redact")}
          danger
          data-testid="tool-redact"
          title="Redact — drag to permanently remove an area on save"
        />
      </ToolGroup>

      <Separator />

      <ToolGroup>
        <ToolButton
          label="Rect"
          hint="R"
          icon={<Square className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          active={tool === "rect"}
          onClick={tt("rect")}
          data-testid="tool-rect"
          title="Rectangle — drag to draw"
        />
        <ToolButton
          label="Circle"
          hint="O"
          icon={<Circle className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          active={tool === "circle"}
          onClick={tt("circle")}
          data-testid="tool-circle"
          title="Ellipse — drag to draw"
        />
        <ToolButton
          label="Line"
          hint="L"
          icon={<Minus className="h-[14px] w-[14px]" strokeWidth={2} />}
          active={tool === "line"}
          onClick={tt("line")}
          data-testid="tool-line"
          title="Line — drag start to end"
        />
        <ToolButton
          label="Arrow"
          hint="A"
          icon={<MoveUpRight className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          active={tool === "arrow"}
          onClick={tt("arrow")}
          data-testid="tool-arrow"
          title="Arrow — drag start to end"
        />
        <ToolButton
          label="Draw"
          hint="D"
          icon={<Pencil className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          active={tool === "draw"}
          onClick={tt("draw")}
          data-testid="tool-draw"
          title="Freehand — draw a path"
        />
        <ToolButton
          label="Link"
          hint="K"
          icon={<LinkIcon className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          active={tool === "link"}
          onClick={tt("link")}
          data-testid="tool-link"
          title="Link — drag a region, then pick URL or page"
        />
        <ToolButton
          label="Measure"
          hint="M"
          icon={<Ruler className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          active={tool === "measure"}
          onClick={tt("measure")}
          data-testid="tool-measure"
          title="Measure distance — drag from start to end"
        />
      </ToolGroup>

      <Separator />

      <ToolGroup>
        <ToolButton
          label="Rotate L"
          hint="⌘["
          icon={<RotateCcw className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          onClick={() => rotate(-90)}
          data-testid="tool-rotate-left"
          title={`Rotate ${targetLabel} left 90°`}
        />
        <ToolButton
          label="Rotate R"
          hint="⌘]"
          icon={<RotateCw className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          onClick={() => rotate(90)}
          data-testid="tool-rotate-right"
          title={`Rotate ${targetLabel} right 90°`}
        />
        <ToolButton
          label="Delete"
          hint="⌫"
          icon={<Trash2 className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          onClick={deleteSelected}
          disabled={!hasSelection}
          danger
          data-testid="tool-delete"
          title={hasSelection ? `Delete ${targetLabel}` : "Select pages to delete"}
        />
        <ToolButton
          label="Extract"
          hint="⌘⌥E"
          icon={<Scissors className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          onClick={openExtract}
          data-testid="tool-extract"
          title="Extract selected pages as new PDF"
        />
        <ToolButton
          label="Crop"
          hint="C"
          icon={<Crop className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          onClick={openCrop}
          data-testid="tool-crop"
          title="Crop page margins"
        />
      </ToolGroup>

      <Separator />

      <ToolGroup>
        <ToolButton
          label="Compress"
          hint="⌘⌥C"
          icon={<Minimize2 className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          onClick={openCompress}
          data-testid="tool-compress"
        />
        <ToolButton
          label="Watermark"
          hint="⌘⌥W"
          icon={<Droplets className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          onClick={openWatermark}
          data-testid="tool-watermark"
        />
        <ToolButton
          label="Header/Footer"
          hint="⌘⌥P"
          icon={<FileText className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          onClick={openHeaderFooter}
          data-testid="tool-header-footer"
          title="Header, footer, or page numbers"
        />
        <ToolButton
          label="Info"
          hint="⌘I"
          icon={<FileText className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          onClick={openMetadata}
          data-testid="tool-metadata"
          title="Document properties"
        />
        <ToolButton
          label="Print"
          hint="⌘P"
          icon={<Printer className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          onClick={onPrint}
          data-testid="tool-print"
        />
        <ToolButton
          label="Save"
          hint="⌘S"
          icon={<Save className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          onClick={onSave}
          data-testid="tool-save"
          primary={activeTab.dirty}
        />
        <ToolButton
          label="Export"
          hint="⌘E"
          icon={<Share className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          onClick={onExport}
          data-testid="tool-export"
        />
      </ToolGroup>

      <div className="ml-auto flex items-center gap-2 pl-2">
        <ColorPopover />
        <ToolButton
          label="Undo"
          hint="⌘Z"
          icon={<Undo2 className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          onClick={() => undo(activeTab.id)}
          disabled={!canUndo}
          data-testid="tool-undo"
        />
        <ToolButton
          label="Redo"
          hint="⌘⇧Z"
          icon={<Redo2 className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          onClick={() => redo(activeTab.id)}
          disabled={!canRedo}
          data-testid="tool-redo"
        />
      </div>
    </div>
  );
}

function ToolGroup({ children }: { children: React.ReactNode }) {
  return <div className="flex shrink-0 items-center gap-0.5">{children}</div>;
}

function Separator() {
  return <div className="mx-1 h-5 w-px bg-[var(--panel-border)]" />;
}

type ToolButtonProps = {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  hint?: string;
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
  primary?: boolean;
  title?: string;
  "data-testid"?: string;
};

function ToolButton({
  label,
  icon,
  onClick,
  hint,
  active,
  disabled,
  danger,
  primary,
  title,
  ...rest
}: ToolButtonProps) {
  const tooltip = title
    ? (hint ? `${title}  ${hint}` : title)
    : (hint ? `${label}  ${hint}` : label);
  return (
    <ShortcutTooltip label={title ?? label} shortcut={hint}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={tooltip}
        aria-label={label}
        className={cn(
          "flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors",
          "text-[var(--app-fg)] hover:bg-[var(--hover-bg)]",
          active &&
            "bg-[color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-[var(--color-accent)]",
          primary &&
            "bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)]",
          danger &&
            !disabled &&
            "hover:bg-[color-mix(in_srgb,var(--color-destructive)_15%,transparent)] hover:text-[var(--color-destructive)]",
          disabled && "cursor-default opacity-40 hover:bg-transparent",
        )}
        data-testid={rest["data-testid"]}
      >
        {icon}
        <span className="hidden xl:inline">{label}</span>
      </button>
    </ShortcutTooltip>
  );
}
