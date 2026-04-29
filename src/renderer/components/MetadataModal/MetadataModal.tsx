import { useEffect, useState } from "react";
import { X, FileText } from "lucide-react";
import { useDocumentStore } from "../../stores/document";
import { getMetadata, setMetadata } from "../../lib/pdf-ops";

type Props = { open: boolean; onClose: () => void };

type Form = {
  title: string;
  author: string;
  subject: string;
  keywords: string;
};

export function MetadataModal({ open, onClose }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const applyEdit = useDocumentStore((s) => s.applyEdit);
  const [form, setForm] = useState<Form>({ title: "", author: "", subject: "", keywords: "" });
  const [busy, setBusy] = useState(false);
  const [producer, setProducer] = useState("");
  const [pageCount, setPageCount] = useState(0);

  useEffect(() => {
    if (!open || !activeTab?.bytes) return;
    void getMetadata(activeTab.bytes).then((m) => {
      setForm({
        title: m.title,
        author: m.author,
        subject: m.subject,
        keywords: m.keywords,
      });
      setProducer(m.producer);
      setPageCount(m.pageCount);
    });
  }, [open, activeTab?.bytes, activeTab?.version]);

  if (!open || !activeTab) return null;

  const handleSave = async () => {
    if (!activeTab.bytes) return;
    setBusy(true);
    try {
      const newBytes = await setMetadata(activeTab.bytes, {
        title: form.title,
        author: form.author,
        subject: form.subject,
        keywords: form.keywords
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean),
      });
      await applyEdit(activeTab.id, newBytes);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[500px] rounded-2xl border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] p-5 shadow-2xl"
        data-testid="metadata-modal"
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.8} />
            <h2 className="text-[15px] font-semibold">Document Properties</h2>
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

        <div className="flex flex-col gap-3">
          <Field label="Title">
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-1.5 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              data-testid="metadata-title"
            />
          </Field>
          <Field label="Author">
            <input
              value={form.author}
              onChange={(e) => setForm({ ...form, author: e.target.value })}
              className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-1.5 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              data-testid="metadata-author"
            />
          </Field>
          <Field label="Subject">
            <input
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
              className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-1.5 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            />
          </Field>
          <Field label="Keywords" hint="comma-separated">
            <input
              value={form.keywords}
              onChange={(e) => setForm({ ...form, keywords: e.target.value })}
              className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-1.5 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            />
          </Field>
        </div>

        <div className="mt-4 flex items-center justify-between text-[11px] text-[var(--muted)]">
          <span>
            {pageCount} pages · Producer: <span className="font-mono">{producer || "—"}</span>
          </span>
        </div>

        <div className="mt-4 flex justify-end gap-2 border-t border-[var(--panel-border)] pt-4">
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
            disabled={busy}
            className="h-8 rounded-md bg-[var(--color-accent)] px-3 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
            data-testid="metadata-save"
          >
            {busy ? "Saving…" : "Save properties"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">
        {label}
        {hint && <span className="ml-2 font-normal normal-case">{hint}</span>}
      </span>
      {children}
    </label>
  );
}
