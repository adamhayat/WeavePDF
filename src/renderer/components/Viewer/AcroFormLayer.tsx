import { useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "../../lib/pdfjs";
import { useDocumentStore } from "../../stores/document";
import { useUIStore } from "../../stores/ui";
import { clearActiveFieldFlusher, setActiveFieldFlusher } from "../../lib/pending-field";
import type { FormFieldValue } from "../../lib/pdf-ops";

const loadPdfOps = () => import("../../lib/pdf-ops");

type Props = {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  pageHeightPt: number;
  /** V1.0073: when the Edit Text tool is active, the form widgets stop
   *  intercepting clicks for form-fill and instead route them through to
   *  spawn a pending text overlay (whiteout + editable). Lets the user
   *  apply WeavePDF's text format bar (font size, bold, alignment) to
   *  AcroForm field values. */
  editTextMode?: boolean;
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

export function AcroFormLayer({ pdf, pageNumber, zoom, pageHeightPt, editTextMode }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const applyEdit = useDocumentStore((s) => s.applyEdit);
  const addPendingTextEdit = useDocumentStore((s) => s.addPendingTextEdit);
  const setTool = useUIStore((s) => s.setTool);
  const setSelectedPendingText = useUIStore((s) => s.setSelectedPendingText);
  const setEditingPendingText = useUIStore((s) => s.setEditingPendingText);
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

  // V1.0073: Edit Text on a form-field VALUE. Converts the AcroForm
  // widget into a pending text overlay anchored over the same rect —
  // whiteout covers the baked appearance-stream value, the editable
  // overlay floats on top, the WeavePDF format bar (size / bold /
  // italic / alignment) is available. The widget's stored value
  // remains in the AcroForm structure but is no longer the source of
  // visual truth — the overlay drives the visible text.
  const startEditTextOnWidget = (widget: Widget) => {
    const tab = useDocumentStore.getState().activeTab();
    if (!tab) return;
    const [x1, y1, x2, y2] = widget.rect;
    const wPt = x2 - x1;
    const hPt = y2 - y1;
    // Approximate font size from rect height (AcroForm widgets typically
    // pad ~2pt above/below the glyphs; sizing from h × 0.6 lands near
    // the rendered value).
    const sizePt = Math.max(6, Math.min(48, hPt * 0.6));
    // Baseline ≈ widget bottom + small ascender offset. Matches where
    // pdf.js renders the value in the widget's appearance stream.
    const baselineY = y1 + hPt * 0.25;
    // Padding inside the widget rect — most appearance streams add
    // ~2pt of left padding. Mirror that so the overlay text doesn't
    // shift horizontally.
    const padX = Math.min(4, wPt * 0.05);
    const newId = addPendingTextEdit(tab.id, {
      page: pageNumber,
      xPt: x1 + padX,
      yPt: baselineY,
      size: sizePt,
      text: widget.value,
      widthPt: Math.max(36, wPt - padX * 2),
      // V1.0126: the save blanks this field so its old value can't show
      // through on top in Preview / Acrobat.
      formField: widget.name,
      // V1.0076: pad the whiteout by 2pt on all sides. pdf.js renders
      // the widget's appearance stream slightly larger than the widget
      // rect (anti-aliasing, descenders, italic shear), so a rect-tight
      // whiteout left a faint outline of the baked value visible
      // underneath. The padding catches the overflow without being big
      // enough to eat adjacent content.
      whiteout: {
        x: x1 - 2,
        y: y1 - 2,
        width: wPt + 4,
        height: hPt + 4,
      },
    });
    setSelectedPendingText(newId);
    setEditingPendingText(newId);
    setTool("none");
  };

  // V1.0076: layer raised above the page's interaction layer (z-10) so
  // form widgets accept clicks regardless of which drawing tool is
  // active. Pre-V1.0076 the user had to deselect the active tool (e.g.
  // Whiteout) before form fields became clickable — Adam: "its fillable
  // in preview app" but not in WeavePDF because the Whiteout tool was
  // eating the clicks. Pending overlays / outer drag-drop / context
  // menu use z-20+, so widgets sit between the page content and the
  // editing UI — same relative order as before, just above the drawing
  // layer.
  return (
    // V1.0120: the container is pointer-events-none so clicks in the GAPS
    // between fields fall through to the z-10 interaction layer beneath. This
    // full-page z-15 layer was otherwise swallowing every click-to-place
    // gesture (signature, image, text, checkmark) on a form PDF — Adam opened
    // the signature modal, clicked OK (which arms tool="signature"), then his
    // placement click hit this layer instead of the interaction handler, so
    // "nothing happens, can't place the signature." Each widget below sets
    // pointer-events-auto, so a click ON a field still wins over an active
    // drawing tool (preserving the V1.0076 "fields stay fillable" behaviour).
    <div
      className="pointer-events-none absolute inset-0 z-[15]"
      data-testid="acroform-layer"
    >
      {widgets.map((widget, index) => (
        // V1.0039: key MUST be stable across `applyEdit` re-renders. Earlier
        // we keyed on `${name}-${index}-${activeTab.version}` — version
        // bumps every applyEdit (e.g. on field commit), which made React
        // unmount and remount the entire DOM for every widget, including
        // the one the user just Tab'd into. Effect: type in field A, press
        // Tab, the browser focuses field B, our blur on A triggers
        // setFormFields → applyEdit → version++ → ALL widgets remount → B
        // loses focus mid-key, and the next-typed character goes into the
        // void. Stable key keeps the same input element in the DOM, so
        // browser-native Tab navigation survives the async commit.
        <FieldWidget
          key={`${widget.name}-${index}`}
          widget={widget}
          zoom={zoom}
          pageHeightPt={pageHeightPt}
          radioChecked={radioSelections.get(widget.name) === widget.exportValue}
          onCommit={commit}
          editTextMode={!!editTextMode}
          onStartEditText={() => startEditTextOnWidget(widget)}
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
  editTextMode,
  onStartEditText,
}: {
  widget: Widget;
  zoom: number;
  pageHeightPt: number;
  radioChecked: boolean;
  onCommit: (value: FormFieldValue) => Promise<void>;
  editTextMode: boolean;
  onStartEditText: () => void;
}) {
  const [value, setValue] = useState(widget.value);
  const [checked, setChecked] = useState(widget.checked || radioChecked);
  const [busy, setBusy] = useState(false);
  // V1.0122: with a tool armed, a click near a field belongs to the TOOL
  // (V1.0120 made gap clicks fall through for exactly that reason) — but the
  // invisible "Aa ▸" pill juts ~20px above the field inside this
  // pointer-events-auto wrapper, so a placement click aimed at that strip
  // hijacked the click into an edit-text promotion instead. Suppress the
  // pill entirely while any tool is armed; it returns when the tool is
  // dropped (Esc / re-click).
  const toolArmed = useUIStore((s) => s.tool !== "none");
  // Refs so the flusher registered on focus always reads CURRENT values
  // rather than the render-time closure's stale copies.
  const valueRef = useRef(value);
  const widgetValueRef = useRef(widget.value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  useEffect(() => {
    widgetValueRef.current = widget.value;
  }, [widget.value]);
  // A widget can unmount while focused (page re-render after an edit) — leaving
  // a stale flusher registered would commit into a dead component.
  // V1.0126: clear only OUR flusher — the slot is shared with WeavePDF text
  // boxes / prompts, and wiping theirs made ⌘S skip what they held.
  const flusherRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => () => {
    if (flusherRef.current) clearActiveFieldFlusher(flusherRef.current);
  }, []);
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
    // V1.0073: in Edit Text mode, render a transparent click-target
    // over the widget rect. A click spawns a pending text overlay
    // (with whiteout covering the appearance-stream value) and selects
    // it in editing mode — full WeavePDF format bar applies.
    if (editTextMode) {
      return (
        <div
          aria-label={`Edit "${widget.name}"`}
          data-testid="acroform-edit-text-target"
          data-field-name={widget.name}
          className="pointer-events-auto absolute cursor-text rounded-[2px] border border-transparent transition-colors hover:border-[var(--color-accent)] hover:bg-[rgba(109,94,245,0.08)]"
          style={style}
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onStartEditText();
          }}
          title="Click to replace this field's text with editable WeavePDF text (format bar available)"
        />
      );
    }
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
    //
    // V1.0074: render the input inside a wrapping `group` so a small
    // "Aa ▸" pill can sit above-right of the field on hover or focus.
    // Clicking the pill switches the field's edit flow to a WeavePDF
    // pending text overlay (with full format bar) — discoverability fix
    // for the case where the user filled the field in Margins / other
    // tool mode and didn't realize Edit Text gives more options.
    return (
      <div
        className="group pointer-events-auto absolute"
        style={style}
        data-acroform-text-field={widget.name}
      >
        <input
          aria-label={widget.name}
          data-testid="acroform-text"
          className="acroform-text-input absolute inset-0 rounded-[2px] border border-transparent bg-transparent text-[12px] leading-normal outline-none transition-colors hover:border-[rgba(59,76,202,0.35)] focus:border-[var(--color-accent)] focus:bg-white focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-60"
          style={{
            paddingLeft: Math.max(6, 4 * zoom),
            paddingRight: Math.max(6, 4 * zoom),
            paddingTop: 0,
            paddingBottom: 0,
            color: "transparent",
            caretColor: "black",
          }}
          value={value}
          disabled={widget.readOnly || busy}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
          onFocus={(e) => {
            e.currentTarget.style.color = "black";
            // V1.0123: while this field has the caret, Save/Print must be able
            // to commit it — they never blur, so without this the typed value
            // is written to React state only and the file gets the OLD value.
            const flush = async () => {
              if (widget.readOnly) return;
              if (valueRef.current === widgetValueRef.current) return;
              await runCommit({ name: widget.name, kind: "text", value: valueRef.current });
            };
            flusherRef.current = flush;
            setActiveFieldFlusher(flush);
          }}
          onChange={(e) => setValue(e.target.value)}
          onBlur={(e) => {
            e.currentTarget.style.color = "transparent";
            if (flusherRef.current) clearActiveFieldFlusher(flusherRef.current);
            flusherRef.current = null;
            if (value !== widget.value) {
              void runCommit({ name: widget.name, kind: "text", value });
            }
          }}
        />
        {!widget.readOnly && !toolArmed && (
          <button
            type="button"
            // V1.0119: keep the pill OUT of the keyboard tab order. It sits
            // in the DOM right after the input, so without this, pressing
            // Tab from a filled field focused this (opacity-0) pill instead
            // of the next field — it took two Tabs to cross one field and
            // the in-between stop was invisible, so Tab looked broken. The
            // pill is a mouse-only discoverability affordance; tabIndex={-1}
            // removes it from Tab/Shift+Tab while leaving it clickable.
            // Adam: "I should be able to jump from one fillable text to the
            // next by clicking tab. That doesn't work."
            tabIndex={-1}
            // Mousedown rather than click — we need to grab the pill
            // BEFORE the input's blur fires (which would commit a
            // form-fill change and re-render via applyEdit, unmounting
            // us mid-click).
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onStartEditText();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="absolute -top-5 right-0 flex h-4 items-center gap-1 rounded bg-[var(--color-accent)] px-1.5 text-[10px] font-medium text-white opacity-0 shadow-sm transition-opacity hover:bg-[var(--color-accent-hover)] group-hover:opacity-100 group-focus-within:opacity-100"
            aria-label={`Edit "${widget.name}" with the format bar`}
            title="Convert to editable WeavePDF text (font size, bold, alignment)"
            data-testid="acroform-format-pill"
            data-field-name={widget.name}
          >
            Aa ▸
          </button>
        )}
      </div>
    );
  }

  if (widget.kind === "checkbox") {
    return (
      <input
        aria-label={widget.name}
        data-testid="acroform-checkbox"
        type="checkbox"
        className="pointer-events-auto absolute accent-[var(--color-accent)]"
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
        className="pointer-events-auto absolute accent-[var(--color-accent)]"
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
      className="pointer-events-auto absolute rounded-[2px] border border-transparent bg-white/70 px-1 text-[12px] text-black outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-60"
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
