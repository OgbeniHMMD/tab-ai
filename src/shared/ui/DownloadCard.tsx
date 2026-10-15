import type { ReactNode } from 'react';
import { formatBytes, type DownloadProgress, type FileDownload } from '../modelLoader';
import { ProgressBar } from './ProgressBar';
import { Badge } from './Badge';

export interface DownloadCardProps {
  title?: string;
  /** e.g. "Xenova/modnet" */
  modelLabel?: string;
  /** e.g. "~12 MB" */
  sizeLabel?: string;
  progress: DownloadProgress;
  status?: 'downloading' | 'ready' | 'error';
  footer?: ReactNode;
}

function basename(file: string): string {
  return file.split('/').pop() || file;
}

function FileRow({ file }: { file: FileDownload }) {
  const done = file.status === 'done';
  const errored = file.status === 'error';
  const active = file.status === 'downloading';

  return (
    <div className="flex items-center gap-3">
      <div
        className={`flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-full border ${
          done
            ? 'border-emerald-500 bg-emerald-500 text-white'
            : errored
              ? 'border-red-500 bg-red-500 text-white'
              : active
                ? 'border-[var(--text)] bg-[var(--text)] text-[var(--bg)]'
                : 'border-[var(--border)] text-[var(--text-faint)]'
        }`}
      >
        {done ? (
          <span className="text-[10px]">✓</span>
        ) : errored ? (
          <span className="text-[10px]">!</span>
        ) : (
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="mono max-w-[200px] truncate text-[11px] md:max-w-[280px]" title={file.file}>
            {basename(file.file)}
          </span>
          <span className="mono shrink-0 text-[10px] text-[var(--text-faint)]">
            {Math.round(file.progress)}%
            {file.loaded && file.total ? ` • ${formatBytes(file.loaded)}/${formatBytes(file.total)}` : ''}
          </span>
        </div>
        <ProgressBar
          value={file.progress}
          className={`mt-1 h-[4px] ${done ? 'opacity-50' : ''}`}
        />
      </div>
    </div>
  );
}

/** Model download progress: overall %, throughput, and a per-file breakdown. */
export function DownloadCard({
  title = 'Downloading AI model…',
  modelLabel,
  sizeLabel,
  progress,
  status = 'downloading',
  footer,
}: DownloadCardProps) {
  const overall = Math.round(progress.overall);
  const { files, loadedBytes, totalBytes, bytesPerSec, currentFile } = progress;

  return (
    <div className="w-full overflow-hidden rounded-[32px] border border-[var(--border)] bg-[var(--bg-soft)] shadow-[0_12px_48px_rgba(0,0,0,0.06)]">
      <div className="p-7 md:p-8">
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--text)] text-[var(--bg)]">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className={status === 'downloading' ? 'animate-pulse' : ''}
            >
              <path d="M12 3v12M12 15l-4-4M12 15l4-4M3 17v2a2 2 0 002 2h14a2 2 0 002-2v-2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[16px] font-[550] tracking-[-0.01em]">{title}</div>
              <Badge tone={status === 'error' ? 'danger' : status === 'ready' ? 'good' : 'invert'}>
                {status === 'ready' ? 'READY' : `${overall}%`}
              </Badge>
            </div>

            <div className="mono mt-1 truncate text-[11px] text-[var(--text-muted)]">
              {currentFile ? basename(currentFile) : modelLabel ?? 'preparing…'}
              {modelLabel ? ` • ${modelLabel}` : ''}
              {sizeLabel ? ` ${sizeLabel}` : ''}
            </div>

            <ProgressBar value={overall} className="mt-5 h-[8px] p-[2px]" />

            <div className="mono mt-2.5 flex items-center justify-between text-[10px] tracking-wide">
              <span className="text-[var(--text-muted)]">
                {loadedBytes ? formatBytes(loadedBytes) : '0 MB'}
                {totalBytes ? ` / ${formatBytes(totalBytes)}` : sizeLabel ? ` / ${sizeLabel}` : ''}
              </span>
              <span className="flex items-center gap-2 text-[var(--text-faint)]">
                {bytesPerSec ? <span>{formatBytes(bytesPerSec)}/s</span> : null}
                <span>{files.length ? `${files.length} files` : 'preparing…'}</span>
              </span>
            </div>
          </div>
        </div>

        {files.length > 0 ? (
          <div className="mt-7 border-t border-[var(--border)] pt-5">
            <div className="mono mb-3 text-[10px] uppercase tracking-widest text-[var(--text-faint)]">
              Files
            </div>
            <div className="max-h-[220px] space-y-3 overflow-y-auto pr-1">
              {files.map((file) => (
                <FileRow key={file.file} file={file} />
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {footer ? (
        <div className="flex items-center justify-between border-t border-[var(--border)] bg-[var(--surface)] px-7 py-3.5 md:px-8">
          {footer}
        </div>
      ) : null}
    </div>
  );
}
