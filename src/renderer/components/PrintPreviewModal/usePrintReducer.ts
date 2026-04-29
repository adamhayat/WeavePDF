import { useReducer } from "react";

// V1.0028: state machine for the unified Print Preview panel.
// Settings live local to the modal (transient, tied to one open session)
// per the design spec — no Zustand surface-area for "current print job".

export type PerSheet = 1 | 2 | 4 | 6 | 9;
export type Orientation = "portrait" | "landscape";
export type PaperKey = "letter" | "legal" | "a4" | "a3" | "a5" | "tabloid";
export type DuplexMode = "simplex" | "shortEdge" | "longEdge";

export type PrintSettings = {
  /** Selected printer's CUPS device name (the .name field from listPrinters). */
  deviceName: string;
  /** Display name for the dropdown — never sent to print(). */
  deviceDisplayName: string;
  copies: number;
  /** "" = all pages. Anything else parses to ranges via parsePageRanges. */
  pagesInput: string;
  paper: PaperKey;
  layout: PerSheet;
  orientation: Orientation;
  color: boolean;
  duplex: DuplexMode;
};

export type PrintAction =
  | { type: "set-printer"; name: string; displayName: string }
  | { type: "set-copies"; value: number }
  | { type: "set-pages-input"; value: string }
  | { type: "set-paper"; value: PaperKey }
  | { type: "set-layout"; value: PerSheet }
  | { type: "set-orientation"; value: Orientation }
  | { type: "set-color"; value: boolean }
  | { type: "set-duplex"; value: DuplexMode };

export const INITIAL_SETTINGS: PrintSettings = {
  deviceName: "",
  deviceDisplayName: "",
  copies: 1,
  pagesInput: "",
  paper: "letter",
  layout: 1,
  orientation: "portrait",
  color: true,
  duplex: "simplex",
};

function reducer(state: PrintSettings, action: PrintAction): PrintSettings {
  switch (action.type) {
    case "set-printer":
      return { ...state, deviceName: action.name, deviceDisplayName: action.displayName };
    case "set-copies":
      return { ...state, copies: Math.max(1, Math.min(999, Math.floor(action.value || 1))) };
    case "set-pages-input":
      return { ...state, pagesInput: action.value };
    case "set-paper":
      return { ...state, paper: action.value };
    case "set-layout":
      return { ...state, layout: action.value };
    case "set-orientation":
      return { ...state, orientation: action.value };
    case "set-color":
      return { ...state, color: action.value };
    case "set-duplex":
      return { ...state, duplex: action.value };
    default:
      return state;
  }
}

export function usePrintReducer(initial: Partial<PrintSettings> = {}) {
  return useReducer(reducer, { ...INITIAL_SETTINGS, ...initial });
}

/**
 * Parse "1-3,5,8-10" → [{from:1,to:3},{from:5,to:5},{from:8,to:10}].
 * Returns null on parse error (renders an inline UI hint). Empty/whitespace
 * input returns [] (= "all pages" in the print API).
 */
export function parsePageRanges(
  input: string,
  totalPages: number,
): { ranges: Array<{ from: number; to: number }>; error: string | null } {
  const trimmed = input.trim();
  if (!trimmed) return { ranges: [], error: null };
  const ranges: Array<{ from: number; to: number }> = [];
  for (const part of trimmed.split(/\s*,\s*/)) {
    const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(part);
    if (!m) return { ranges: [], error: `"${part}" isn’t a valid range` };
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (from < 1 || to < 1 || from > totalPages || to > totalPages) {
      return { ranges: [], error: `Pages must be 1–${totalPages}` };
    }
    if (to < from) return { ranges: [], error: `"${part}" goes backward` };
    ranges.push({ from, to });
  }
  return { ranges, error: null };
}
