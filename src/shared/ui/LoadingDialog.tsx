import { useCallback, useEffect, useState } from "react";
import { formatBytes, type DownloadProgress } from "../modelLoader";
import { ProgressBar } from "./ProgressBar";
import { Spinner } from "./Spinner";

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
  /**
   * Called when the user dismisses the dialog (close button, Escape, or a
   * backdrop click). Providing it makes the dialog dismissible; the caller is
   * responsible for holding the dismissed state and showing a fallback with a
   * way to reopen.
   */
  onClose?: () => void;
}

function basename(file: string): string {
  return file.split("/").pop() || file;
}

/**
 * Pairs with a dismissible `<LoadingDialog>`. Tracks whether the user has
 * dismissed the loader for the current run: `open` is true only while `active`
 * and not dismissed, and dismissal resets automatically the next time a load
 * begins (so a fresh load always surfaces the popup again).
 */
export function useDismissibleLoader(active: boolean) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!active) setDismissed(false);
  }, [active]);

  return {
    open: active && !dismissed,
    dismiss: useCallback(() => setDismissed(true), []),
    reopen: useCallback(() => setDismissed(false), []),
  };
}

/**
 * Modal shown while a model loads (weights download + session build). Unlike a
 * bare status line, it gives the wait a clear home: a spinner that proves the
 * app is alive, live progress when there is any, and enough context that the
 * user knows exactly what is happening and why.
 *
 * Pass `onClose` to make it dismissible — useful for long loads, so the page
 * isn't locked. Pair it with `useDismissibleLoader`.
 */
export function LoadingDialog({ open, title = "Loading model…", status, progress, modelLabel, sizeLabel, onClose }: LoadingDialogProps) {
  // Lock background scroll while the dialog owns the screen.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // Escape dismisses when the caller allows it.
  useEffect(() => {
    if (!open || !onClose) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const hasFiles = Boolean(progress && progress.files.length > 0);
  const pct = progress ? Math.min(100, Math.round(progress.overall)) : null;
  const determinate = hasFiles && pct != null && pct < 100;
  const currentFile = progress?.currentFile ? basename(progress.currentFile) : null;

  const bytesLabel =
    progress && progress.loadedBytes ? `${formatBytes(progress.loadedBytes)}${progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : sizeLabel ? ` / ${sizeLabel}` : ""}` : (sizeLabel ?? "");

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="loading-dialog-title" className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />

      <div className="relative w-full max-w-[400px] overflow-hidden rounded-[28px] border border-[var(--border)] bg-[var(--bg-soft)] shadow-[0_24px_80px_rgba(0,0,0,0.28)]">
        {/* Animated top edge so the card reads as "working" at a glance. */}
        <div className="h-[3px] w-full overflow-hidden bg-[var(--border)]">
          <div className={`h-full w-1/3 rounded-full bg-[var(--text)] ${determinate ? "" : "animate-pulse"}`} />
        </div>

        <div className="p-7">
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Dismiss"
              title="Continue in the background"
              className="absolute right-4 top-5 flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-faint)] transition hover:bg-[var(--surface)] hover:text-[var(--text)]"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
              </svg>
            </button>
          ) : null}

          <div className="flex items-center gap-4 pr-8">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center text-[var(--text)]">
              <Spinner className="h-12 w-12" />
            </span>

            <div className="min-w-0 flex-1">
              <div id="loading-dialog-title" className="text-[16px] font-[550] tracking-[-0.01em] text-[var(--text)]">
                {title}
              </div>
              <div className="mono mt-1 truncate text-[11px] text-[var(--text-muted)]">{status || "Preparing the model…"}</div>
            </div>
          </div>

          <div className="mt-6">
            <div className="mono mb-2 flex items-center justify-between gap-3 text-[10px] tracking-wide">
              <span className="truncate text-[var(--text-muted)]">{currentFile ?? (hasFiles ? (modelLabel ?? "Downloading weights…") : "Building session…")}</span>
              {determinate ? <span className="shrink-0 text-[var(--text-faint)]">{pct}%</span> : null}
            </div>

            <ProgressBar value={pct ?? 0} indeterminate={!determinate} className="h-[6px]" />

            <div className="mono mt-2 flex items-center justify-between gap-3 text-[10px] tracking-wide text-[var(--text-faint)]">
              <span className="truncate">{bytesLabel}</span>
              <span className="shrink-0">{progress?.bytesPerSec ? `${formatBytes(progress.bytesPerSec)}/s` : (modelLabel ?? "")}</span>
            </div>
          </div>

          <div className="mono mt-6 flex items-center gap-2 border-t border-[var(--border)] pt-4 text-[10px] leading-4 text-[var(--text-faint)]">
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
            {onClose ? "You can keep browsing — this runs in the background." : "Runs on your device — nothing is uploaded."}
          </div>
        </div>
      </div>
    </div>
  );
}
