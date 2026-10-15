export interface SpinnerProps {
  /** Sizing / color classes, e.g. "h-6 w-6 text-[var(--text)]". */
  className?: string;
}

/** Indeterminate ring spinner that inherits `currentColor` and spins via Tailwind. */
export function Spinner({ className = 'h-5 w-5' }: SpinnerProps) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 50 50" fill="none" aria-hidden="true">
      <circle cx="25" cy="25" r="20" stroke="currentColor" strokeOpacity="0.15" strokeWidth="5" />
      <path d="M45 25a20 20 0 0 0-20-20" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}
