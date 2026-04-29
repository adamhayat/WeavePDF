import { useEffect, useRef, useState } from "react";
import { X, Sparkles, FileText, MessageSquare, PencilLine, Copy, CheckCheck } from "lucide-react";
import { useDocumentStore } from "../../stores/document";
import { pdfToMarkdown } from "../../lib/pdf-ops";
import { cn } from "../../lib/cn";

type Props = { open: boolean; onClose: () => void };

type Mode = "summarize" | "qa" | "rewrite";

const REWRITE_STYLES = [
  { id: "clearer", label: "Clearer" },
  { id: "concise", label: "Shorter" },
  { id: "professional", label: "Professional" },
  { id: "friendly", label: "Friendly" },
  { id: "simpler", label: "Simpler" },
];

export function AiModal({ open, onClose }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const [available, setAvailable] = useState<boolean | null>(null);
  const [mode, setMode] = useState<Mode>("summarize");
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [style, setStyle] = useState("clearer");
  const [copied, setCopied] = useState(false);
  const extractedFor = useRef<{ id: string; version: number } | null>(null);

  // Extract text from the current PDF once per version. Cached between runs
  // so re-asking questions doesn't re-parse every time.
  useEffect(() => {
    if (!open || !activeTab?.bytes) return;
    if (
      extractedFor.current &&
      extractedFor.current.id === activeTab.id &&
      extractedFor.current.version === activeTab.version
    ) {
      return;
    }
    void (async () => {
      try {
        const md = await pdfToMarkdown(activeTab.bytes!);
        // Strip markdown headings so the model sees prose, not syntax.
        const clean = md.replace(/^#{1,6}\s+/gm, "").replace(/\n{3,}/g, "\n\n").trim();
        setText(clean);
        extractedFor.current = { id: activeTab.id, version: activeTab.version };
      } catch (err) {
        setError(`Couldn't read PDF text: ${(err as Error).message ?? err}`);
      }
    })();
  }, [open, activeTab?.id, activeTab?.bytes, activeTab?.version]);

  useEffect(() => {
    if (!open) return;
    void window.weavepdf.ai.available().then(setAvailable);
  }, [open]);

  useEffect(() => {
    // Reset the per-run state when the user changes mode.
    setResult("");
    setError(null);
  }, [mode]);

  if (!open || !activeTab) return null;

  const run = async () => {
    if (!text) return;
    setBusy(true);
    setError(null);
    setResult("");
    try {
      const extra = mode === "qa" ? question : mode === "rewrite" ? style : undefined;
      if (mode === "qa" && !question.trim()) return;
      const output = await window.weavepdf.ai.run(mode, text, extra);
      setResult(output);
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const copyResult = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* no-op */
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="flex max-h-[80vh] w-[640px] flex-col overflow-hidden rounded-2xl border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] shadow-2xl"
        data-testid="ai-modal"
      >
        <div className="flex items-center justify-between border-b border-[var(--panel-border)] px-5 py-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.8} />
            <h2 className="text-[15px] font-semibold">Apple Intelligence</h2>
            <span className="text-[11px] text-[var(--muted)]">· on-device, private</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)] disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>

        {/* Mode tabs */}
        <div className="flex shrink-0 items-center gap-1 border-b border-[var(--panel-border)] px-3 py-2">
          <TabButton active={mode === "summarize"} onClick={() => setMode("summarize")}>
            <FileText className="h-3.5 w-3.5" strokeWidth={2} /> Summarize
          </TabButton>
          <TabButton active={mode === "qa"} onClick={() => setMode("qa")}>
            <MessageSquare className="h-3.5 w-3.5" strokeWidth={2} /> Ask a question
          </TabButton>
          <TabButton active={mode === "rewrite"} onClick={() => setMode("rewrite")}>
            <PencilLine className="h-3.5 w-3.5" strokeWidth={2} /> Rewrite
          </TabButton>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4">
          {available === false && (
            <div className="rounded-md border border-[var(--color-destructive)]/40 bg-[var(--color-destructive)]/10 p-3 text-[12px] text-[var(--color-destructive)]">
              The AI helper isn't built. Run <code>node scripts/build-ai.mjs</code> (requires full Xcode), then repackage.
            </div>
          )}

          {text === null && available !== false && (
            <p className="text-[13px] text-[var(--muted)]">Reading PDF text…</p>
          )}

          {text !== null && (
            <>
              {mode === "summarize" && (
                <p className="mb-3 text-[12px] text-[var(--muted)]">
                  Generate a 3-5 bullet summary of {activeTab.name}. {text.length.toLocaleString()} chars extracted.
                </p>
              )}
              {mode === "qa" && (
                <div className="mb-3 flex flex-col gap-1">
                  <label className="text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">
                    Your question
                  </label>
                  <input
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !busy && question.trim()) void run();
                    }}
                    placeholder="e.g. What are the termination terms?"
                    disabled={busy}
                    className="h-9 rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-50"
                    data-testid="ai-question"
                  />
                </div>
              )}
              {mode === "rewrite" && (
                <div className="mb-3 flex flex-col gap-1">
                  <label className="text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">Style</label>
                  <div className="flex flex-wrap gap-1">
                    {REWRITE_STYLES.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setStyle(s.id)}
                        disabled={busy}
                        className={cn(
                          "rounded-md border px-2 py-1 text-[12px] transition-colors",
                          style === s.id
                            ? "border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]"
                            : "border-[var(--panel-border)] hover:bg-[var(--hover-bg)]",
                        )}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Result pane */}
              {busy && (
                <div className="flex items-center gap-2 text-[12px] text-[var(--muted)]">
                  <Sparkles className="h-3.5 w-3.5 animate-pulse text-[var(--color-accent)]" strokeWidth={2} />
                  Thinking on-device…
                </div>
              )}
              {error && (
                <div className="rounded-md border border-[var(--color-destructive)]/40 bg-[var(--color-destructive)]/10 p-3 text-[12px] text-[var(--color-destructive)]">
                  {error}
                </div>
              )}
              {result && (
                <div className="relative flex-1 rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] p-3">
                  <button
                    type="button"
                    onClick={copyResult}
                    className="absolute right-2 top-2 flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]"
                  >
                    {copied ? (
                      <>
                        <CheckCheck className="h-3 w-3" strokeWidth={2} /> Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" strokeWidth={2} /> Copy
                      </>
                    )}
                  </button>
                  <pre className="whitespace-pre-wrap pr-16 text-[13px] leading-relaxed text-[var(--app-fg)]">
                    {result}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--panel-border)] px-5 py-3">
          <p className="text-[11px] text-[var(--muted)]">Runs fully on this Mac via Foundation Models. Nothing sent to the network.</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="h-8 rounded-md border border-[var(--panel-border)] px-3 text-[12px] text-[var(--app-fg)] hover:bg-[var(--hover-bg)] disabled:opacity-50"
            >
              {result ? "Done" : "Cancel"}
            </button>
            <button
              type="button"
              onClick={() => void run()}
              disabled={busy || !text || available === false || (mode === "qa" && !question.trim())}
              className="h-8 rounded-md bg-[var(--color-accent)] px-3 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
              data-testid="ai-run"
            >
              {busy
                ? "Thinking…"
                : mode === "summarize"
                  ? "Summarize"
                  : mode === "qa"
                    ? "Ask"
                    : "Rewrite"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] transition-colors",
        active
          ? "bg-[var(--panel-bg)] text-[var(--app-fg)]"
          : "text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]",
      )}
    >
      {children}
    </button>
  );
}
