import { useEffect, useMemo, useState } from "react";
import { X, FormInput } from "lucide-react";
import { useDocumentStore } from "../../stores/document";
import { getFormFields, setFormFields, type FormFieldInfo, type FormFieldValue } from "../../lib/pdf-ops";

type Props = { open: boolean; onClose: () => void };

type ValueMap = Record<string, FormFieldValue>;

export function FormFillModal({ open, onClose }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const applyEdit = useDocumentStore((s) => s.applyEdit);
  const [fields, setFields] = useState<FormFieldInfo[]>([]);
  const [values, setValues] = useState<ValueMap>({});
  const [busy, setBusy] = useState(false);
  const [flatten, setFlatten] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !activeTab?.bytes) return;
    setLoading(true);
    void getFormFields(activeTab.bytes)
      .then((result) => {
        setFields(result);
        const initial: ValueMap = {};
        for (const f of result) {
          if (f.kind === "text") initial[f.name] = { name: f.name, kind: "text", value: f.value };
          else if (f.kind === "checkbox") initial[f.name] = { name: f.name, kind: "checkbox", checked: f.checked };
          else if (f.kind === "radio") initial[f.name] = { name: f.name, kind: "radio", selected: f.selected ?? null };
          else if (f.kind === "dropdown") initial[f.name] = { name: f.name, kind: "dropdown", selected: f.selected ?? null };
          else initial[f.name] = { name: f.name, kind: "optionList", selected: f.selected };
        }
        setValues(initial);
      })
      .finally(() => setLoading(false));
  }, [open, activeTab?.bytes, activeTab?.version]);

  const sortedFields = useMemo(() => [...fields].sort((a, b) => a.name.localeCompare(b.name)), [fields]);

  if (!open || !activeTab) return null;

  const handleSave = async () => {
    if (!activeTab.bytes) return;
    setBusy(true);
    try {
      const newBytes = await setFormFields(activeTab.bytes, Object.values(values), { flatten });
      await applyEdit(activeTab.id, newBytes);
      onClose();
    } catch (err) {
      alert(`Form fill failed: ${(err as Error).message ?? err}`);
    } finally {
      setBusy(false);
    }
  };

  const hasFields = fields.length > 0;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="max-h-[80vh] w-[600px] overflow-hidden rounded-2xl border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] shadow-2xl"
        data-testid="form-fill-modal"
      >
        <div className="flex items-center justify-between border-b border-[var(--panel-border)] px-5 py-3">
          <div className="flex items-center gap-2">
            <FormInput className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.8} />
            <h2 className="text-[15px] font-semibold">Fill Form</h2>
            {hasFields && (
              <span className="text-[11px] tabular-nums text-[var(--muted)]">
                {fields.length} field{fields.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>

        <div className="max-h-[55vh] overflow-y-auto px-5 py-4">
          {loading ? (
            <p className="py-6 text-center text-[13px] text-[var(--muted)]">Reading form…</p>
          ) : !hasFields ? (
            <p className="py-6 text-center text-[13px] text-[var(--muted)]">
              This PDF has no fillable form fields.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {sortedFields.map((f) => (
                <FieldRow
                  key={f.name}
                  info={f}
                  value={values[f.name]}
                  onChange={(v) => setValues((vs) => ({ ...vs, [f.name]: v }))}
                />
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--panel-border)] px-5 py-3">
          <label className="flex items-center gap-2 text-[12px] text-[var(--muted)]">
            <input
              type="checkbox"
              checked={flatten}
              onChange={(e) => setFlatten(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--color-accent)]"
            />
            Flatten (bake values, make non-editable)
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-8 rounded-md border border-[var(--panel-border)] px-3 text-[12px] text-[var(--app-fg)] hover:bg-[var(--hover-bg)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={busy || !hasFields}
              className="h-8 rounded-md bg-[var(--color-accent)] px-3 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
              data-testid="form-fill-save"
            >
              {busy ? "Saving…" : "Apply"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FieldRow({
  info,
  value,
  onChange,
}: {
  info: FormFieldInfo;
  value: FormFieldValue | undefined;
  onChange: (v: FormFieldValue) => void;
}) {
  if (!value) return null;
  const label = (
    <span className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">
      {info.name}
      <span className="text-[10px] font-normal normal-case text-[var(--muted)]">{info.kind}</span>
      {info.readOnly && (
        <span className="rounded bg-[var(--hover-bg)] px-1 text-[10px] font-normal normal-case text-[var(--muted)]">
          read-only
        </span>
      )}
    </span>
  );
  return (
    <label className="flex flex-col gap-1">
      {label}
      {renderInput()}
    </label>
  );

  function renderInput() {
    if (value?.kind === "text" && info.kind === "text") {
      if (info.multiline) {
        return (
          <textarea
            value={value.value}
            onChange={(e) => onChange({ name: info.name, kind: "text", value: e.target.value })}
            disabled={info.readOnly}
            rows={3}
            className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-1.5 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-60"
          />
        );
      }
      return (
        <input
          type="text"
          value={value.value}
          onChange={(e) => onChange({ name: info.name, kind: "text", value: e.target.value })}
          disabled={info.readOnly}
          className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-1.5 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-60"
        />
      );
    }
    if (value?.kind === "checkbox" && info.kind === "checkbox") {
      return (
        <input
          type="checkbox"
          checked={value.checked}
          onChange={(e) => onChange({ name: info.name, kind: "checkbox", checked: e.target.checked })}
          disabled={info.readOnly}
          className="h-4 w-4 accent-[var(--color-accent)]"
        />
      );
    }
    if (value?.kind === "radio" && info.kind === "radio") {
      return (
        <div className="flex flex-wrap gap-3">
          {info.options.map((opt) => (
            <label key={opt} className="flex items-center gap-1 text-[13px]">
              <input
                type="radio"
                name={info.name}
                checked={value.selected === opt}
                onChange={() => onChange({ name: info.name, kind: "radio", selected: opt })}
                disabled={info.readOnly}
                className="accent-[var(--color-accent)]"
              />
              {opt}
            </label>
          ))}
        </div>
      );
    }
    if (value?.kind === "dropdown" && info.kind === "dropdown") {
      return (
        <select
          value={value.selected ?? ""}
          onChange={(e) => onChange({ name: info.name, kind: "dropdown", selected: e.target.value || null })}
          disabled={info.readOnly}
          className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-1.5 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-60"
        >
          <option value="">— Select —</option>
          {info.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    }
    if (value?.kind === "optionList" && info.kind === "optionList") {
      return (
        <select
          multiple
          value={value.selected}
          onChange={(e) => {
            const selected = Array.from(e.target.selectedOptions).map((o) => o.value);
            onChange({ name: info.name, kind: "optionList", selected });
          }}
          disabled={info.readOnly}
          className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-1.5 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-60"
          size={Math.min(6, info.options.length)}
        >
          {info.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    }
    return null;
  }
}
