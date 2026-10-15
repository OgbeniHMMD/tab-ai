import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";

import { acquirePipeline, formatBytes, type DownloadProgress } from "../shared/modelLoader";
import { clearModelCache, estimateStorage } from "../shared/storage";
import { DownloadCard, ProgressBar, StatusPill } from "../shared/ui";

/* -------------------------------------------------------------------------- */
/*  Model catalog                                                             */
/* -------------------------------------------------------------------------- */

const MODNET = {
  id: "Xenova/modnet",
  label: "MODNet",
  origin: "briaai/RMBG-1.4 (distilled)",
  size: "~12 MB",
  version: "modnet-photographic",
  quant: "quantized • q4f16 • WASM",
};

/** Longest side passed to the model. Output is always resized back to source. */
const MAX_INPUT = 1024;

type Phase = "idle" | "segmenting" | "compositing" | "done" | "error";
type ModelStatus = "loading" | "ready" | "error";

/* -------------------------------------------------------------------------- */
/*  Image helpers                                                             */
/* -------------------------------------------------------------------------- */

function resizeToCanvas(image: HTMLImageElement): HTMLCanvasElement {
  const scale = Math.min(1, MAX_INPUT / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Normalise whatever the model returns into a canvas we can draw from. */
function maskToCanvas(mask: any): HTMLCanvasElement {
  if (mask instanceof HTMLCanvasElement) return mask;
  if (mask?.toCanvas) return mask.toCanvas();

  const width = mask?.width ?? 0;
  const height = mask?.height ?? 0;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx || !width || !height) return canvas;

  const data: Uint8Array | undefined = mask?.data;
  if (!data) return canvas;

  const imageData = ctx.createImageData(width, height);
  if (data.length === width * height) {
    // Single-channel grayscale mask (MODNet).
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      imageData.data[i * 4] = v;
      imageData.data[i * 4 + 1] = v;
      imageData.data[i * 4 + 2] = v;
      imageData.data[i * 4 + 3] = 255;
    }
  } else if (data.length === width * height * 4) {
    imageData.data.set(data);
  } else if (data.length === width * height * 3) {
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      imageData.data[j] = data[i];
      imageData.data[j + 1] = data[i + 1];
      imageData.data[j + 2] = data[i + 2];
      imageData.data[j + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/** Apply a grayscale mask to the original image as its alpha channel. */
function compositeCutout(source: HTMLImageElement, mask: HTMLCanvasElement): HTMLCanvasElement {
  const width = source.naturalWidth;
  const height = source.naturalHeight;

  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const outCtx = out.getContext("2d", { willReadFrequently: true })!;
  outCtx.drawImage(source, 0, 0, width, height);

  const scaled = document.createElement("canvas");
  scaled.width = width;
  scaled.height = height;
  const scaledCtx = scaled.getContext("2d", { willReadFrequently: true })!;
  scaledCtx.imageSmoothingEnabled = true;
  scaledCtx.imageSmoothingQuality = "high";
  scaledCtx.drawImage(mask, 0, 0, width, height);

  const pixels = outCtx.getImageData(0, 0, width, height);
  const maskPixels = scaledCtx.getImageData(0, 0, width, height);
  for (let i = 0; i < pixels.data.length; i += 4) {
    pixels.data[i + 3] = (maskPixels.data[i] + maskPixels.data[i + 1] + maskPixels.data[i + 2]) / 3;
  }
  outCtx.putImageData(pixels, 0, 0);
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

export default function BackgroundPage() {
  const aliveRef = useRef(true);
  const processingRef = useRef(false);
  const pipelineRef = useRef<((input: unknown, options?: unknown) => Promise<any>) | null>(null);
  const releaseRef = useRef<(() => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cutoutCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [modelStatus, setModelStatus] = useState<ModelStatus>("loading");
  const [modelError, setModelError] = useState<string | null>(null);
  const [download, setDownload] = useState<DownloadProgress | null>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [cutoutUrl, setCutoutUrl] = useState<string | null>(null);
  const [sourceSize, setSourceSize] = useState<{ w: number; h: number } | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [compare, setCompare] = useState(50);
  const [dragging, setDragging] = useState(false);

  const [storageLabel, setStorageLabel] = useState("—");
  const [storageDetail, setStorageDetail] = useState("");
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheNote, setCacheNote] = useState<string | null>(null);

  /* ----------------------------- model loading ---------------------------- */

  const loadModel = useCallback(() => {
    releaseRef.current?.();
    pipelineRef.current = null;
    setModelError(null);
    setModelStatus("loading");
    setDownload(null);

    const handle = acquirePipeline<(input: unknown, options?: unknown) => Promise<any>>("image-segmentation", MODNET.id, { quantized: true, onProgress: setDownload });
    releaseRef.current = handle.release;

    handle.result
      .then((instance) => {
        if (!aliveRef.current) return;
        pipelineRef.current = instance;
        setModelStatus("ready");
      })
      .catch((err: Error) => {
        if (!aliveRef.current) return;
        pipelineRef.current = null;
        setModelError(err.message || "Failed to load model");
        setModelStatus("error");
      });
  }, []);

  // Load on mount; release (cancel + dispose) on unmount / navigation.
  useEffect(() => {
    aliveRef.current = true;
    loadModel();
    return () => {
      aliveRef.current = false;
      releaseRef.current?.();
      releaseRef.current = null;
      pipelineRef.current = null;
    };
  }, [loadModel]);

  /* ------------------------------- storage -------------------------------- */

  const refreshStorage = useCallback(async () => {
    const { usage, quota } = await estimateStorage();
    if (!aliveRef.current) return;
    if (usage == null) {
      setStorageLabel("—");
      setStorageDetail("Storage API unavailable");
      return;
    }
    setStorageLabel(formatBytes(usage));
    setStorageDetail(quota ? `${formatBytes(usage)} used of ${formatBytes(quota)} (all origins)` : "");
  }, []);

  useEffect(() => {
    void refreshStorage();
    const timer = window.setInterval(() => void refreshStorage(), 4000);
    return () => window.clearInterval(timer);
  }, [refreshStorage]);

  const onClearCache = useCallback(async () => {
    setCacheBusy(true);
    setCacheNote(null);
    try {
      const summary = await clearModelCache();
      setCacheNote(`Cleared: ${summary}`);
      await refreshStorage();
    } finally {
      if (aliveRef.current) setCacheBusy(false);
    }
  }, [refreshStorage]);

  /* ------------------------------ processing ------------------------------ */

  const runSegmentation = useCallback(async (image: HTMLImageElement) => {
    const generator = pipelineRef.current;
    if (!generator || processingRef.current) return;
    processingRef.current = true;
    setError(null);
    setPhase("segmenting");

    try {
      const input = resizeToCanvas(image);
      const output = await generator(input, { threshold: 0.5 });
      if (!aliveRef.current) return;
      setPhase("compositing");

      const first = Array.isArray(output) ? output[0] : output;
      const rawMask = first?.mask ?? first;
      if (!rawMask) throw new Error("Unexpected model output");

      const mask = maskToCanvas(rawMask);
      const cutout = compositeCutout(image, mask);
      cutoutCanvasRef.current = cutout;
      setCutoutUrl(cutout.toDataURL("image/png"));
      setPhase("done");
    } catch (err) {
      if (aliveRef.current) {
        setError(err instanceof Error ? err.message : "Failed to remove background");
        setPhase("error");
      }
    } finally {
      processingRef.current = false;
    }
  }, []);

  const acceptFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith("image/")) {
        setError("That file is not an image.");
        setPhase("error");
        return;
      }
      setError(null);
      setFileName(file.name);
      setCutoutUrl(null);
      cutoutCanvasRef.current = null;
      setPhase("idle");
      setCompare(50);

      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        if (!aliveRef.current) return;
        setOriginalUrl(url);
        setSourceSize({ w: image.naturalWidth, h: image.naturalHeight });
        void runSegmentation(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        if (aliveRef.current) {
          setError("Could not load that image.");
          setPhase("error");
        }
      };
      image.src = url;
    },
    [runSegmentation],
  );

  // Paste-to-load.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            acceptFile(file);
            break;
          }
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [acceptFile]);

  // Free the previous object URL.
  useEffect(() => {
    return () => {
      if (originalUrl) URL.revokeObjectURL(originalUrl);
    };
  }, [originalUrl]);

  /* ------------------------------- actions -------------------------------- */

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) acceptFile(file);
    event.target.value = "";
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    const file = event.dataTransfer.files?.[0];
    if (file) acceptFile(file);
  };

  const onDownload = () => {
    const canvas = cutoutCanvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${fileName ? fileName.replace(/\.[^.]+$/, "") : "image"}-cutout.png`;
      anchor.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  };

  const onReset = () => {
    setFileName(null);
    setOriginalUrl(null);
    setCutoutUrl(null);
    setSourceSize(null);
    cutoutCanvasRef.current = null;
    setPhase("idle");
    setError(null);
    setCompare(50);
  };

  /* ------------------------------ derived UI ------------------------------ */

  const hasImage = Boolean(originalUrl);
  const busy = phase === "segmenting" || phase === "compositing";
  const showDownloadCard = modelStatus === "loading" && download !== null && download.overall < 100;
  const ready = modelStatus === "ready";

  const statusLabel = modelStatus === "error" ? "Failed" : ready ? "Ready" : modelStatus === "loading" ? "Downloading" : "Idle";

  const statusKind = modelStatus === "error" ? "error" : ready ? "ready" : "downloading";

  return (
    <div className="flex w-full flex-1 flex-col items-center">
      <div className="flex w-full max-w-[640px] flex-col items-center px-6 pb-16 pt-10 md:pt-14">
        {!hasImage ? (
          <>
            <div className="mb-8 w-full text-center">
              <h1 className="display text-[32px] leading-[0.95] tracking-[-0.03em] md:text-[44px]">
                Remove background.
                <br />
                Right here.
              </h1>
              <p className="mx-auto mt-4 max-w-[36ch] text-[15px] leading-6 text-[var(--text-muted)]">
                Private, on-device AI. No servers, no signup. Just drop an image and download a transparent PNG.
              </p>
            </div>

            {showDownloadCard && download ? (
              <DownloadCard
                modelLabel={MODNET.id}
                sizeLabel={MODNET.size}
                progress={download}
                footer={
                  <>
                    <span className="mono flex items-center gap-1.5 text-[10px] text-[var(--text-faint)]">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                      Downloading from Hugging Face • cached in browser
                    </span>
                    <span className="mono hidden text-[10px] text-[var(--text-faint)] md:inline">Runs fully offline after</span>
                  </>
                }
              />
            ) : (
              <div className="flex w-full flex-col items-center">
                {modelStatus === "error" ? (
                  <div className="mb-6 flex w-full items-start gap-3 rounded-[20px] border border-red-200 bg-red-50/60 p-4 dark:border-red-900/60 dark:bg-red-950/20">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-500 text-[14px] font-bold text-white">!</div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold text-red-900 dark:text-red-200">Download failed</div>
                      <div className="mono mt-1 text-[11px] leading-5 text-red-700/80 dark:text-red-300/80">{modelError || "Network error • could not fetch the model."}</div>
                      <div className="mt-3 flex gap-2">
                        <button onClick={loadModel} className="rounded-full bg-red-600 px-4 py-2 text-[12px] font-medium text-white transition hover:bg-red-700">
                          Retry
                        </button>
                        <button
                          onClick={async () => {
                            await onClearCache();
                            loadModel();
                          }}
                          className="rounded-full border border-red-200 bg-white px-4 py-2 text-[12px] font-medium text-red-700 transition hover:border-red-300 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200"
                        >
                          Clear & retry
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}

                {ready && !busy ? (
                  <div className="mono mb-6 inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3.5 py-1.5 text-[11px] text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-[10px] text-white">✓</span>
                    Model ready • runs offline now
                  </div>
                ) : null}

                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={onDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`group flex min-h-[380px] w-full cursor-pointer flex-col items-center justify-center rounded-[32px] border bg-[var(--bg-soft)] p-8 transition-all duration-300 md:min-h-[440px] md:p-12 ${
                    dragOver
                      ? "scale-[1.01] border-[var(--text)] shadow-[0_0_0_1px_var(--text)]"
                      : "border-[var(--border)] hover:border-[var(--border-strong)] hover:shadow-[0_8px_40px_rgba(0,0,0,0.06)]"
                  }`}
                >
                  <div
                    className={`mb-6 flex h-[72px] w-[72px] items-center justify-center rounded-full border transition-colors ${
                      dragOver
                        ? "border-[var(--text)] bg-[var(--text)] text-[var(--bg)]"
                        : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-faint)] group-hover:border-[var(--border-strong)]"
                    }`}
                  >
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
                      <path d="M12 16V4M12 4l-3.5 3.5M12 4l3.5 3.5" />
                      <path d="M4 14v3a2 2 0 002 2h12a2 2 0 002-2v-3" strokeLinecap="round" />
                    </svg>
                  </div>
                  <div className="text-center">
                    <div className="text-[19px] font-[500] tracking-[-0.02em]">Drop image here</div>
                    <div className="mono mt-2 text-[12px] text-[var(--text-muted)]">or click to browse • PNG, JPG, WEBP</div>
                    <div className="mono mt-5 inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[10px] tracking-wide text-[var(--text-faint)]">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                      {busy ? "Preparing…" : "Runs in your browser"}
                    </div>
                  </div>
                </div>

                <div className="mono mt-8 flex items-center gap-2 text-[11px] text-[var(--text-faint)]">
                  <span>Paste with ⌘V</span>
                  <span className="h-1 w-1 rounded-full bg-[var(--border-strong)]" />
                  <span>Works offline after first load</span>
                </div>
              </div>
            )}

            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={onFileChange} />
          </>
        ) : (
          <div className="flex w-full flex-col items-center gap-6">
            <div className="w-full max-w-[560px]">
              {busy ? (
                <div className="rounded-[20px] border border-[var(--border)] bg-[var(--bg-soft)] p-4 shadow-[0_8px_24px_rgba(0,0,0,0.04)]">
                  <div className="flex items-center justify-between">
                    <span className="mono text-[11px] font-medium tracking-wide">{phase === "compositing" ? "Cleaning edges…" : "Removing background…"}</span>
                    <span className="mono text-[10px] text-[var(--text-faint)]">{phase === "compositing" ? "88%" : "50%"}</span>
                  </div>
                  <ProgressBar indeterminate className="mt-3 h-[6px]" />
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <StatusPill status={statusKind}>{statusLabel}</StatusPill>
                  <span className="mono text-[10px] text-[var(--text-faint)]">
                    {MODNET.id} • {MODNET.size}
                  </span>
                </div>
              )}
            </div>

            <div className="w-full overflow-hidden rounded-[28px] border border-[var(--border)] bg-[var(--bg-soft)] shadow-[0_20px_60px_rgba(0,0,0,0.06)] md:rounded-[36px]">
              <div
                className="relative aspect-[4/3] w-full select-none overflow-hidden bg-[#fafaf8] dark:bg-[#121214] md:aspect-[16/11]"
                onMouseMove={(e) => {
                  if (!dragging || !cutoutUrl) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  setCompare(Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100)));
                }}
                onMouseUp={() => setDragging(false)}
                onMouseLeave={() => setDragging(false)}
                onTouchMove={(e) => {
                  if (!cutoutUrl) return;
                  const touch = e.touches[0];
                  const rect = e.currentTarget.getBoundingClientRect();
                  setCompare(Math.min(100, Math.max(0, ((touch.clientX - rect.left) / rect.width) * 100)));
                }}
              >
                <div className="checker absolute inset-0 opacity-[0.7]" />
                <div className="absolute inset-0">{originalUrl ? <img src={originalUrl} alt="original" className="h-full w-full object-contain" draggable={false} /> : null}</div>
                {cutoutUrl ? (
                  <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - compare}% 0 0)` }}>
                    <div className="checker absolute inset-0" />
                    <img src={cutoutUrl} alt="cutout" className="relative h-full w-full object-contain" draggable={false} />
                  </div>
                ) : null}

                {cutoutUrl ? (
                  <>
                    <div className="absolute bottom-0 top-0 w-px bg-black/10 dark:bg-white/20" style={{ left: `${compare}%` }}>
                      <button
                        aria-label="Drag to compare"
                        onMouseDown={() => setDragging(true)}
                        onTouchStart={() => setDragging(true)}
                        className="absolute top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-full border border-black/10 bg-white shadow-[0_4px_12px_rgba(0,0,0,0.15)] dark:border-white/10 dark:bg-[#1e1e20]"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-black/60 dark:text-white/70">
                          <path d="M8 12h8M12 8v8" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                    <div className="mono absolute left-4 top-4 rounded-full bg-black/70 px-3 py-1 text-[10px] tracking-wide text-white backdrop-blur">ORIGINAL</div>
                    <div className="mono absolute right-4 top-4 rounded-full bg-white px-3 py-1 text-[10px] font-medium tracking-wide text-black">CUTOUT</div>
                  </>
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="mono rounded-full border border-[var(--border)] bg-white/90 px-4 py-2 text-[11px] text-[var(--text-muted)] backdrop-blur dark:bg-black/50">
                      {busy ? "Processing…" : error ? error : "Ready"}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex w-full max-w-[560px] items-center justify-center gap-3">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="rounded-full border border-[var(--border)] bg-[var(--bg-soft)] px-6 py-3 text-[14px] font-[500] tracking-[-0.01em] transition hover:border-[var(--border-strong)]"
              >
                Upload
              </button>
              <button
                onClick={onDownload}
                disabled={!cutoutUrl}
                className="flex items-center gap-2 rounded-full bg-[var(--text)] px-8 py-3 text-[14px] font-[500] tracking-[-0.01em] text-[var(--bg)] transition hover:opacity-[0.9] disabled:cursor-not-allowed disabled:opacity-30"
              >
                <span>Download</span>
                <span className="text-[11px] opacity-60">PNG</span>
              </button>
              <button onClick={onReset} className="mono rounded-full border border-[var(--border)] px-4 py-3 text-[11px] tracking-wide transition hover:border-[var(--border-strong)]">
                New image
              </button>
            </div>

            {sourceSize ? (
              <div className="mono text-[11px] text-[var(--text-faint)]">
                {sourceSize.w} × {sourceSize.h} • {((sourceSize.w * sourceSize.h) / 1e6).toFixed(2)} MP • stays on device
              </div>
            ) : null}

            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={onFileChange} />
          </div>
        )}

        {/* Model / storage info */}
        <div className="mt-8 w-full overflow-hidden rounded-[20px] border border-[var(--border)] bg-[var(--bg-soft)]">
          <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)]/60 px-5 py-3.5">
            <div className="flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--text)] text-[10px] text-[var(--bg)]">M</div>
              <span className="text-[12px] font-[600] tracking-[-0.01em]">Model info</span>
              <StatusPill status={statusKind} className="ml-1">
                {statusLabel}
              </StatusPill>
            </div>
            <span className="mono hidden text-[10px] text-[var(--text-faint)] md:block">{storageLabel} cache • IndexedDB</span>
          </div>
          <div className="grid grid-cols-1 gap-4 p-5 md:grid-cols-2">
            <div className="space-y-3">
              <div>
                <div className="mono text-[9px] uppercase tracking-widest text-[var(--text-faint)]">Model</div>
                <div className="mt-1 text-[13px] font-[500] tracking-[-0.01em]">{MODNET.id}</div>
                <div className="mono text-[10px] text-[var(--text-muted)]">
                  {MODNET.origin} • {MODNET.label}
                </div>
              </div>
              <div className="flex gap-6">
                <div>
                  <div className="mono text-[9px] uppercase tracking-widest text-[var(--text-faint)]">Size</div>
                  <div className="mono mt-1 text-[12px] font-medium">{MODNET.size}</div>
                </div>
                <div>
                  <div className="mono text-[9px] uppercase tracking-widest text-[var(--text-faint)]">Where stored</div>
                  <div className="mono mt-1 text-[11px]">Browser cache</div>
                  <div className="mono text-[10px] text-[var(--text-faint)]">Cache API</div>
                </div>
              </div>
            </div>
            <div className="space-y-3">
              <div className="flex gap-6">
                <div>
                  <div className="mono text-[9px] uppercase tracking-widest text-[var(--text-faint)]">Version</div>
                  <div className="mono mt-1 text-[11px]">{MODNET.version}</div>
                  <div className="mono text-[10px] text-[var(--text-muted)]">{MODNET.quant}</div>
                </div>
                <div>
                  <div className="mono text-[9px] uppercase tracking-widest text-[var(--text-faint)]">Cache usage</div>
                  <div className="mono mt-1 text-[11px]">{storageDetail || storageLabel}</div>
                </div>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] px-5 py-3.5">
            <button
              onClick={async () => {
                await onClearCache();
                loadModel();
              }}
              disabled={cacheBusy}
              className="mono rounded-full border border-[var(--border)] bg-[var(--bg-soft)] px-4 py-2 text-[11px] font-medium transition hover:border-[var(--border-strong)] disabled:opacity-50"
            >
              Redownload model
            </button>
            <button
              onClick={onClearCache}
              disabled={cacheBusy}
              className="mono rounded-full border border-[var(--border)] bg-transparent px-4 py-2 text-[11px] text-[var(--text-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--text)] disabled:opacity-50"
            >
              Clear model cache
            </button>
            {cacheNote ? <span className="mono text-[10px] text-[var(--text-faint)]">{cacheNote}</span> : null}
          </div>
        </div>

        {error && phase === "error" ? (
          <div className="mono mt-6 w-full rounded-full border border-[var(--border)] bg-[var(--bg-soft)] px-4 py-2 text-center text-[11px] text-[var(--text-muted)]">{error}</div>
        ) : null}
      </div>
    </div>
  );
}
