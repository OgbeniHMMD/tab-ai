import type { ReactNode } from 'react';
import type { Tone } from './Badge';

export type StatusKind = 'idle' | 'working' | 'downloading' | 'ready' | 'error';

const DOT_CLASSES: Record<StatusKind, string> = {
  idle: 'bg-[var(--border-strong)]',
  working: 'bg-[var(--text)] animate-pulse',
  downloading: 'bg-amber-500 animate-pulse',
  ready: 'bg-emerald-500',
  error: 'bg-red-500',
};

const DEFAULT_TONE: Record<StatusKind, Tone> = {
  idle: 'neutral',
  working: 'neutral',
  downloading: 'warn',
  ready: 'good',
  error: 'danger',
};

export interface StatusPillProps {
  status: StatusKind;
  children: ReactNode;
  tone?: Tone;
  className?: string;
}

/** Compact status indicator: colored dot + label, in a pill. */
export function StatusPill({ status, children, tone, className = '' }: StatusPillProps) {
  const palette = tone ?? DEFAULT_TONE[status];
  const toneClasses: Record<Tone, string> = {
    neutral: 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]',
    info: 'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-300',
    good: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
    warn: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
    danger:
      'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
    invert: 'border-transparent bg-[var(--text)] text-[var(--bg)]',
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${toneClasses[palette]} ${className}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASSES[status]}`} />
      {children}
    </span>
  );
}
