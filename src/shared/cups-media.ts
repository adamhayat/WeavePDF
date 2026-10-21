// V1.0127: the paper size the printer is set up for (its CUPS default
// PageSize), so the Print dialog lays the sheet out on the paper that is
// actually in the tray. Before this the dialog took Paper from the DOCUMENT
// (V1.0121): an A4 invoice on a Letter-loaded Brother printed an A4 layout
// onto Letter paper and the ~18 mm overflow was cut off.

export type CupsPaperKey = "letter" | "legal" | "a4" | "a3" | "a5" | "tabloid";

const CUPS_TO_PAPER: Record<string, CupsPaperKey> = {
  letter: "letter",
  "na_letter_8.5x11in": "letter",
  legal: "legal",
  "na_legal_8.5x14in": "legal",
  a4: "a4",
  iso_a4_210x297mm: "a4",
  a3: "a3",
  iso_a3_297x420mm: "a3",
  a5: "a5",
  iso_a5_148x210mm: "a5",
  tabloid: "tabloid",
  "11x17": "tabloid",
  "na_ledger_11x17in": "tabloid",
};

/** Parse `lpoptions -p <printer> -l` output and return the default
 *  PageSize (the token marked `*`) as a Paper option, or null when it is
 *  missing or not one we offer. Variants like `Letter.Fullbleed` /
 *  `A4.Borderless` map to their base size. */
export function parseCupsDefaultPageSize(output: string): CupsPaperKey | null {
  const line = output
    .split(/\r?\n/)
    .find((l) => /^(PageSize|media)\//i.test(l.trim()));
  if (!line) return null;
  const values = line.slice(line.indexOf(":") + 1).trim().split(/\s+/);
  const def = values.find((v) => v.startsWith("*"));
  if (!def) return null;
  const base = def.slice(1).toLowerCase().replace(/\.(fullbleed|borderless|fb)$/i, "");
  return CUPS_TO_PAPER[base] ?? null;
}
