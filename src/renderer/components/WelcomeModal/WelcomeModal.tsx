import { useEffect, useRef, useState } from "react";
import { ChevronRight, Compass, FolderOpen, Keyboard, Settings, ShieldCheck, Sparkles, X } from "lucide-react";

type Props = {
  open: boolean;
  onClose: () => void;
  initialStep?: 0 | 1;
};

// Onboarding modal shown on first launch. Walks the user through:
//   1. Drop / open / palette basics (one screen, brief).
//   2. Enabling the Finder right-click extension — the only step that
//      requires leaving WeavePDF, so we render a faux right-click preview to
//      make the goal obvious before sending them to System Settings.
//
// Persistence: the App.tsx wrapper checks `localStorage["weavepdf-welcomed"]`
// before deciding whether to auto-open this modal on mount. Closing the modal
// (Done / Skip / Esc / backdrop) sets the flag. The Help menu item and a
// Command Palette action both let users re-open it from the same component.

export function WelcomeModal({ open, onClose, initialStep = 0 }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [step, setStep] = useState<0 | 1>(initialStep);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => closeRef.current?.focus());
  }, [open]);

  // Reset to the requested initial step every time the modal opens. The
  // `initialStep` prop is read from the ui store on each open, so the
  // WeavePDF menu's "Enable Right Click Options…" jumps directly to step 1.
  useEffect(() => {
    if (!open) return;
    setStep(initialStep);
  }, [open, initialStep]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const openSystemSettings = () => {
    void window.weavepdf.openSystemSettings();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        className="flex max-h-[90vh] w-[calc(100vw-32px)] max-w-[640px] flex-col overflow-hidden rounded-2xl border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] shadow-2xl"
        data-testid="welcome-modal"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--panel-border)] px-6 py-4">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.8} />
              <h2 id="welcome-title" className="text-[15px] font-semibold">
                {step === 0 ? "Welcome to WeavePDF" : "Enable Finder right-click"}
              </h2>
            </div>
            <p className="text-[12px] text-[var(--muted)]">
              {step === 0
                ? "A local-first, Mac-native PDF editor. No cloud, no account, no subscription."
                : "One last step: turn on the WeavePDF extension so you can act on PDFs from Finder."}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>

        {step === 0 ? (
          <div className="flex flex-col gap-5 overflow-y-auto px-6 py-5 acr-scroll">
            <Tile
              icon={<FolderOpen className="h-4 w-4" strokeWidth={1.8} />}
              title="Open a PDF"
              body={
                <>
                  Drag any PDF onto this window, double-click one in Finder, or press{" "}
                  <Kbd>⌘O</Kbd>. Multiple files open as tabs along the top.
                </>
              }
            />
            <Tile
              icon={<Compass className="h-4 w-4" strokeWidth={1.8} />}
              title="Edit, sign, redact, compress, OCR"
              body={
                <>
                  Annotation tools live in the toolbar on the left. Page operations are in the right
                  sidebar. Document operations (Compress, Watermark, OCR, Encrypt, etc.) live under
                  the <Kbd>⌘K</Kbd> command palette.
                </>
              }
            />
            <Tile
              icon={<Keyboard className="h-4 w-4" strokeWidth={1.8} />}
              title="Keyboard shortcuts"
              body={
                <>
                  Press <Kbd>⌘/</Kbd> any time to see the full shortcut reference. The version
                  stamp at the bottom of that panel shows the build you’re running.
                </>
              }
            />
            <Tile
              icon={<Settings className="h-4 w-4" strokeWidth={1.8} />}
              title="Right-click in Finder"
              body={
                <>
                  WeavePDF can add a "WeavePDF" submenu to Finder’s right-click menu so you can
                  compress, combine, convert, extract, and rotate PDFs without opening the app.
                  Click <strong className="text-[var(--app-fg)]">Next</strong> to enable it.
                </>
              }
            />
            <Tile
              icon={<ShieldCheck className="h-4 w-4" strokeWidth={1.8} />}
              title="A few macOS prompts (one-time)"
              body={
                <>
                  WeavePDF is a small indie app, not signed by Apple’s Developer Program — yet.
                  So macOS will warn you twice on first run:
                  <ol className="ml-4 mt-1.5 list-decimal space-y-1">
                    <li>
                      <strong className="text-[var(--app-fg)]">"Unidentified developer"</strong>{" "}
                      on first launch — right-click the app → <em>Open</em> → confirm. Once.
                    </li>
                    <li>
                      <strong className="text-[var(--app-fg)]">"WeavePDF wants to access your keychain"</strong>{" "}
                      the first time you save a signature or generate a digital cert — enter your
                      Mac password and click <em>Always Allow</em>. After that it’s silent.
                    </li>
                  </ol>
                </>
              }
            />

            <div className="mt-1 flex items-center justify-end gap-2 border-t border-[var(--panel-border)] pt-4">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md px-3 py-1.5 text-[13px] text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]"
                data-testid="welcome-skip"
              >
                Skip for now
              </button>
              <button
                type="button"
                onClick={() => setStep(1)}
                className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-[13px] font-medium text-white hover:bg-[var(--color-accent-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:ring-offset-[var(--panel-bg-raised)]"
                data-testid="welcome-next"
              >
                Next: Enable Finder
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-5 overflow-y-auto px-6 py-5 acr-scroll">
            <p className="text-[13px] leading-relaxed text-[var(--app-fg)]">
              When the extension is on, right-clicking any PDF in Finder shows this submenu:
            </p>

            <FauxRightClick />

            <div>
              <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-[var(--subtle)]">
                Steps
              </h3>
              <ol className="flex flex-col gap-2.5 text-[13px] leading-relaxed text-[var(--app-fg)]">
                <Step n={1}>
                  Click <strong>Open System Settings</strong> below — it jumps directly to{" "}
                  <em>Login Items &amp; Extensions</em>.
                </Step>
                <Step n={2}>
                  Scroll to <strong>Added Extensions</strong> and find{" "}
                  <strong>WeavePDF Extensions</strong>. Click the{" "}
                  <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-[var(--panel-border-strong)] text-[10px] font-semibold text-[var(--muted)] align-text-bottom">
                    i
                  </span>{" "}
                  info icon on its right.
                </Step>
                <Step n={3}>
                  In the popup, toggle the listed extension on (it may be labelled{" "}
                  <em>File Provider</em> — that's macOS's category name for the WeavePDF
                  extension). Click <strong>Done</strong>. macOS may ask for your password.
                </Step>
                <Step n={4}>
                  Right-click any PDF or image in Finder. The <strong>WeavePDF</strong> submenu
                  appears with the 5 actions.
                </Step>
              </ol>
            </div>

            <div className="rounded-md border border-[var(--panel-border)] bg-[var(--hover-bg)] px-3 py-2 text-[12px] leading-relaxed text-[var(--muted)]">
              <strong className="text-[var(--app-fg)]">Don’t see WeavePDF in the list?</strong>{" "}
              Quit and relaunch WeavePDF once — that registers the extension with macOS — then
              reopen System Settings.
            </div>

            <div className="mt-1 flex items-center justify-between gap-2 border-t border-[var(--panel-border)] pt-4">
              <button
                type="button"
                onClick={() => setStep(0)}
                className="rounded-md px-3 py-1.5 text-[13px] text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]"
              >
                Back
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md px-3 py-1.5 text-[13px] text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]"
                  data-testid="welcome-done"
                >
                  I’ll do it later
                </button>
                <button
                  type="button"
                  onClick={openSystemSettings}
                  className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-[13px] font-medium text-white hover:bg-[var(--color-accent-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:ring-offset-[var(--panel-bg-raised)]"
                  data-testid="welcome-open-settings"
                >
                  Open System Settings
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Tile({ icon, title, body }: { icon: React.ReactNode; title: string; body: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-[var(--panel-border)] px-4 py-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--hover-bg)] text-[var(--color-accent)]">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="mb-0.5 text-[13px] font-semibold text-[var(--app-fg)]">{title}</div>
        <div className="text-[12px] leading-relaxed text-[var(--muted)]">{body}</div>
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)] text-[10px] font-semibold text-white tabular-nums">
        {n}
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mx-0.5 inline-block rounded bg-[var(--hover-bg)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)]">
      {children}
    </kbd>
  );
}

// CSS-only mock of a macOS right-click context menu, with the WeavePDF entry
// expanded to its hover submenu. Honors BRAND.md's "no illustrations" rule by
// using only typography + dividers + the accent color, mimicking native chrome.
function FauxRightClick() {
  return (
    <div className="flex justify-center py-2">
      <div className="flex items-start gap-3">
        <FauxMenu width={200}>
          <FauxItem dim>Open</FauxItem>
          <FauxItem dim>Open With</FauxItem>
          <FauxItem dim>Move to Trash</FauxItem>
          <FauxDivider />
          <FauxItem dim>Get Info</FauxItem>
          <FauxItem dim>Rename</FauxItem>
          <FauxItem dim>Duplicate</FauxItem>
          <FauxItem dim>Quick Look</FauxItem>
          <FauxDivider />
          <FauxItem dim>Quick Actions</FauxItem>
          <FauxItem highlighted>
            <span>WeavePDF</span>
            <ChevronRight className="h-3 w-3" strokeWidth={2} />
          </FauxItem>
        </FauxMenu>
        <FauxMenu width={180}>
          <FauxItem>Compress</FauxItem>
          <FauxItem>Combine into PDF</FauxItem>
          <FauxItem>Convert to PDF</FauxItem>
          <FauxItem>Extract first page</FauxItem>
          <FauxItem>Rotate 90°</FauxItem>
        </FauxMenu>
      </div>
    </div>
  );
}

function FauxMenu({ width, children }: { width: number; children: React.ReactNode }) {
  return (
    <div
      className="overflow-hidden rounded-md border border-[var(--panel-border-strong)] bg-[var(--panel-bg)] py-1 shadow-lg"
      style={{ width }}
    >
      {children}
    </div>
  );
}

function FauxItem({
  children,
  highlighted,
  dim,
}: {
  children: React.ReactNode;
  highlighted?: boolean;
  dim?: boolean;
}) {
  const base =
    "flex items-center justify-between gap-2 px-3 py-1 text-[12px] leading-tight";
  let cls = `${base} text-[var(--app-fg)]`;
  if (highlighted) {
    cls = `${base} bg-[var(--color-accent)] text-white`;
  } else if (dim) {
    cls = `${base} text-[var(--muted)]`;
  }
  return <div className={cls}>{children}</div>;
}

function FauxDivider() {
  return <div className="my-1 h-px bg-[var(--panel-border)]" />;
}
