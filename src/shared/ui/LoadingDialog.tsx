import { useEffect } from 'react';
import { formatBytes, type DownloadProgress } from '../modelLoader';
import { ProgressBar } from './ProgressBar';

export interface LoadingDialogProps {
  /** Whether the dialog is visible. */
  open: boolean;
  /** Headline, e.g. "Loading model…". */
  title?: string;
  /** Secondary status line, e.g. "WebGPU unavailable — using WASM…". */
  status?: string;
  /** Live download progress, if the weights are still being fetched. */
  progress?: DownloadProgress | null;
  /** Model name for context, e.g. "Qwen2.5-0.5B-Instruct". */
  modelLabel?: string;
  /** Human-readable model size, e.g. "~400 MB". */
  sizeLabel?: string;
}

function basename(file: string): string {
  return file.split('/').pop() || file;
}

/**
 * Blocking modal shown while a model loads (weights download + session build).
 * Unlike a bare status line, it gives the wait a clear home: a spinner that
 * proves the app is alive, live progress when there is any, and enough context
 * that the user knows exactly what is happening and why.
 */
export function LoadingDialog({ open, title = 'Loading model…', status, progress, modelLabel, sizeLabel }: LoadingDialogProps) {
  // Lock background scroll while the dialog owns the screen.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  const hasFiles = Boolean(progress && progress.files.length > 0);
  const pct = progress ? Math.min(100, Math.round(progress.overall)) : null;
  const determinate = hasFiles && pct != null && pct < 100;
  const currentFile = progress?.currentFile ? basename(progress.currentFile) : null;

  const bytesLabel =
    progress && progress.loadedBytes
      ? `${formatBytes(progress.loadedBytes)}${progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : sizeLabel ? ` / ${sizeLabel}` : ''}`
      : (sizeLabel ?? '');

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="loading-dialog-title" className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />

      <div className="relative w-full max-w-[400px] overflow-hidden rounded-[28px] border border-[var(--border)] bg-[var(--bg-soft)] shadow-[0_24px_80px_rgba(0,0,0,0.28)]">
        {/* Animated top edge so the card reads as "working" at a glance. */}
        <div className="h-[3px] w-full overflow-hidden bg-[var(--border)]">
          <div className={`h-full w-1/3 rounded-full bg-[var(--text)] ${determinate ? '' : 'animate-pulse'}`} />
        </div>

        <div className="p-7">
          <div className="flex items-center gap-4">
            <span className="relative flex h-12 w-12 shrink-0 items-center justify-center">
              <svg className="h-12 w-12 animate-spin text-[var(--text)]" viewBox="0 0 50 50" fill="none" aria-hidden="true">
                <circle cx="25" cy="25" r="20" stroke="currentColor" strokeOpacity="0.12" strokeWidth="4" />
                <path d="M45 25a20 20 0 0 0-20-20" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
              </svg>
            </span>

            <div className="min-w-0 flex-1">
              <div id="loading-dialog-title" className="text-[16px] font-[550] tracking-[-0.01em] text-[var(--text)]">
                {title}
              </div>
              <div className="mono mt-1 truncate text-[11px] text-[var(--text-muted)]">{status || 'Preparing the model…'}</div>
            </div>
          </div>

          <div className="mt-6">
            <div className="mono mb-2 flex items-center justify-between gap-3 text-[10px] tracking-wide">
              <span className="truncate text-[var(--text-muted)]">{currentFile ?? (hasFiles ? (modelLabel ?? 'Downloading weights…') : 'Building session…')}</span>
              {determinate ? <span className="shrink-0 text-[var(--text-faint)]">{pct}%</span> : null}
            </div>

            <ProgressBar value={pct ?? 0} indeterminate={!determinate} className="h-[6px]" />

            <div className="mono mt-2 flex items-center justify-between gap-3 text-[10px] tracking-wide text-[var(--text-faint)]">
              <span className="truncate">{bytesLabel}</span>
              <span className="shrink-0">{progress?.bytesPerSec ? `${formatBytes(progress.bytesPerSec)}/s` : modelLabel ?? ''}</span>
            </div>
          </div>

          <div className="mono mt-6 flex items-center gap-2 border-t border-[var(--border)] pt-4 text-[10px] leading-4 text-[var(--text-faint)]">
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
            Runs on your device — nothing is uploaded.
          </div>
        </div>
      </div>
    </div>
  );
}
