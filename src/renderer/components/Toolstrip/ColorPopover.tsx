import { useUIStore } from "../../stores/ui";
import { cn } from "../../lib/cn";

type Swatch = { r: number; g: number; b: number; label: string };

const SWATCHES: Swatch[] = [
  { r: 0.05, g: 0.05, b: 0.1, label: "Ink" },
  { r: 0.8, g: 0.15, b: 0.15, label: "Red" },
  { r: 0.15, g: 0.45, b: 0.85, label: "Blue" },
  { r: 0.15, g: 0.55, b: 0.25, label: "Green" },
  { r: 0.95, g: 0.55, b: 0.1, label: "Orange" },
  { r: 0.4, g: 0.25, b: 0.7, label: "Violet" },
];

type Preset = {
  label: string;
  color: { r: number; g: number; b: number };
  stroke: number;
};

const PRESETS: Preset[] = [
  { label: "Fine", color: { r: 0.05, g: 0.05, b: 0.1 }, stroke: 0.5 },
  { label: "Medium", color: { r: 0.05, g: 0.05, b: 0.1 }, stroke: 1.5 },
  { label: "Bold", color: { r: 0.05, g: 0.05, b: 0.1 }, stroke: 3 },
  { label: "Red review", color: { r: 0.8, g: 0.15, b: 0.15 }, stroke: 2 },
  { label: "Blue note", color: { r: 0.15, g: 0.45, b: 0.85 }, stroke: 1.5 },
];

export function ColorPopover() {
  const tool = useUIStore((s) => s.tool);
  const annotationColor = useUIStore((s) => s.annotationColor);
  const setAnnotationColor = useUIStore((s) => s.setAnnotationColor);
  const strokeWidth = useUIStore((s) => s.strokeWidth);
  const setStrokeWidth = useUIStore((s) => s.setStrokeWidth);
  const recentColors = useUIStore((s) => s.recentColors);

  // Only show when a tool that respects colour is active.
  const relevant =
    tool === "rect" ||
    tool === "circle" ||
    tool === "line" ||
    tool === "arrow" ||
    tool === "draw";
  if (!relevant) return null;

  return (
    <div
      className="flex shrink-0 items-center gap-2 rounded-md border border-[var(--panel-border-strong)] bg-[var(--panel-bg-raised)] px-2 py-1"
      data-testid="color-popover"
    >
      <span className="text-[10px] uppercase tracking-wider text-[var(--subtle)]">Color</span>
      {SWATCHES.map((s) => {
        const active =
          Math.abs(annotationColor.r - s.r) < 0.01 &&
          Math.abs(annotationColor.g - s.g) < 0.01 &&
          Math.abs(annotationColor.b - s.b) < 0.01;
        return (
          <button
            key={s.label}
            type="button"
            onClick={() => setAnnotationColor({ r: s.r, g: s.g, b: s.b })}
            title={s.label}
            aria-label={s.label}
            className={cn(
              "h-5 w-5 rounded-full border-2 transition-transform",
              active
                ? "border-[var(--color-accent)] scale-110"
                : "border-transparent hover:scale-110",
            )}
            style={{
              background: `rgb(${s.r * 255},${s.g * 255},${s.b * 255})`,
            }}
            data-testid={`color-${s.label.toLowerCase()}`}
          />
        );
      })}
      <span className="ml-2 text-[10px] uppercase tracking-wider text-[var(--subtle)]">Weight</span>
      <input
        type="range"
        min={0.5}
        max={8}
        step={0.5}
        value={strokeWidth}
        onChange={(e) => setStrokeWidth(Number(e.target.value))}
        className="w-[72px]"
        title={`${strokeWidth}pt`}
        data-testid="stroke-width"
      />
      {recentColors.length > 0 && (
        <>
          <span className="ml-2 text-[10px] uppercase tracking-wider text-[var(--subtle)]">Recent</span>
          <div className="flex items-center gap-0.5">
            {recentColors.map((c, i) => {
              const active =
                Math.abs(annotationColor.r - c.r) < 0.01 &&
                Math.abs(annotationColor.g - c.g) < 0.01 &&
                Math.abs(annotationColor.b - c.b) < 0.01;
              return (
                <button
                  key={`${c.r}-${c.g}-${c.b}-${i}`}
                  type="button"
                  onClick={() => setAnnotationColor(c)}
                  title={`rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`}
                  className={cn(
                    "h-4 w-4 rounded-full border transition-transform",
                    active
                      ? "border-[var(--color-accent)] scale-110"
                      : "border-[var(--panel-border)] hover:scale-110",
                  )}
                  style={{ background: `rgb(${c.r * 255},${c.g * 255},${c.b * 255})` }}
                />
              );
            })}
          </div>
        </>
      )}
      <span className="ml-2 text-[10px] uppercase tracking-wider text-[var(--subtle)]">Presets</span>
      <div className="flex items-center gap-0.5">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => {
              setAnnotationColor(p.color);
              setStrokeWidth(p.stroke);
            }}
            title={`${p.label} · ${p.stroke}pt`}
            className="rounded px-1.5 py-0.5 text-[10px] text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--app-fg)]"
            data-testid={`preset-${p.label.toLowerCase().replace(/\s/g, "-")}`}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}
