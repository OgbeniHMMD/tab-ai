import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'info' | 'good' | 'warn' | 'danger' | 'invert';

export const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]',
  info: 'border border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-300',
  good: 'border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
  warn: 'border border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
  danger:
    'border border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
  invert: 'border border-transparent bg-[var(--text)] text-[var(--bg)]',
};

export interface BadgeProps {
  children: ReactNode;
  tone?: Tone;
  title?: string;
  className?: string;
}

/** Small rounded label / chip. */
export function Badge({ children, tone = 'neutral', title, className = '' }: BadgeProps) {
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium tracking-wide ${TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
