export interface ProgressBarProps {
  /** 0..100 */
  value?: number;
  /** Show an animated placeholder instead of a determinate bar. */
  indeterminate?: boolean;
  className?: string;
}

/** Slim determinate progress bar using the app's monochrome accent. */
export function ProgressBar({ value = 0, indeterminate = false, className = "" }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
      className={`h-[6px] w-full overflow-hidden rounded-full bg-[var(--border)] ${className}`}
    >
      <div
        className={`h-full rounded-full bg-[var(--text)] transition-all duration-300 ease-out ${indeterminate ? "w-1/3 animate-pulse" : ""}`}
        style={indeterminate ? undefined : { width: `${pct}%` }}
      />
    </div>
  );
}
