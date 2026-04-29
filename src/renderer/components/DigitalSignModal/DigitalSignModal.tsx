import { useEffect, useState } from "react";
import { X, ShieldCheck, Trash2, Loader2 } from "lucide-react";
import { useDocumentStore } from "../../stores/document";
import type { DigitalCertInfo } from "../../../shared/ipc";
import { u8ToAb } from "../../../shared/buffers";

type Props = { open: boolean; onClose: () => void };

type Phase = "loading" | "noCert" | "hasCert" | "generating" | "signing" | "done";

export function DigitalSignModal({ open, onClose }: Props) {
  const activeTab = useDocumentStore((s) => s.activeTab());
  const applyEdit = useDocumentStore((s) => s.applyEdit);
  const commitAllPending = useDocumentStore((s) => s.commitAllPending);
  const [phase, setPhase] = useState<Phase>("loading");
  const [info, setInfo] = useState<DigitalCertInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Generate form
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [org, setOrg] = useState("");
  const [years, setYears] = useState(5);

  // Sign form
  const [reason, setReason] = useState("I am the author of this document");
  const [location, setLocation] = useState("macOS");

  useEffect(() => {
    if (!open) return;
    setPhase("loading");
    setError(null);
    void (async () => {
      try {
        const has = await window.weavepdf.digitalSig.hasCert();
        if (has) {
          const meta = await window.weavepdf.digitalSig.getCertInfo();
          setInfo(meta);
          setPhase("hasCert");
        } else {
          setPhase("noCert");
        }
      } catch (err) {
        setError((err as Error).message ?? String(err));
        setPhase("noCert");
      }
    })();
  }, [open]);

  if (!open || !activeTab) return null;

  const generateCert = async () => {
    if (!name.trim() || !email.trim()) return;
    setPhase("generating");
    setError(null);
    try {
      const meta = await window.weavepdf.digitalSig.genCert({
        name: name.trim(),
        email: email.trim(),
        org: org.trim() || undefined,
        years,
      });
      setInfo(meta);
      setPhase("hasCert");
    } catch (err) {
      setError((err as Error).message ?? String(err));
      setPhase("noCert");
    }
  };

  const clearCert = async () => {
    await window.weavepdf.digitalSig.clearCert();
    setInfo(null);
    setPhase("noCert");
  };

  const signNow = async () => {
    if (!activeTab.bytes) return;
    setPhase("signing");
    setError(null);
    try {
      await commitAllPending(activeTab.id);
      const fresh = useDocumentStore.getState().tabs.find((t) => t.id === activeTab.id);
      if (!fresh?.bytes) return;
      const signed = await window.weavepdf.digitalSig.signPdf(u8ToAb(fresh.bytes), {
        reason: reason.trim() || undefined,
        location: location.trim() || undefined,
      });
      await applyEdit(fresh.id, new Uint8Array(signed));
      setPhase("done");
    } catch (err) {
      setError((err as Error).message ?? String(err));
      setPhase("hasCert");
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && phase !== "signing" && phase !== "generating") onClose();
      }}
    >
      <div
        className="w-[540px] overflow-hidden rounded-2xl border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] shadow-2xl"
        data-testid="digital-sign-modal"
      >
        <div className="flex items-center justify-between border-b border-[var(--panel-border)] px-5 py-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.8} />
            <h2 className="text-[15px] font-semibold">Digital signature (PKCS#7)</h2>
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

        <div className="px-5 py-4">
          {phase === "loading" && (
            <div className="flex items-center gap-2 text-[13px] text-[var(--muted)]">
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.8} />
              Checking certificate…
            </div>
          )}

          {phase === "noCert" && (
            <>
              <p className="mb-3 text-[13px] text-[var(--app-fg)]">
                No digital certificate yet. Create a self-signed one to sign PDFs. Keys never leave this Mac.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">Name</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Adam Hayat"
                    className="h-9 rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                    data-testid="sig-name"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">Email</span>
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    type="email"
                    className="h-9 rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                    data-testid="sig-email"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">Organization (optional)</span>
                  <input
                    value={org}
                    onChange={(e) => setOrg(e.target.value)}
                    className="h-9 rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">Valid for (years)</span>
                  <input
                    type="number"
                    value={years}
                    min={1}
                    max={25}
                    onChange={(e) => setYears(Math.max(1, Math.min(25, parseInt(e.target.value, 10) || 5)))}
                    className="h-9 rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                  />
                </label>
              </div>
            </>
          )}

          {phase === "generating" && (
            <div className="py-6 text-center">
              <Loader2 className="mx-auto mb-3 h-5 w-5 animate-spin text-[var(--color-accent)]" strokeWidth={1.8} />
              <p className="text-[13px] font-medium text-[var(--app-fg)]">
                Generating 2048-bit RSA key…
              </p>
              <p className="mt-1 text-[11px] text-[var(--muted)]">
                This can take a few seconds on the first certificate.
              </p>
              <div className="mx-auto mt-4 h-1 w-48 overflow-hidden rounded-full bg-[var(--hover-bg)]">
                <div className="h-full w-1/2 animate-pulse rounded-full bg-[var(--color-accent)]" />
              </div>
            </div>
          )}

          {(phase === "hasCert" || phase === "signing" || phase === "done") && info && (
            <>
              <div className="mb-4 rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] p-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">Active certificate</span>
                  <button
                    type="button"
                    onClick={clearCert}
                    disabled={phase === "signing"}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--muted)] hover:bg-[var(--color-destructive)]/10 hover:text-[var(--color-destructive)] disabled:opacity-50"
                    title="Delete this certificate"
                  >
                    <Trash2 className="h-3 w-3" strokeWidth={1.8} /> Remove
                  </button>
                </div>
                <div className="text-[13px] font-medium text-[var(--app-fg)]">{info.name}</div>
                <div className="text-[12px] text-[var(--muted)]">{info.email}</div>
                {info.org && <div className="text-[12px] text-[var(--muted)]">{info.org}</div>}
                <div className="mt-1 text-[11px] tabular-nums text-[var(--muted)]">
                  Valid until {new Date(info.expiresAt).toLocaleDateString()}
                </div>
              </div>

              {phase === "done" ? (
                <p className="rounded-md border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 p-3 text-[12px] text-[var(--app-fg)]">
                  Signed. The PDF now carries a cryptographic signature dictionary. Any viewer that understands PKCS#7 will show the signature panel.
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">Reason</span>
                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      className="h-9 rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                      data-testid="sig-reason"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--subtle)]">Location</span>
                    <input
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      className="h-9 rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 text-[13px] text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                    />
                  </label>
                </div>
              )}
            </>
          )}

          {error && (
            <p className="mt-3 rounded-md border border-[var(--color-destructive)]/40 bg-[var(--color-destructive)]/10 p-2 text-[12px] text-[var(--color-destructive)]">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--panel-border)] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={phase === "signing" || phase === "generating"}
            className="h-8 rounded-md border border-[var(--panel-border)] px-3 text-[12px] text-[var(--app-fg)] hover:bg-[var(--hover-bg)] disabled:opacity-50"
          >
            {phase === "done" ? "Done" : "Cancel"}
          </button>
          {phase === "noCert" && (
            <button
              type="button"
              onClick={generateCert}
              disabled={!name.trim() || !email.trim()}
              className="h-8 rounded-md bg-[var(--color-accent)] px-3 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
              data-testid="sig-gen-cert"
            >
              Create certificate
            </button>
          )}
          {phase === "hasCert" && (
            <button
              type="button"
              onClick={signNow}
              className="h-8 rounded-md bg-[var(--color-accent)] px-3 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)]"
              data-testid="sig-sign"
            >
              Sign PDF
            </button>
          )}
          {phase === "signing" && (
            <button type="button" disabled className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 text-[12px] font-medium text-white opacity-60">
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />
              Signing…
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
