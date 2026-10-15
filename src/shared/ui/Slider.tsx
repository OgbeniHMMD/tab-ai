export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Formats the numeric readout (e.g. two decimals). Defaults to the raw value. */
  format?: (value: number) => string;
  /** Short explanation shown as a native tooltip (hover the "?" or the row). */
  hint?: string;
  onChange: (value: number) => void;
}

/** Labelled range input with an inline value readout. */
export function Slider({ label, value, min, max, step, format, hint, onChange }: SliderProps) {
  return (
    <label className="block" title={hint}>
      <span className="mono mb-1 flex items-center justify-between text-[10px] uppercase tracking-widest text-[var(--text-faint)]">
        <span className="flex items-center gap-1.5">
          {label}
          {hint ? (
            <span
              aria-label={hint}
              className="flex h-3.5 w-3.5 cursor-help select-none items-center justify-center rounded-full border border-[var(--border-strong)] text-[8px] leading-none text-[var(--text-faint)]"
            >
              ?
            </span>
          ) : null}
        </span>
        <span className="text-[var(--text-muted)]">{format ? format(value) : value}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--text)]" />
    </label>
  );
}
