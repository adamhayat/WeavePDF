/**
 * V1.0134: text colour helpers shared by the text overlay (screen), the
 * thumbnail painter and the Add-link flow. Colours are 0..1 RGB like every
 * other colour in the stores; undefined means black.
 */
export type RGB = { r: number; g: number; b: number };

/** Default ink of a text box — the same near-black the overlay always used. */
export const DEFAULT_TEXT_RGB: RGB = { r: 11 / 255, g: 11 / 255, b: 14 / 255 };

/** The blue a linked text box turns (Add link on a whole box). */
export const LINK_TEXT_COLOR: RGB = { r: 13 / 255, g: 110 / 255, b: 253 / 255 };

export const TEXT_COLOR_SWATCHES: Array<{ label: string; rgb: RGB }> = [
  { label: "Black", rgb: DEFAULT_TEXT_RGB },
  { label: "Grey", rgb: { r: 0.42, g: 0.42, b: 0.45 } },
  { label: "Red", rgb: { r: 0.8, g: 0.15, b: 0.15 } },
  { label: "Orange", rgb: { r: 0.95, g: 0.55, b: 0.1 } },
  { label: "Green", rgb: { r: 0.15, g: 0.55, b: 0.25 } },
  { label: "Link blue", rgb: LINK_TEXT_COLOR },
  { label: "Violet", rgb: { r: 0.4, g: 0.25, b: 0.7 } },
  { label: "White", rgb: { r: 1, g: 1, b: 1 } },
];

export function rgbCss(c: RGB | undefined | null): string {
  const v = c ?? DEFAULT_TEXT_RGB;
  const f = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255);
  return `rgb(${f(v.r)}, ${f(v.g)}, ${f(v.b)})`;
}
