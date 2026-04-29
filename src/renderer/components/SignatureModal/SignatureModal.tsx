import { useEffect, useRef, useState } from "react";
import SignaturePad from "signature_pad";
import { X, Trash2, PenLine, Type as TypeIcon } from "lucide-react";
import { useUIStore } from "../../stores/ui";
import { cn } from "../../lib/cn";

type Tab = "draw" | "type";

type TypedFont = {
  id: string;
  label: string;
  css: string;
};

// macOS-native fonts that look like a real signature — no web-font install.
const TYPED_FONTS: TypedFont[] = [
  { id: "snell", label: "Snell", css: '"Snell Roundhand", cursive' },
  { id: "chancery", label: "Chancery", css: '"Apple Chancery", cursive' },
  { id: "noteworthy", label: "Noteworthy", css: '"Noteworthy", cursive' },
  { id: "markerfelt", label: "Marker", css: '"Marker Felt", cursive' },
  { id: "bradley", label: "Bradley", css: '"Bradley Hand", cursive' },
];

type Props = { open: boolean; onClose: () => void };

// Signatures are always saved as solid BLACK — PDFs are almost universally
// on a white background, and a "theme-coloured" signature would be invisible
// when placed on a page.
const SIG_COLOR = "#0b0b0e";

export function SignatureModal({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("draw");
  const [hasExisting, setHasExisting] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setTool = useUIStore((s) => s.setTool);

  // ---- Draw tab state ----
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<SignaturePad | null>(null);
  const [drawDirty, setDrawDirty] = useState(false);

  // ---- Type tab state ----
  const [typedName, setTypedName] = useState("");
  const [typedFontId, setTypedFontId] = useState<TypedFont["id"]>("snell");
  const typedFont = TYPED_FONTS.find((f) => f.id === typedFontId) ?? TYPED_FONTS[0];

  // Poll existing signature on open.
  useEffect(() => {
    if (!open) return;
    void window.weavepdf.signature.get().then((dataUrl) => setHasExisting(!!dataUrl));
    setDrawDirty(false);
    setTypedName("");
  }, [open]);

  // Init draw pad when the Draw tab is visible.
  useEffect(() => {
    if (!open || tab !== "draw" || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const resize = () => {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      canvas.width = canvas.offsetWidth * ratio;
      canvas.height = canvas.offsetHeight * ratio;
      canvas.getContext("2d")?.scale(ratio, ratio);
      padRef.current?.clear();
    };
    resize();

    const pad = new SignaturePad(canvas, {
      backgroundColor: "rgba(255,255,255,0)",
      penColor: SIG_COLOR,
      minWidth: 0.8,
      maxWidth: 2.2,
    });
    pad.addEventListener("endStroke", () => setDrawDirty(true));
    padRef.current = pad;

    // Preview existing sig when re-opening and user hasn't changed tab.
    void window.weavepdf.signature.get().then((dataUrl) => {
      if (!dataUrl) return;
      const img = new Image();
      img.onload = () => {
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const cw = canvas.offsetWidth;
        const ch = canvas.offsetHeight;
        const aspect = img.width / img.height;
        let w = cw;
        let h = cw / aspect;
        if (h > ch) {
          h = ch;
          w = ch * aspect;
        }
        ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
      };
      img.src = dataUrl;
    });

    window.addEventListener("resize", resize);
    return () => {
      pad.off();
      window.removeEventListener("resize", resize);
    };
  }, [open, tab]);

  if (!open) return null;

  const handleClear = () => {
    if (tab === "draw") {
      padRef.current?.clear();
      setDrawDirty(true);
    } else {
      setTypedName("");
    }
  };

  const handleDelete = async () => {
    await window.weavepdf.signature.clear();
    padRef.current?.clear();
    setHasExisting(false);
    setDrawDirty(false);
    setTypedName("");
  };

  const handleSaveAndPlace = async () => {
    setError(null);
    setPlacing(true);
    try {
      let dataUrl: string | null = null;
      if (tab === "draw") {
        if (drawDirty && padRef.current && !padRef.current.isEmpty()) {
          dataUrl = padRef.current.toDataURL("image/png");
          await window.weavepdf.signature.set(dataUrl);
        } else if (hasExisting) {
          dataUrl = await window.weavepdf.signature.get();
        } else {
          setError("Draw your signature first.");
          return;
        }
      } else {
        if (!typedName.trim()) {
          setError("Type your name first.");
          return;
        }
        dataUrl = await renderTypedSignature(typedName.trim(), typedFont.css);
        await window.weavepdf.signature.set(dataUrl);
      }
      if (dataUrl) {
        setTool("signature");
        onClose();
      }
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setPlacing(false);
    }
  };

  const canSave = tab === "draw"
    ? drawDirty || hasExisting
    : typedName.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[580px] rounded-2xl border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] p-5 shadow-2xl"
        data-testid="signature-modal"
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <PenLine className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.8} />
            <h2 className="text-[15px] font-semibold">Your signature</h2>
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

        <div className="mb-3 inline-flex rounded-md border border-[var(--panel-border)] p-0.5">
          <TabButton id="draw" current={tab} onClick={() => setTab("draw")} icon={<PenLine className="h-3 w-3" strokeWidth={2} />}>
            Draw
          </TabButton>
          <TabButton id="type" current={tab} onClick={() => setTab("type")} icon={<TypeIcon className="h-3 w-3" strokeWidth={2} />}>
            Type
          </TabButton>
        </div>

        {tab === "draw" ? (
          <div className="relative">
            <canvas
              ref={canvasRef}
              className="h-[180px] w-full rounded-xl border border-[var(--panel-border)] bg-white"
              data-testid="signature-canvas"
            />
            <div className="pointer-events-none absolute bottom-3 left-4 text-[11px] text-[var(--muted)]">
              {hasExisting && !drawDirty ? "Saved · redraw to replace" : "Sign here"}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <input
              type="text"
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              placeholder="Type your name"
              maxLength={60}
              className="rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-3 py-2 text-[14px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              data-testid="signature-type-input"
              autoFocus
            />
            <div className="flex flex-wrap gap-1.5">
              {TYPED_FONTS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setTypedFontId(f.id)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-[11px] transition-colors",
                    typedFontId === f.id
                      ? "border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] text-[var(--color-accent)]"
                      : "border-[var(--panel-border)] text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]",
                  )}
                  data-testid={`signature-font-${f.id}`}
                >
                  <span style={{ fontFamily: f.css }}>{f.label}</span>
                </button>
              ))}
            </div>
            <div className="flex h-[120px] items-center justify-center rounded-xl border border-[var(--panel-border)] bg-white px-6">
              <div
                className="max-w-full truncate"
                style={{ fontFamily: typedFont.css, fontSize: 52, lineHeight: 1.1, color: SIG_COLOR }}
                data-testid="signature-type-preview"
              >
                {typedName || (
                  <span className="text-[18px] text-[#9a97b4]">Preview</span>
                )}
              </div>
            </div>
          </div>
        )}

        <p className="mt-3 text-[11px] text-[var(--muted)]">
          Stored encrypted in your Mac’s Keychain. Never uploaded.
        </p>
        {error && (
          <p className="mt-1 text-[11px] text-[var(--color-destructive)]" role="alert">
            {error}
          </p>
        )}

        <div className="mt-4 flex items-center justify-between border-t border-[var(--panel-border)] pt-4">
          <div className="flex gap-1">
            <button
              type="button"
              onClick={handleClear}
              className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--panel-border)] px-2.5 text-[12px] text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]"
              data-testid="signature-clear"
            >
              Clear
            </button>
            {hasExisting && (
              <button
                type="button"
                onClick={handleDelete}
                className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--panel-border)] px-2.5 text-[12px] text-[var(--muted)] hover:bg-[color-mix(in_srgb,var(--color-destructive)_15%,transparent)] hover:text-[var(--color-destructive)]"
                data-testid="signature-delete"
              >
                <Trash2 className="h-3 w-3" strokeWidth={1.8} />
                Delete saved
              </button>
            )}
          </div>
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
              onClick={handleSaveAndPlace}
              disabled={!canSave || placing}
              className="h-8 rounded-md bg-[var(--color-accent)] px-3 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
              data-testid="signature-place"
            >
              {placing ? "Saving…" : "Save · click PDF to place"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TabButton({
  id,
  current,
  onClick,
  icon,
  children,
}: {
  id: Tab;
  current: Tab;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const active = id === current;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded px-2.5 text-[12px] transition-colors",
        active
          ? "bg-[var(--panel-bg)] text-[var(--app-fg)] shadow-sm"
          : "text-[var(--muted)] hover:text-[var(--app-fg)]",
      )}
      data-testid={`signature-tab-${id}`}
      data-active={active || undefined}
    >
      {icon}
      {children}
    </button>
  );
}

/**
 * Render a typed-signature string to a tightly-cropped PNG data URL.
 * Always black ink on transparent — PDFs are overwhelmingly white paper.
 */
async function renderTypedSignature(
  text: string,
  fontCss: string,
): Promise<string> {
  const padX = 40;
  const padY = 20;
  const fontSize = 128;

  const measureCanvas = document.createElement("canvas");
  const mctx = measureCanvas.getContext("2d")!;
  mctx.font = `${fontSize}px ${fontCss}`;
  const metrics = mctx.measureText(text);
  const width = Math.ceil(metrics.width) + padX * 2;
  const ascent = Math.ceil(metrics.actualBoundingBoxAscent || fontSize * 0.9);
  const descent = Math.ceil(metrics.actualBoundingBoxDescent || fontSize * 0.3);
  const height = ascent + descent + padY * 2;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${fontSize}px ${fontCss}`;
  ctx.fillStyle = SIG_COLOR;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, padX, padY + ascent);

  return canvas.toDataURL("image/png");
}
