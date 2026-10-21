/**
 * V1.0126: the CSS font an on-screen text box uses, chosen by the SAME rule
 * the save uses (`matchStandardFont` in pdf-ops: Times / Courier / Helvetica).
 * Text boxes always rendered in Helvetica on screen, so an Edit Text
 * replacement on a serif form looked right in WeavePDF and came out in Times
 * in the saved file.
 */
export function overlayFontFamily(fontName: string | undefined | null): string {
  const f = (fontName ?? "").toLowerCase();
  if ((f.includes("times") || f.includes("serif")) && !f.includes("sans")) {
    return '"Times New Roman", Times, serif';
  }
  if (f.includes("courier") || f.includes("mono")) return '"Courier New", Courier, monospace';
  return "Helvetica, sans-serif";
}
