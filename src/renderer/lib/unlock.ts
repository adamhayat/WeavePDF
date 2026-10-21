// V1.0122: shared owner-locked unlock for every route that turns disk bytes
// into tab or merge input.
//
// Owner-locked PDFs (encrypted with an EMPTY user password — insurance / MTO /
// CVOR forms) open fine for viewing, but pdf-lib copies their undecryptable
// content streams into every structural result, which pdf.js then renders as
// BLANK pages. The open path in App.tsx unlocks at the open boundary; this
// helper exists for the routes that bypass it (thumbnail-rail merge, draft
// restore). Note that once an encrypted source has been MERGED into a plain
// host, the damage is undetectable — the merged container has no /Encrypt
// dict, so isPdfEncrypted can no longer be true — which is why the unlock
// must happen here, before the bytes cross the boundary, not at save time.

const loadPdfOps = () => import("./pdf-ops");

export type UnlockResult =
  | { ok: true; bytes: Uint8Array<ArrayBuffer>; unlocked: boolean }
  | { ok: false; reason: "qpdf-missing" | "decrypt-failed" };

/** Return the bytes to actually use: decrypted when the input is encrypted
 *  and qpdf can clear it (empty user password), the input unchanged when it
 *  isn't encrypted, and a refusal (never silently-encrypted bytes) when the
 *  input is encrypted but can't be unlocked. */
export async function unlockIfOwnerLocked(bytes: Uint8Array<ArrayBuffer>): Promise<UnlockResult> {
  const { isPdfEncrypted } = await loadPdfOps();
  try {
    if (!(await isPdfEncrypted(bytes))) return { ok: true, bytes, unlocked: false };
  } catch {
    // Unparseable enough that encryption detection failed — let the caller's
    // own pdf.js/pdf-lib load produce the real error.
    return { ok: true, bytes, unlocked: false };
  }
  if (!(await window.weavepdf.qpdf.available())) return { ok: false, reason: "qpdf-missing" };
  try {
    const ab = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const plain = new Uint8Array(await window.weavepdf.qpdf.decrypt(ab, ""));
    return { ok: true, bytes: plain, unlocked: true };
  } catch (err) {
    console.error("unlockIfOwnerLocked: decrypt failed", err);
    return { ok: false, reason: "decrypt-failed" };
  }
}
