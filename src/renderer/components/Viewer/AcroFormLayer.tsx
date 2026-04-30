import { useEffect, useMemo, useState } from "react";
import type { PDFDocumentProxy } from "../../lib/pdfjs";
import { useDocumentStore } from "../../stores/document";
import type { FormFieldValue } from "../../lib/pdf-ops";

const loadPdfOps = () => import("../../lib/pdf-ops");

type Props = {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  pageHeightPt: number;
};

type PdfAnnotation = {
  subtype?: string;
  fieldName?: string;
  fieldType?: string;
  fieldValue?: unknown;
  rect?: number[];
  readOnly?: boolean;
  checkBox?: boolean;
  radioButton?: boolean;
  exportValue?: string;
  buttonValue?: string;
  options?: Array<string | { displayValue?: string; exportValue?: string }>;
  multiSelect?: boolean;
  hidden?: boolean;
};

type Widget = {
  name: string;
  kind: "text" | "checkbox" | "radio" | "dropdown";
  value: string;
  checked: boolean;
  readOnly: boolean;
  rect: [number, number, number, number];
  options: string[];
  exportValue?: string;
};

export function AcroFormLayer({ pdf, pageNumber, zoom, pageHeightPt }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const applyEdit = useDocumentStore((s) => s.applyEdit);
  const [widgets, setWidgets] = useState<Widget[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        const annotations = (await page.getAnnotations({ intent: "display" })) as PdfAnnotation[];
        if (cancelled) return;
        setWidgets(annotationsToWidgets(annotations));
      } catch {
        if (!cancelled) setWidgets([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf, pageNumber]);

  const radioSelections = useMemo(() => {
    const selections = new Map<string, string>();
    for (const w of widgets) {
      if (w.kind !== "radio") continue;
      if (w.value && w.value !== "Off") selections.set(w.name, w.value);
    }
    return selections;
  }, [widgets]);

  if (!activeTab?.bytes || widgets.length === 0) return null;

  const commit = async (value: FormFieldValue) => {
    const tab = useDocumentStore.getState().activeTab();
    if (!tab?.bytes) return;
    const { setFormFields } = await loadPdfOps();
    const newBytes = await setFormFields(tab.bytes, [value]);
    await applyEdit(tab.id, newBytes);
  };

  return (
    <div className="absolute inset-0 z-[6]" data-testid="acroform-layer">
      {widgets.map((widget, index) => (
        <FieldWidget
          key={`${widget.name}-${index}-${activeTab.version}`}
          widget={widget}
          zoom={zoom}
          pageHeightPt={pageHeightPt}
          radioChecked={radioSelections.get(widget.name) === widget.exportValue}
          onCommit={commit}
        />
      ))}
    </div>
  );
}

function FieldWidget({
  widget,
  zoom,
  pageHeightPt,
  radioChecked,
  onCommit,
}: {
  widget: Widget;
  zoom: number;
  pageHeightPt: number;
  radioChecked: boolean;
  onCommit: (value: FormFieldValue) => Promise<void>;
}) {
  const [value, setValue] = useState(widget.value);
  const [checked, setChecked] = useState(widget.checked || radioChecked);
  const [busy, setBusy] = useState(false);
  const [x1, y1, x2, y2] = widget.rect;
  const style = {
    left: x1 * zoom,
    top: (pageHeightPt - y2) * zoom,
    width: Math.max(1, (x2 - x1) * zoom),
    height: Math.max(1, (y2 - y1) * zoom),
  };

  useEffect(() => {
    setValue(widget.value);
  }, [widget.value]);

  useEffect(() => {
    setChecked(widget.checked || radioChecked);
  }, [widget.checked, radioChecked]);

  const runCommit = async (next: FormFieldValue) => {
    if (widget.readOnly || busy) return;
    setBusy(true);
    try {
      await onCommit(next);
    } finally {
      setBusy(false);
    }
  };

  if (widget.kind === "text") {
    // V1.0036: text fields render the value via pdf.js's baked-in widget
    // appearance after `applyEdit` runs `setFormFields`. If we ALSO show the
    // value in this HTML overlay, both layers render it slightly offset and
    // the user sees doubled / crossed-out text. Solution: make the input
    // text TRANSPARENT when not focused so the underlying pdf.js render is
    // the one that shows. While focused, switch to opaque white-bg + dark
    // text so the user can see exactly what they're typing — the pdf.js
    // canvas hasn't been updated yet for in-flight typing, so there's no
    // doubling. On blur, the bake fires, pdf.js re-renders, the input
    // returns to transparent, and the user sees one clean rendering.
    return (
      <input
        aria-label={widget.name}
        data-testid="acroform-text"
        className="acroform-text-input absolute rounded-[2px] border border-transparent bg-transparent px-1 text-[12px] leading-none outline-none transition-colors hover:border-[rgba(59,76,202,0.35)] focus:border-[var(--color-accent)] focus:bg-white focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-60"
        style={{
          ...style,
          // Transparent text by default → only pdf.js shows the value.
          // Caret stays visible so the user can see the focus position.
          color: "transparent",
          caretColor: "black",
        }}
        value={value}
        disabled={widget.readOnly || busy}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
        onFocus={(e) => {
          // Switch to opaque text while editing so user sees their typing.
          e.currentTarget.style.color = "black";
        }}
        onChange={(e) => setValue(e.target.value)}
        onBlur={(e) => {
          // Hand the visual rendering back to pdf.js. setFormFields →
          // applyEdit → pdf.js re-render handles the display from here.
          e.currentTarget.style.color = "transparent";
          if (value !== widget.value) {
            void runCommit({ name: widget.name, kind: "text", value });
          }
        }}
      />
    );
  }

  if (widget.kind === "checkbox") {
    return (
      <input
        aria-label={widget.name}
        data-testid="acroform-checkbox"
        type="checkbox"
        className="absolute accent-[var(--color-accent)]"
        style={style}
        checked={checked}
        disabled={widget.readOnly || busy}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
        onChange={(e) => {
          const next = e.target.checked;
          setChecked(next);
          void runCommit({ name: widget.name, kind: "checkbox", checked: next });
        }}
      />
    );
  }

  if (widget.kind === "radio") {
    return (
      <input
        aria-label={widget.name}
        data-testid="acroform-radio"
        type="radio"
        name={widget.name}
        className="absolute accent-[var(--color-accent)]"
        style={style}
        checked={checked}
        disabled={widget.readOnly || busy}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
        onChange={() => {
          if (widget.exportValue) {
            setChecked(true);
            void runCommit({ name: widget.name, kind: "radio", selected: widget.exportValue });
          }
        }}
      />
    );
  }

  return (
    <select
      aria-label={widget.name}
      data-testid="acroform-dropdown"
      className="absolute rounded-[2px] border border-transparent bg-white/70 px-1 text-[12px] text-black outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-60"
      style={style}
      value={value}
      disabled={widget.readOnly || busy}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onChange={(e) => {
        setValue(e.target.value);
        void runCommit({ name: widget.name, kind: "dropdown", selected: e.target.value || null });
      }}
    >
      <option value="" />
      {widget.options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

function annotationsToWidgets(annotations: PdfAnnotation[]): Widget[] {
  const widgets: Widget[] = [];
  for (const annotation of annotations) {
    if (annotation.subtype !== "Widget" || annotation.hidden) continue;
    if (!annotation.fieldName || !annotation.rect || annotation.rect.length !== 4) continue;
    const rect = normaliseRect(annotation.rect);
    const readOnly = annotation.readOnly ?? false;
    const fieldValue = typeof annotation.fieldValue === "string" ? annotation.fieldValue : "";

    if (annotation.fieldType === "Tx") {
      widgets.push({
        name: annotation.fieldName,
        kind: "text",
        value: fieldValue,
        checked: false,
        readOnly,
        rect,
        options: [],
      });
    } else if (annotation.fieldType === "Btn" && annotation.checkBox) {
      widgets.push({
        name: annotation.fieldName,
        kind: "checkbox",
        value: fieldValue,
        checked: fieldValue !== "" && fieldValue !== "Off",
        readOnly,
        rect,
        options: [],
        exportValue: annotation.exportValue ?? "Yes",
      });
    } else if (annotation.fieldType === "Btn" && annotation.radioButton) {
      const exportValue = annotation.buttonValue ?? annotation.exportValue;
      widgets.push({
        name: annotation.fieldName,
        kind: "radio",
        value: fieldValue,
        checked: fieldValue !== "" && fieldValue !== "Off",
        readOnly,
        rect,
        options: [],
        exportValue,
      });
    } else if (annotation.fieldType === "Ch") {
      widgets.push({
        name: annotation.fieldName,
        kind: "dropdown",
        value: fieldValue,
        checked: false,
        readOnly,
        rect,
        options: (annotation.options ?? []).map((option) =>
          typeof option === "string"
            ? option
            : (option.exportValue ?? option.displayValue ?? ""),
        ).filter(Boolean),
      });
    }
  }
  return widgets;
}

function normaliseRect(rect: number[]): [number, number, number, number] {
  const [a, b, c, d] = rect;
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}
