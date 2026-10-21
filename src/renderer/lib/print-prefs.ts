import type {
  DuplexMode,
  PaperKey,
  PerSheet,
  PrintAction,
  PrintSettings,
} from "../components/PrintPreviewModal/usePrintReducer";

// V1.0127: Print settings are remembered across prints and app restarts.
// Adam: "if I set it up a certain way, it just does that automatically the
// next time for all future sheets until it changes again."
//
// Only settings the user CHOSE are stored — the dialog writes through
// `prefsPatchFromAction` on control changes, never on its own seeding
// (default printer pick, paper detected from the document), so an
// auto-detected value never hardens into a "choice".
//
// V1.0128: Adam — "make sure it remembers ALL settings for print". Copies and
// orientation are now remembered too. The ONE exception is the page range:
// "1-3" picked for one document would silently print part of the next one
// (or error on a shorter one), so it resets each time.
//
// Storage is renderer localStorage (local-only, Critical Rule #1). Every
// read/write is guarded; a missing or corrupt entry means "no preferences".

export const PRINT_PREFS_KEY = "weavepdf-print-prefs-v1";

export type PrintPrefs = Partial<
  Pick<
    PrintSettings,
    | "deviceName"
    | "deviceDisplayName"
    | "copies"
    | "orientation"
    | "paper"
    | "layout"
    | "color"
    | "duplex"
    | "scalePct"
    | "fullPage"
  >
>;

type KV = Pick<Storage, "getItem" | "setItem">;

const PAPERS: readonly PaperKey[] = ["letter", "legal", "a4", "a3", "a5", "tabloid"];
const LAYOUTS: readonly PerSheet[] = [1, 2, 4, 6, 9, "fit"];
const DUPLEX: readonly DuplexMode[] = ["simplex", "shortEdge", "longEdge"];

function defaultStorage(): KV | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Keep only well-formed fields — a hand-edited or older entry can never
 *  push an invalid value into the print pipeline. */
export function sanitizePrintPrefs(raw: unknown): PrintPrefs {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: PrintPrefs = {};
  if (typeof r.deviceName === "string" && r.deviceName) {
    out.deviceName = r.deviceName;
    out.deviceDisplayName =
      typeof r.deviceDisplayName === "string" && r.deviceDisplayName
        ? r.deviceDisplayName
        : r.deviceName;
  }
  if (typeof r.copies === "number" && Number.isFinite(r.copies)) {
    out.copies = Math.max(1, Math.min(999, Math.floor(r.copies)));
  }
  if (r.orientation === "portrait" || r.orientation === "landscape") out.orientation = r.orientation;
  if (PAPERS.includes(r.paper as PaperKey)) out.paper = r.paper as PaperKey;
  if (LAYOUTS.includes(r.layout as PerSheet)) out.layout = r.layout as PerSheet;
  if (typeof r.color === "boolean") out.color = r.color;
  if (DUPLEX.includes(r.duplex as DuplexMode)) out.duplex = r.duplex as DuplexMode;
  if (typeof r.scalePct === "number" && Number.isFinite(r.scalePct)) {
    out.scalePct = Math.max(10, Math.min(400, Math.round(r.scalePct)));
  }
  if (typeof r.fullPage === "boolean") out.fullPage = r.fullPage;
  return out;
}

export function loadPrintPrefs(storage: KV | null = defaultStorage()): PrintPrefs {
  if (!storage) return {};
  try {
    const raw = storage.getItem(PRINT_PREFS_KEY);
    return raw ? sanitizePrintPrefs(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

/** Merge `patch` into the stored preferences. Never throws. */
export function savePrintPrefs(
  patch: PrintPrefs,
  storage: KV | null = defaultStorage(),
): void {
  if (!storage || Object.keys(patch).length === 0) return;
  try {
    const next = sanitizePrintPrefs({ ...loadPrintPrefs(storage), ...patch });
    storage.setItem(PRINT_PREFS_KEY, JSON.stringify(next));
  } catch {
    // Storage full / blocked — the print itself must never fail over this.
  }
}

/** The remembered-field change a user action makes, or null for the page
 *  range (per document). */
export function prefsPatchFromAction(action: PrintAction): PrintPrefs | null {
  switch (action.type) {
    case "set-printer":
      return { deviceName: action.name, deviceDisplayName: action.displayName };
    case "set-copies":
      return { copies: action.value };
    case "set-orientation":
      return { orientation: action.value };
    case "set-paper":
      return { paper: action.value };
    case "set-layout":
      return { layout: action.value };
    case "set-color":
      return { color: action.value };
    case "set-duplex":
      return { duplex: action.value };
    case "set-scale-pct":
      return { scalePct: action.value };
    case "set-full-page":
      return { fullPage: action.value };
    default:
      return null;
  }
}
