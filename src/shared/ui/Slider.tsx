export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Formats the numeric readout (e.g. two decimals). Defaults to the raw value. */
  format?: (value: number) => string;
  onChange: (value: number) => void;
}

/** Labelled range input with an inline value readout. */
export function Slider({ label, value, min, max, step, format, onChange }: SliderProps) {
  return (
    <label className="block">
      <span className="mono mb-1 flex items-center justify-between text-[10px] uppercase tracking-widest text-[var(--text-faint)]">
        <span>{label}</span>
        <span className="text-[var(--text-muted)]">{format ? format(value) : value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--text)]"
      />
    </label>
  );
}
